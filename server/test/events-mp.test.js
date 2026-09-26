import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, sleep, FAST, PROTOCOL_VERSION } from './helpers.js';
import { MATCH_EVENTS } from '../../js/events/config.js';
import { fromMultiplayer } from '../../js/profile/results.js';
import { Profile } from '../../js/profile/profile.js';

globalThis.window ??= { devicePixelRatio: 1 };
globalThis.requestAnimationFrame ??= () => 0; // NetGame starts a render loop in beginMatch; there is no display here
globalThis.cancelAnimationFrame ??= () => {};
const { NetGame } = await import('../../js/net/netgame.js');

// Multiplayer match events: decided by the server, synchronised to every client through the snapshot, never
// accepted from a client, never repeated after a reconnect, and summarised in the match result.
const h = harness(FAST);
h.hooks();

// waitFor() consumes messages, so events are collected by a listener of their own.
const watch = (client) => {
  const seen = [];
  client.ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'snap') for (const e of m.ev || []) if (e.e === 'mev') seen.push(e);
  });
  return seen;
};
const only = (seen, k) => seen.filter((e) => !k || e.k === k);

test('every client receives the same server-announced event, once', async () => {
  const { host, guest, hostId } = await h.startedMatch();
  const seen = { host: watch(host), guest: watch(guest) };
  await host.waitFor('snap', (m) => m.tick >= 1);
  h.lobby().match.byId.get(hostId).foodEaten = MATCH_EVENTS.food_hunter.food; // server-side state change
  await sleep(900);
  for (const [name, list] of Object.entries(seen)) {
    const events = only(list, 'food_hunter');
    void name;
    assert.equal(events.length, 1, 'exactly once per client');
    assert.equal(events[0].id, hostId, 'the player involved is identified');
  }
});

test('First Blood is announced with killer and victim to everyone', async () => {
  const { host, guest, hostId, guestId } = await h.startedMatch();
  const seenH = watch(host);
  const seenG = watch(guest);
  await host.waitFor('snap', (m) => m.tick >= 1);
  const sim = h.lobby().match;
  sim._creditKill(sim.byId.get(hostId), sim.byId.get(guestId)); // a real kill path on the server
  await sleep(700);
  const fb = only(seenG, 'first_blood')[0];
  assert.deepEqual({ id: fb.id, v: fb.v }, { id: hostId, v: guestId });
  assert.equal(only(seenH, 'first_blood').length, 1);
});

test('forged event messages from a client are ignored: nothing fires, nobody is told, the connection survives', async () => {
  const { host, guest, hostId } = await h.startedMatch();
  const seenH = watch(host);
  const seenG = watch(guest);
  await host.waitFor('snap', (m) => m.tick >= 1);
  for (const forged of [
    { t: 'event', k: 'first_blood', id: hostId },
    { t: 'mev', k: 'giant_snake', id: hostId },
    { t: 'achievement', k: 'comeback' },
    { t: 'input', seq: 1, dir: 'up', event: 'first_blood', events: [{ k: 'survivor', id: hostId }], mev: 1 },
    { t: 'chat', m: 'First Blood!', k: 'first_blood' },
    { t: 'sync', events: [{ k: 'comeback', id: hostId }] },
  ]) host.send(forged);
  await sleep(600);
  const sim = h.lobby().match;
  assert.equal(sim.matchEvents.summary().length, 0, 'the server recorded nothing');
  assert.equal(seenH.length + seenG.length, 0, 'no client was told about an event');
  assert.equal(host.closed, false);
});

test('reconnect: the rejoining client is told what already fired (so it never re-announces), and the server never repeats it', async () => {
  const { host, guest, hostId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  const sim = h.lobby().match;
  const seenG = watch(guest);
  sim.byId.get(hostId).foodEaten = MATCH_EVENTS.food_hunter.food;
  await sleep(700);
  assert.equal(only(seenG, 'food_hunter').length, 1, 'announced to the other player before the disconnect');
  const { token } = host.joined.you;
  host.ws.terminate();
  await guest.waitFor('lobby', (m) => m.lobby.players.some((p) => p.id === hostId && !p.connected));
  const back = await h.connect('Alice again');
  back.send({ t: 'rejoin', v: PROTOCOL_VERSION, lobby: 'lobby-1', id: hostId, token });
  const resumed = await back.waitFor('match');
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.events.map((e) => `${e.k}:${e.id}`), [`food_hunter:${hostId}`], 'the recap lists what already fired');
  assert.equal(resumed.snap.ev.length, 0, 'the full snapshot replays no events');
  const seenBack = watch(back);
  await back.waitFor('snap', (m) => m.tick > resumed.snap.tick + 3);
  await sleep(300);
  assert.equal(only(seenBack, 'food_hunter').length, 0, 'the server does not re-announce it after the reconnect');
  assert.equal(sim.matchEvents.summary().filter((e) => e.k === 'food_hunter').length, 1);

  // The client side: a NetGame that was handed the recap ignores a repeated event and still shows a new one.
  const game = new NetGame({ width: 0, height: 0, getContext: () => ({ scale() {} }) }, { update() {} });
  const shown = [];
  game.onMatchEvent = (e) => shown.push(`${e.k}:${e.id}`);
  game.beginMatch(resumed);
  game._handleEvents([{ e: 'mev', k: 'food_hunter', id: hostId }]);
  assert.deepEqual(shown, [], 'already-fired event: not announced again');
  game._handleEvents([{ e: 'mev', k: 'giant_snake', id: hostId }, { e: 'mev', k: 'giant_snake', id: hostId }]);
  assert.deepEqual(shown, [`giant_snake:${hostId}`], 'a new event is announced once');
});

test('a snapshot delivered twice does not announce an event twice on the client', async () => {
  const { host, hostId } = await h.startedMatch();
  const m = host.latest('match') || null;
  void m;
  const game = new NetGame({ width: 0, height: 0, getContext: () => ({ scale() {} }) }, { update() {} });
  const shown = [];
  game.onMatchEvent = (e) => shown.push(e.k);
  const first = await host.waitFor('snap', (s) => s.tick >= 1);
  game.views = new Map([[hostId, { id: hostId }]]);
  game._handleEvents([{ e: 'mev', k: 'survivor', id: hostId }]);
  game._handleEvents([{ e: 'mev', k: 'survivor', id: hostId }]);
  assert.deepEqual(shown, ['survivor']);
  void first;
});

test('match end: the authoritative event summary is part of the results, and progression from it is recorded once', async () => {
  const { host, guest, hostId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  const sim = h.lobby().match;
  const a = sim.byId.get(hostId);
  a.body = Array.from({ length: 16 }, (_, i) => ({ x: 20 - i, y: 30 })); // long enough for Longest Snake
  a.direction = a.pendingDirection = { x: 1, y: 0 }; // heading away from its own body (the spawn heading is random)
  a.inputBuffer = [];
  a.foodEaten = 6;
  guest.send({ t: 'leave' });
  const over = await host.waitFor('over');
  const ids = over.events.map((e) => `${e.k}:${e.id}`);
  assert.ok(ids.includes(`longest_snake:${hostId}`), ids.join(','));
  assert.ok(ids.includes(`most_food:${hostId}`), ids.join(',') + ' | food ' + JSON.stringify([...sim.byId.values()].map((s) => [s.foodEaten, s.alive, s.length])));
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');

  const profile = new Profile({ storage: { getItem: () => null, setItem() {} }, now: () => 1, schedule: () => 1, cancel: () => {} });
  const res = fromMultiplayer(over, hostId, 'mp-1', 60);
  assert.ok(res.events.includes('longest_snake') && res.events.includes('most_food'));
  assert.ok(profile.applyMatchResult(res));
  const earned = profile.stats.eventsEarned;
  assert.equal(earned, res.events.length);
  assert.equal(profile.applyMatchResult(res), null, 'a replayed result records nothing');
  assert.equal(profile.stats.eventsEarned, earned);
});

test('the client cannot claim an event through the results either: it only ever consumes the server list', async () => {
  const { host, guest, hostId, guestId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  host.send({ t: 'over', events: [{ k: 'first_blood', id: hostId }], results: [] });
  guest.send({ t: 'leave' });
  const over = await host.waitFor('over');
  assert.equal(over.events.some((e) => e.k === 'first_blood'), false, 'a forged over message did not change the server\'s summary');
  void guestId;
});
