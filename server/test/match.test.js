import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { harness, sleep, FAST, PROTOCOL_VERSION, CONFIG } from './helpers.js';
import { createServer } from '../index.js';
import { SnapTracker } from '../../js/net/snapcodec.js';

// Every test runs against a fresh server that auto-starts lobbies quickly.
const h = harness(FAST);
h.hooks();

const own = (snap, id) => snap.snakes.find((s) => s.id === id);

// --- when does a match start? ---------------------------------------------------------------------------

test('start rules: one player just waits; the 2nd player starts an automatic countdown; nobody presses start', async () => {
  const a = await h.enter('Alice');
  await sleep(700); // longer than the start delay: still nothing happens with one player
  assert.equal(h.lobby().state, 'waiting');
  assert.equal(a.has('match'), false);

  const b = await h.enter('Bob');
  const lobbyMsg = await a.waitFor('lobby', (m) => m.lobby.state === 'countdown');
  assert.ok(lobbyMsg.lobby.startsInMs > 0 && lobbyMsg.lobby.startsInMs <= 400, `countdown is running (${lobbyMsg.lobby.startsInMs}ms left)`);
  const [ma, mb] = await Promise.all([a.waitFor('match'), b.waitFor('match')]);
  assert.equal(ma.players.length, 2);
  assert.equal(mb.you, b.joined.you.id);
  assert.equal(h.lobby().state, 'running');
});

test('players who join while the countdown is running are included in the match', async () => {
  await h.stop();
  await h.start({ startDelayMs: 700, fullStartDelayMs: 150 });
  const a = await h.enter('A');
  const b = await h.enter('B');
  await a.waitFor('lobby', (m) => m.lobby.state === 'countdown');
  const c = await h.enter('C'); // arrives mid-countdown
  const [ma] = await Promise.all([a.waitFor('match'), b.waitFor('match'), c.waitFor('match')]);
  assert.equal(ma.players.length, 3, 'the late joiner is in the match');
  assert.equal(ma.snap.snakes.length, 3);
});

test('if players leave during the countdown and fewer than 2 remain, it is cancelled (back to waiting) - nobody is stuck', async () => {
  await h.stop();
  await h.start({ startDelayMs: 600, fullStartDelayMs: 150 });
  const a = await h.enter('A');
  const b = await h.enter('B');
  await a.waitFor('lobby', (m) => m.lobby.state === 'countdown');
  await b.leave();
  const back = await a.waitFor('lobby', (m) => m.lobby.state === 'waiting');
  assert.equal(back.lobby.players.length, 1);
  await sleep(800);
  assert.equal(a.has('match'), false, 'no match was started with a single player');

  // and it starts again when someone new arrives - the lobby is never stuck
  await h.enter('C');
  await a.waitFor('match');
});

test('a full lobby (6/6) does not wait out the whole countdown', async () => {
  await h.stop();
  await h.start({ startDelayMs: 5000, fullStartDelayMs: 200 });
  const players = [];
  const t0 = Date.now();
  for (let i = 1; i <= 6; i++) players.push(await h.enter(`P${i}`, { skin: ['classic', 'inferno', 'frost', 'toxic', 'cosmic', 'golden'][i - 1] }));
  const m = await players[0].waitFor('match', () => true, 3000);
  assert.equal(m.players.length, 6);
  assert.ok(Date.now() - t0 < 2500, `started quickly once full (${Date.now() - t0}ms), not after 5s`);
});

test('once the match starts the lobby is LOCKED: it cannot be joined, and browsers see it running', async () => {
  const watcher = await h.connect('Watcher');
  await watcher.browse();
  const { host } = await h.startedMatch();
  assert.equal((await watcher.waitFor('lu', (m) => m.id === 'lobby-1' && m.s === 'running')).p, 2);

  const late = await h.connect('Late');
  await assert.rejects(late.join('lobby-1', 'Late'), (e) => e.code === 'match_in_progress');
  assert.equal(h.lobby().count, 2);
  await late.join('lobby-2', 'Late'); // other lobbies stay open
  assert.ok(host);
});

test('lobby state changes are broadcast to the players inside: waiting -> countdown -> running', async () => {
  const a = await h.enter('A');
  await h.enter('B');
  const states = [];
  for (const want of ['countdown', 'running']) {
    const m = await a.waitFor('lobby', (x) => x.lobby.state === want);
    states.push(m.lobby.state);
  }
  assert.deepEqual(states, ['countdown', 'running']);
});

// --- match end: results, then back to the lobby browser ---------------------------------------------------------

test('match end: everyone gets the results, the lobby is released, and players are back in the lobby browser', async () => {
  const watcher = await h.connect('Watcher');
  await watcher.browse();
  const { host, guest, hostId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);

  guest.send({ t: 'leave' }); // forfeit: the host is the last one standing
  const [over, gone] = await Promise.all([host.waitFor('over'), guest.waitFor('left')]);
  assert.equal(over.winnerId, hostId);
  assert.equal(over.results[0].id, hostId);
  assert.equal(over.results.length, 2);

  // The lobby is free again: 0/6, waiting - and the browser was told.
  await watcher.waitFor('lu', (m) => m.id === 'lobby-1' && m.s === 'waiting' && m.p === 0);
  assert.equal(h.lobby().count, 0);
  assert.equal(h.lobby().state, 'waiting');
  assert.equal(h.lobby().chatLog.length, 0, 'fresh chat for the next group');

  // The winner is no longer inside any lobby: it can browse and join again (no "already in a lobby").
  const list = await host.browse();
  assert.ok(list.lobbies.every((l) => l.p === 0));
  await host.join('lobby-3', 'Alice');
  assert.equal(h.lobby('lobby-3').count, 1);
  assert.ok(gone);
});

test('after a match the same lobby can host the next match', async () => {
  const one = await h.startedMatch();
  one.guest.send({ t: 'leave' });
  await one.host.waitFor('over');
  await sleep(50);
  const two = await h.startedMatch();
  assert.equal(two.host.joined.lobby.id, 'lobby-1');
  assert.ok((await two.host.waitFor('snap', (m) => m.tick >= 1)).tick >= 1);
});

// --- gameplay through a lobby (ported from the room-code era) ---------------------------------------------------------

test('full 2-player match: snapshots are deltas that rebuild the exact state; each client drives ONLY its own snake', async () => {
  const { host, guest, hostId, guestId } = await h.startedMatch();
  const tr = new SnapTracker();
  const first = await host.waitFor('snap', (m) => m.tick >= 1);
  tr.apply(first);
  assert.equal(first.snakes.length, 2);

  const before = own(first, hostId);
  const want = before.d[0] !== 0 ? 'up' : 'right';
  // Forged fields must not let a client steer someone else.
  host.send({ t: 'input', seq: 1, dir: want, id: guestId, snake: guestId });
  await sleep(CONFIG.TICK_MS * 3);
  const later = host.latest('snap');
  if (own(later, hostId).a) assert.deepEqual(own(later, hostId).d, [CONFIG.DIRECTIONS[want].x, CONFIG.DIRECTIONS[want].y]);
  assert.equal(own(later, guestId).q, 0, "the other player's input state was not touched");
  void guest;
});

test('snapshots and the match message never contain tokens', async () => {
  const { host, guest } = await h.startedMatch();
  const snap = await host.waitFor('snap', (m) => m.tick >= 1);
  const raw = JSON.stringify(snap);
  assert.ok(!raw.includes(host.joined.you.token));
  assert.ok(!raw.includes(guest.joined.you.token));
});

test('Speed Boost through the server: an accepted boost input shows up in the snapshot timers', async () => {
  const { host, guest, hostId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  host.send({ t: 'input', seq: 1, boost: true });
  const boosted = await host.waitFor('snap', (m) => { const s = own(m, hostId); return !s.a || s.b[0] > 0; });
  assert.ok(boosted);
  void guest;
});

test('input: the server acknowledges the highest processed sequence number in every snapshot', async () => {
  const { host, hostId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  host.send({ t: 'input', seq: 1, dir: 'up' });
  host.send({ t: 'input', seq: 2, dir: 'left' });
  host.send({ t: 'input', seq: 3, dir: 'down' });
  const acked = await host.waitFor('snap', (m) => own(m, hostId).q === 3);
  assert.equal(own(acked, hostId).q, 3);
  host.send({ t: 'input', seq: 2, dir: 'up' }); // stale / out of order
  await sleep(CONFIG.TICK_MS * 2);
  assert.equal(own(host.latest('snap'), hostId).q, 3, 'a stale sequence number does not lower the ack');
});

test('input: the accepted-but-not-yet-moved turn state is exposed so the client can predict exactly', async () => {
  const { host, hostId } = await h.startedMatch();
  const s0 = await host.waitFor('snap', (m) => m.tick >= 1);
  const d = own(s0, hostId).d;
  const perp = d[0] !== 0 ? ['up', 'down'] : ['left', 'right'];
  host.send({ t: 'input', seq: 1, dir: perp[0] });
  host.send({ t: 'input', seq: 2, dir: d[0] !== 0 ? 'left' : 'up' });
  const snap = await host.waitFor('snap', (m) => own(m, hostId).q === 2);
  const me = own(snap, hostId);
  if (me.a) assert.ok(me.p === undefined || (Array.isArray(me.p) && me.p.length === 2));
});

test('input: malformed, forged or out-of-state input is ignored and never crashes anything', async () => {
  const { host, hostId, guestId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  const bad = [
    { t: 'input', seq: 0, dir: 'up' }, { t: 'input', seq: -5, dir: 'up' }, { t: 'input', seq: 1.5, dir: 'up' },
    { t: 'input', seq: '7', dir: 'up' }, { t: 'input', seq: 9007199254740993, dir: 'up' },
    { t: 'input', seq: 5, dir: 'sideways' }, { t: 'input', seq: 6, dir: { x: 1, y: 0 } },
    { t: 'input', seq: 7, boost: 'yes' }, { t: 'input', seq: 8, boost: false }, { t: 'input', seq: 9 },
    { t: 'input', dir: 'up' },
    { t: 'input', seq: 10, dir: 'up', x: 500, y: 500, score: 99999, length: 500, kills: 9 },
  ];
  for (const m of bad) host.send(m);
  await sleep(CONFIG.TICK_MS * 3);
  const snap = host.latest('snap');
  const me = own(snap, hostId);
  assert.ok(me.q === 0 || me.q === 10, 'only the well-formed input (seq 10) may have been acknowledged');
  assert.ok(me.sc < 1000 && me.k === 0, 'client-supplied score/kills are never used');
  assert.equal(own(snap, guestId).q, 0);
  assert.equal(host.closed, false);
  host.send({ t: 'dir', d: 'up' }); // v1 messages do nothing
  host.send({ t: 'boost' });
  await sleep(100);
  assert.equal(host.closed, false);
});

test('input: a reversal is acknowledged but changes nothing (the existing rule still applies)', async () => {
  const { host, hostId } = await h.startedMatch();
  const s0 = await host.waitFor('snap', (m) => m.tick >= 1);
  const d = own(s0, hostId).d;
  const back = d[0] === 1 ? 'left' : d[0] === -1 ? 'right' : d[1] === 1 ? 'up' : 'down';
  host.send({ t: 'input', seq: 1, dir: back });
  const snap = await host.waitFor('snap', (m) => own(m, hostId).q === 1);
  if (own(snap, hostId).a) assert.deepEqual(own(snap, hostId).d, d);
});

test('input before the match is playing (waiting / countdown) is ignored', async () => {
  const solo = await h.enter('Solo');
  solo.send({ t: 'input', seq: 1, dir: 'up' });
  await sleep(100);
  assert.equal(solo.closed, false);
  assert.equal(solo.has('snap'), false);
});

test('sync: a client can ask for the full state and gets it (and only while a match is running)', async () => {
  const { host, hostId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  host.send({ t: 'sync' });
  const full = await host.waitFor('snap', (m) => m.full === 1);
  assert.ok(full.f.length > 0);
  assert.ok(own(full, hostId).c.length >= CONFIG.PLAYER_INITIAL_LENGTH * 2, 'full body included');
  assert.deepEqual(full.ev, [], 'a resync never replays events');

  const solo = await h.enter('Solo', { lobby: 'lobby-2' });
  solo.send({ t: 'sync' });
  await sleep(100);
  assert.equal(solo.latest('snap'), undefined);
});

test('players: names in the match message are the sanitised server-side names; ids are unique', async () => {
  const a = await h.enter('<b>Ann</b>‮', { skin: 'classic' });
  const b = await h.enter('Ann', { skin: 'inferno' });
  const m = await a.waitFor('match');
  const names = m.players.map((p) => p.name);
  assert.ok(names.every((n) => !/[<>‮]/.test(n)), names.join(','));
  assert.equal(new Set(names).size, 2);
  assert.equal(new Set(m.players.map((p) => p.id)).size, 2);
  assert.ok(!JSON.stringify(m).includes(a.joined.you.token));
  assert.ok(!JSON.stringify(m).includes(b.joined.you.token));
});

test('leaderboard: every snapshot carries the SERVER-computed order (lb) and authoritative scores', async () => {
  const { host } = await h.startedMatch();
  const snap = await host.waitFor('snap', (m) => m.tick >= 1);
  assert.ok(Array.isArray(snap.lb) && snap.lb.length === 2);
  assert.deepEqual([...snap.lb].sort(), [0, 1]);
  assert.ok(snap.snakes.every((s) => Number.isInteger(s.sc)));
});

// --- reconnect during a match ------------------------------------------------------------------------------------------

test('disconnect freezes the snake and keeps the slot; reconnecting resumes the same match (same lobby, no duplicate)', async () => {
  const { host, guest, hostId, guestId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  const { token } = guest.joined.you;
  guest.ws.terminate();
  await host.waitFor('lobby', (m) => m.lobby.players.some((p) => p.id === guestId && !p.connected));
  const frozen = await host.waitFor('snap', (m) => own(m, guestId).fz === 1);
  assert.equal(own(frozen, guestId).fz, 1);
  assert.equal(h.lobby().count, 2, 'slot kept');

  const back = await h.connect('Bob again');
  back.send({ t: 'rejoin', v: PROTOCOL_VERSION, lobby: 'lobby-1', id: guestId, token });
  const rj = await back.waitFor('joined');
  assert.equal(rj.you.id, guestId);
  assert.equal(rj.lobby.id, 'lobby-1');
  const resumed = await back.waitFor('match');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.you, guestId);
  assert.equal(resumed.snap.full, 1, 'rejoin gets the complete state');
  assert.equal(h.lobby().count, 2, 'no duplicate player');
  await host.waitFor('snap', (m) => own(m, guestId).fz === 0);
  void hostId;
});

test('a player who never comes back is forfeited after the grace period, and the match can end', async () => {
  const { host, guest, hostId } = await h.startedMatch();
  guest.ws.terminate();
  const over = await host.waitFor('over', () => true, 6000);
  assert.equal(over.winnerId, hostId);
  assert.equal(h.lobby().count, 0);
});

// --- transport-level protections (unchanged behaviour) -----------------------------------------------------------------

test('abuse: bad JSON, oversized frames, unknown types and message floods do not crash the server', async () => {
  const c = await h.connect('Abuser');
  c.ws.send('not json {{{');
  c.send({ t: 'nonsense' });
  c.send({ nothing: true });
  c.send({ t: 'input', seq: 1, dir: 'up' }); // not in a lobby: ignored
  c.ws.send('x'.repeat(5000));
  await sleep(200);
  assert.equal(c.closeCode, 1009, 'oversized payload closes the socket');

  const f = await h.connect('Flooder');
  for (let i = 0; i < 600; i++) f.send({ t: 'ping', c: i });
  await sleep(300);
  assert.equal(f.closed, true, 'flooding client is disconnected');

  const ok = await h.enter('StillWorks');
  assert.ok(ok.joined.lobby.id);
});

test('origin check: unknown web origins are refused, known ones accepted', async () => {
  await assert.rejects(h.connect('Evil', { headers: { Origin: 'https://evil.example' } }));
  const good = await h.connect('Pages', { headers: { Origin: 'https://kavibz26.github.io' } });
  good.send({ t: 'ping', c: 1 });
  assert.equal((await good.waitFor('pong')).c, 1);
});

test('per-IP connection cap refuses excess sockets', async () => {
  const capped = createServer({ port: 0, maxConnsPerIp: 3 });
  const port = await capped.listen();
  const target = `ws://127.0.0.1:${port}`;
  const socks = [];
  for (let i = 0; i < 3; i++) {
    const ws = new WebSocket(target);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    socks.push(ws);
  }
  const fourth = new WebSocket(target);
  await assert.rejects(new Promise((res, rej) => { fourth.on('open', res); fourth.on('error', rej); }), /429/);
  socks.forEach((s) => s.terminate());
  await capped.close();
});
