import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, sleep, FAST, PROTOCOL_VERSION } from './helpers.js';
import { CONFIG } from '../../js/config.js';
import { MatchSim } from '../match.js';
import { LocalPredictor, predictorState } from '../../js/net/predict.js';
import { SnapTracker } from '../../js/net/snapcodec.js';
import { collectSpecial } from '../../js/powerups/effects.js';
import { POWERUPS } from '../../js/powerups/config.js';

// Magnet and Shield vs the client predictor. The server stays authoritative; the predictor does NOT
// simulate the Magnet's food pull (a second, fragile simulation). These tests pin down what that means:
// heads and body cells are always exact, and the only disagreement is the tail length while a pulled
// food's growth is still in flight - never over-predicted, at most one segment, healed by the next snapshot.
const ENTRIES = [{ id: 'a', name: 'A', skinId: 'classic' }, { id: 'b', name: 'B', skinId: 'inferno' }];
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const wire = (o) => JSON.parse(JSON.stringify(o));

function magnetField(seed) {
  const r = mulberry32(seed);
  const sim = new MatchSim(ENTRIES, { rng: r });
  sim.food.items.clear();
  sim.food.target = 0;
  sim.specials.clear();
  sim.specials.cooldown = 1e9;
  const a = sim.byId.get('a');
  a.body = Array.from({ length: 7 }, (_, i) => ({ x: 15 - i, y: 30 }));
  a.direction = a.pendingDirection = CONFIG.DIRECTIONS.right;
  a.inputBuffer = [];
  a.growPending = 0;
  const b = sim.byId.get('b');
  b.body = Array.from({ length: 5 }, (_, i) => ({ x: 5 - i, y: 5 }));
  sim.setFrozen('b', true);
  for (let i = 0; i < 24; i++) {
    const x = 20 + Math.floor(r() * 30);
    const y = 24 + Math.floor(r() * 13);
    sim.food.items.set(`${x},${y}`, { x, y });
  }
  collectSpecial(a, 'magnet');
  sim._commitBaseline();
  return { sim, a };
}

function predictFrom(snap, tracker, ticksAhead) {
  const me = snap.snakes.find((s) => s.id === 'a');
  const pred = new LocalPredictor();
  pred.active = true;
  pred.baseTick = snap.tick;
  pred.base = predictorState(snap, me, tracker.bodies.get('a'));
  pred.food = tracker.food;
  pred.rebuild(0);
  for (let i = 1; i <= ticksAhead; i++) pred._step(snap.tick + i);
  return pred;
}

test('magnet vs prediction: the local head and every shared body cell are exact; growth is never over-predicted', () => {
  let samples = 0;
  let headMismatch = 0;
  let over = 0;
  let maxLenGap = 0;
  let cellDiff = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const { sim, a } = magnetField(seed);
    const hist = [];
    for (let t = 0; t < 40; t++) {
      sim.tick();
      hist.push({ full: wire(sim.snapshot({ full: true })), cells: a.body.map((c) => ({ x: c.x, y: c.y })) });
    }
    for (let t = 0; t + 2 < hist.length; t++) {
      const tracker = new SnapTracker();
      tracker.apply(hist[t].full);
      const pred = predictFrom(hist[t].full, tracker, 2); // the usual ~2-tick lead
      const truth = hist[t + 2].cells;
      const pc = pred.curCells;
      samples++;
      if (pc[0].x !== truth[0].x || pc[0].y !== truth[0].y) headMismatch++;
      const gap = pc.length - truth.length;
      if (gap > 0) over++;
      maxLenGap = Math.max(maxLenGap, Math.abs(gap));
      for (let i = 0; i < Math.min(pc.length, truth.length); i++) cellDiff = Math.max(cellDiff, Math.abs(pc[i].x - truth[i].x) + Math.abs(pc[i].y - truth[i].y));
    }
  }
  assert.ok(samples > 900);
  assert.equal(headMismatch, 0, 'head: no mismatch');
  assert.equal(cellDiff, 0, 'body cells identical');
  assert.equal(over, 0, 'the client never grows a segment the server did not');
  assert.ok(maxLenGap <= 1, `at most one tail segment of disagreement (${maxLenGap})`);
});

test('magnet pickup and growth on the server: each pulled food pays once and grows exactly one segment', () => {
  const { sim, a } = magnetField(7);
  const len0 = a.length;
  const score0 = a.score;
  let eatEvents = 0;
  for (let t = 0; t < 60; t++) {
    sim.tick();
    eatEvents += sim.events.filter((e) => e.e === 'eat' && e.id === 'a').length;
  }
  assert.ok(a.foodEaten >= 3, `the magnet collected food (${a.foodEaten})`);
  assert.equal(a.foodEaten, eatEvents, 'one event per collected food, no duplicates');
  assert.equal(a.score - score0, a.foodEaten * CONFIG.FOOD_SCORE);
  assert.equal(a.length + a.growPending, len0 + a.foodEaten, 'growth is exactly one segment per food');
});

test('snapshot reconciliation: the predictor rebuilt from the next snapshot has the authoritative length again', () => {
  const { sim, a } = magnetField(3);
  let healed = 0;
  let disagreed = 0; // (informational: how often the 2-tick-ahead length differed)
  const hist = [];
  for (let t = 0; t < 40; t++) {
    sim.tick();
    hist.push(wire(sim.snapshot({ full: true })));
  }
  for (let t = 0; t + 2 < hist.length; t++) {
    const tr = new SnapTracker();
    tr.apply(hist[t]);
    const early = predictFrom(hist[t], tr, 2);
    const tr2 = new SnapTracker();
    tr2.apply(hist[t + 2]);
    const fresh = predictFrom(hist[t + 2], tr2, 0);
    const truthLen = tr2.bodies.get('a').length / 2;
    if (early.curCells.length !== truthLen) disagreed++;
    if (fresh.curCells.length === truthLen) healed++;
  }
  assert.equal(healed, hist.length - 2, 'every authoritative snapshot restores the exact length');
  void a;
});

test('shield at a wall: the predictor already holds still exactly like the server (no correction needed)', () => {
  const sim = new MatchSim(ENTRIES, { rng: mulberry32(1) });
  sim.food.items.clear();
  sim.food.target = 0;
  sim.specials.clear();
  sim.specials.cooldown = 1e9;
  const a = sim.byId.get('a');
  a.body = Array.from({ length: 7 }, (_, i) => ({ x: CONFIG.GRID_COLS - 1 - i, y: 30 }));
  a.direction = a.pendingDirection = CONFIG.DIRECTIONS.right;
  a.inputBuffer = [];
  const b = sim.byId.get('b');
  b.body = Array.from({ length: 5 }, (_, i) => ({ x: 5 - i, y: 5 }));
  sim.setFrozen('b', true);
  collectSpecial(a, 'shield');
  sim._commitBaseline();
  for (let t = 0; t < 3; t++) {
    const snap = wire(sim.snapshot({ full: true }));
    const tr = new SnapTracker();
    tr.apply(snap);
    const pred = predictFrom(snap, tr, 1);
    sim.tick();
    if (a.alive) assert.deepEqual({ x: pred.curCells[0].x, y: pred.curCells[0].y }, { x: a.head.x, y: a.head.y }, `tick ${sim.tickCount}: predicted head = server head while the shield holds`);
  }
  assert.equal(a.alive, false, 'and the shield really was one hit (control)');
});

// ---- reconnect while the Magnet is active ---------------------------------------------------------------------

const h = harness(FAST);
h.hooks();

test('reconnect while Magnet is active: same timer, food still there once, and the pull keeps working afterwards', async () => {
  const { host, guest, hostId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  const sim = h.lobby().match;
  const snake = sim.byId.get(hostId);
  sim.specials.cooldown = 1e9;
  collectSpecial(snake, 'magnet');
  sim.food.items.clear();
  sim.food.target = 0;
  const { token } = host.joined.you;
  host.ws.terminate();
  await guest.waitFor('lobby', (m) => m.lobby.players.some((p) => p.id === hostId && !p.connected));
  const back = await h.connect('Alice again');
  back.send({ t: 'rejoin', v: PROTOCOL_VERSION, lobby: 'lobby-1', id: hostId, token });
  const resumed = await back.waitFor('match');
  const me = resumed.snap.snakes.find((s) => s.id === hostId);
  assert.ok(me.e && me.e[1] > 0 && me.e[1] <= POWERUPS.magnet.durationTicks, 'magnet timer restored from the full snapshot');
  assert.equal(h.lobby().count, 2, 'no duplicate player');
  await guest.waitFor('snap', (m) => m.snakes.find((s) => s.id === hostId).fz === 0);

  // the rejoined snake is live again: put food in its pull radius; it must be collected once
  await sleep(100);
  const s2 = sim.byId.get(hostId);
  s2.magnetTicksLeft = POWERUPS.magnet.durationTicks;
  const hx = s2.head.x + s2.direction.x * 4;
  const hy = s2.head.y + s2.direction.y * 4;
  sim.food.items.set(`${hx},${hy}`, { x: hx, y: hy });
  const score0 = s2.score;
  const eaten0 = s2.foodEaten;
  await sleep(900);
  assert.equal(sim.food.has(hx, hy), false, 'the food is gone (collected)');
  assert.equal(s2.foodEaten, eaten0 + 1, 'collected exactly once');
  assert.equal(s2.score, score0 + CONFIG.FOOD_SCORE);
});
