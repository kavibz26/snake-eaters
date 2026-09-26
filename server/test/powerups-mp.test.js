import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, sleep, FAST, PROTOCOL_VERSION } from './helpers.js';
import { CONFIG } from '../../js/config.js';
import { MatchSim } from '../match.js';
import { SnapTracker } from '../../js/net/snapcodec.js';
import { collectSpecial } from '../../js/powerups/effects.js';
import { POWERUPS, POWERUP_INDEX } from '../../js/powerups/config.js';
import { fromMultiplayer } from '../../js/profile/results.js';
import { Profile } from '../../js/profile/profile.js';

// Multiplayer power-ups: the SERVER owns spawning, pickup, timers, shield decisions and Mega Food score.
// Clients only receive state and events.
const h = harness(FAST);
h.hooks();

const ENTRIES = [{ id: 'a', name: 'A', skinId: 'classic' }, { id: 'b', name: 'B', skinId: 'inferno' }];
function quietSim() {
  const sim = new MatchSim(ENTRIES);
  sim.food.items.clear();
  sim.food.target = 0;
  sim.specials.clear();
  sim.specials.cooldown = 1e9;
  const put = (id, head, dirName, length) => {
    const s = sim.byId.get(id);
    const dir = CONFIG.DIRECTIONS[dirName];
    s.body = Array.from({ length }, (_, i) => ({ x: head.x - dir.x * i, y: head.y - dir.y * i }));
    s.direction = s.pendingDirection = dir;
    s.inputBuffer = [];
    s.growPending = 0;
  };
  put('a', { x: 20, y: 30 }, 'right', 7);
  put('b', { x: 5, y: 5 }, 'right', 5);
  sim.setFrozen('b', true);
  sim._commitBaseline();
  return sim;
}
const wire = (snap) => JSON.parse(JSON.stringify(snap));

test('protocol version is 4 and the server reports it', async () => {
  assert.equal(PROTOCOL_VERSION, 4);
  const c = await h.connect('Old');
  c.send({ t: 'lobbies', v: 3 });
  const err = await c.waitFor('error');
  assert.equal(err.code, 'bad_version', 'a stale v3 client is told to refresh');
  assert.equal(err.sv, 4);
});

test('state sync: items appear and disappear through delta snapshots, and the client tracker mirrors the server exactly', () => {
  const sim = quietSim();
  const tracker = new SnapTracker();
  tracker.apply(wire(sim.snapshot({ full: true })));
  assert.equal(tracker.specials.size, 0);

  sim.specials.items.set('40,40', { x: 40, y: 40, type: 'shield', born: 0 });
  sim.specials.items.set('50,20', { x: 50, y: 20, type: 'mega', born: 0 });
  const add = wire(sim.snapshot());
  assert.deepEqual(add.spa, [40, 40, POWERUP_INDEX.shield, 50, 20, POWERUP_INDEX.mega]);
  tracker.apply(add);
  assert.deepEqual([...tracker.specials.values()].map((i) => `${i.x},${i.y},${i.type}`).sort(), ['40,40,shield', '50,20,mega']);
  assert.equal(wire(sim.snapshot()).spa, undefined, 'nothing to say when nothing changed');

  sim.specials.take(40, 40);
  const rem = wire(sim.snapshot());
  assert.deepEqual(rem.spr, [40, 40]);
  tracker.apply(rem);
  assert.deepEqual([...tracker.specials.keys()], ['50,20']);

  // a full snapshot (rejoin / resync) rebuilds the same picture from scratch
  const fresh = new SnapTracker();
  fresh.apply(wire(sim.snapshot({ full: true })));
  assert.deepEqual([...fresh.specials.entries()], [...tracker.specials.entries()]);
});

test('pickup is decided by the server: the snake that reaches the cell gets the effect, the event and the score', () => {
  const sim = quietSim();
  sim.specials.items.set('21,30', { x: 21, y: 30, type: 'speed', born: 0 });
  sim.specials.items.set('22,30', { x: 22, y: 30, type: 'mega', born: 0 });
  sim.tick();
  const a = sim.byId.get('a');
  assert.equal(a.speedTicksLeft, POWERUPS.speed.durationTicks - 0);
  assert.deepEqual(sim.events.filter((e) => e.e === 'pu'), [{ e: 'pu', id: 'a', k: 'speed', x: 21, y: 30 }]);
  sim.tick();
  assert.equal(a.score, POWERUPS.mega.score);
  const snap = wire(sim.snapshot()).snakes.find((s) => s.id === 'a');
  assert.equal(snap.sc, POWERUPS.mega.score, 'the score in the snapshot is the server\'s');
  assert.ok(Array.isArray(snap.e) && snap.e[0] > 0, 'the active timer is in the snapshot');
});

test('a shield block is broadcast as an event and the timer disappears from the snapshot', () => {
  const sim = quietSim();
  const a = sim.byId.get('a');
  a.body = Array.from({ length: 7 }, (_, i) => ({ x: CONFIG.GRID_COLS - 1 - i, y: 30 }));
  collectSpecial(a, 'shield');
  sim.tick();
  const snap = wire(sim.snapshot());
  assert.deepEqual(snap.ev.filter((e) => e.e === 'shield'), [{ e: 'shield', id: 'a', x: CONFIG.GRID_COLS - 1, y: 30 }]);
  assert.equal(snap.snakes.find((s) => s.id === 'a').e, undefined);
  assert.equal(snap.snakes.find((s) => s.id === 'a').a, 1, 'still alive');
});

test('forged messages: a client cannot grant itself power-ups, effects, score or shield', async () => {
  const { host, hostId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  for (const forged of [
    { t: 'powerup', type: 'shield' },
    { t: 'pickup', k: 'mega', x: 1, y: 1 },
    { t: 'effect', speed: 999, magnet: 999, shield: 999 },
    { t: 'input', seq: 1, dir: 'up', shield: true, speed: 99, powerup: 'mega', score: 99999, e: [99, 99, 99] },
    { t: 'input', seq: 2, boost: true, shieldTicksLeft: 500 },
    { t: 'sync', e: [99, 99, 99], sp: [1, 1, 3] },
  ]) host.send(forged);
  await sleep(600);
  const snaps = host.all('snap');
  assert.ok(snaps.length > 2);
  for (const s of snaps) {
    const me = s.snakes.find((x) => x.id === hostId);
    assert.equal(me.e, undefined, 'no effect was granted');
    assert.equal(me.sc, 0, 'no score was granted');
  }
  const sim = h.lobby().match;
  const snake = sim.byId.get(hostId);
  assert.equal(snake.shieldTicksLeft + snake.speedTicksLeft + snake.magnetTicksLeft, 0);
  assert.equal(snake.powerupsCollected + snake.megaCollected, 0);
  assert.equal(host.closed, false);
});

test('only the server places items: a client cannot make an item appear', async () => {
  const { host, guest } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  const sim = h.lobby().match;
  const before = sim.specials.count;
  guest.send({ t: 'spawn', type: 'mega', x: 10, y: 10 });
  guest.send({ t: 'sp', spa: [10, 10, 3] });
  await sleep(400);
  assert.equal(sim.specials.has(10, 10), false);
  assert.equal(sim.specials.count, before);
});

test('reconnect: the rejoined player gets a full snapshot with the same items and their own timers, once', async () => {
  const { host, guest, hostId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  const sim = h.lobby().match;
  sim.specials.cooldown = 1e9;
  sim.specials.items.set('60,40', { x: 60, y: 40, type: 'magnet', born: sim.tickCount });
  collectSpecial(sim.byId.get(hostId), 'shield');
  const { token } = host.joined.you;
  host.ws.terminate();
  await guest.waitFor('lobby', (m) => m.lobby.players.some((p) => p.id === hostId && !p.connected));
  const back = await h.connect('Alice again');
  back.send({ t: 'rejoin', v: PROTOCOL_VERSION, lobby: 'lobby-1', id: hostId, token });
  const resumed = await back.waitFor('match');
  assert.equal(resumed.resumed, true);
  const snap = resumed.snap;
  assert.equal(snap.full, 1);
  assert.deepEqual(snap.sp.slice(0, 3), [60, 40, POWERUP_INDEX.magnet], 'the item on the board is in the full snapshot');
  const me = snap.snakes.find((s) => s.id === hostId);
  assert.ok(me.e && me.e[2] > 0, 'own shield timer survived the reconnect');
  assert.equal(h.lobby().count, 2, 'no duplicate player');
  assert.equal(sim.byId.get(hostId).powerupsCollected, 1, 'the shield pickup was counted once, not per reconnect');
  const tracker = new SnapTracker();
  tracker.apply(snap);
  assert.equal(tracker.specials.get('60,40').type, 'magnet');
});

test('results carry the server\'s pickup counters, and progression from them is paid once', async () => {
  const { host, guest, hostId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  const snake = h.lobby().match.byId.get(hostId);
  snake.powerupsCollected = 2;
  snake.megaCollected = 3;
  snake.score += 3 * POWERUPS.mega.score;
  guest.send({ t: 'leave' });
  const over = await host.waitFor('over');
  const me = over.results.find((r) => r.id === hostId);
  assert.equal(me.powerups, 2);
  assert.equal(me.mega, 3);
  const profile = new Profile({ storage: { getItem: () => null, setItem() {} }, now: () => 1, schedule: () => 1, cancel: () => {} });
  const result = fromMultiplayer(over, hostId, 'mp-1', 60);
  assert.equal(result.food, 0, 'mega score is not turned into food XP');
  assert.ok(profile.applyMatchResult(result));
  assert.equal(profile.stats.megaFoodCollected, 3);
  assert.equal(profile.stats.powerupsCollected, 2);
  assert.equal(profile.applyMatchResult(result), null);
  assert.equal(profile.stats.megaFoodCollected, 3, 'not paid twice');
});
