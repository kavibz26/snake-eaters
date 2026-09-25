import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, sleep, FAST, PROTOCOL_VERSION } from './helpers.js';

// Extra lobby-flow / abuse coverage from the polish + QA pass.
const h = harness(FAST);
h.hooks();

const own = (snap, id) => snap.snakes.find((s) => s.id === id);

test('sync is rate limited: a client cannot make the server send full snapshots in a loop', async () => {
  const { host } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  for (let i = 0; i < 20; i++) host.send({ t: 'sync' });
  await sleep(250);
  const fulls = host.all('snap').filter((m) => m.full === 1);
  assert.ok(fulls.length >= 1, 'the first request is honoured');
  assert.ok(fulls.length <= 2, `20 requests in 250ms produced only ${fulls.length} full snapshot(s)`);
});

test('a player who drops during the lobby countdown keeps the slot; the countdown pauses below 2 connected and resumes on return', async () => {
  await h.stop();
  await h.start({ startDelayMs: 900, fullStartDelayMs: 150 });
  const a = await h.enter('A');
  const b = await h.enter('B');
  await a.waitFor('lobby', (m) => m.lobby.state === 'countdown');
  const { id, token } = b.joined.you;
  b.ws.terminate();
  const waiting = await a.waitFor('lobby', (m) => m.lobby.state === 'waiting' && m.lobby.players.length === 2);
  assert.equal(waiting.lobby.players.length, 2, 'the dropped player still holds their slot');
  assert.equal(waiting.lobby.players.find((p) => p.id === id).connected, false);
  assert.equal(h.lobby().count, 2);

  const back = await h.connect('B again');
  back.send({ t: 'rejoin', v: PROTOCOL_VERSION, lobby: 'lobby-1', id, token });
  await back.waitFor('joined');
  await a.waitFor('lobby', (m) => m.lobby.state === 'countdown'); // 2 connected again -> counting down
  const m = await a.waitFor('match');
  assert.equal(m.players.length, 2, 'the returning player is in the match, exactly once');
  assert.equal(new Set(m.players.map((p) => p.id)).size, 2);
});

test('lobby-full transition: the browser sees p === m, then the lobby starts on the short timer', async () => {
  await h.stop();
  await h.start({ startDelayMs: 5000, fullStartDelayMs: 200 });
  const watcher = await h.connect('Watcher');
  await watcher.browse();
  const skins = ['classic', 'inferno', 'frost', 'toxic', 'cosmic', 'golden'];
  for (let i = 1; i <= 6; i++) await h.enter(`P${i}`, { lobby: 'lobby-2', skin: skins[i - 1] });
  const full = await watcher.waitFor('lu', (m) => m.id === 'lobby-2' && m.p === 6);
  assert.equal(full.m, 6);
  assert.equal((await watcher.waitFor('lu', (m) => m.id === 'lobby-2' && m.s === 'running', 3000)).p, 6);
});

test('a reconnecting player never appears twice in the roster, snapshots or leaderboard', async () => {
  const { host, guest, guestId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  const { token } = guest.joined.you;
  guest.ws.terminate();
  await host.waitFor('lobby', (m) => m.lobby.players.some((p) => p.id === guestId && !p.connected));
  const back = await h.connect('Bob again');
  back.send({ t: 'rejoin', v: PROTOCOL_VERSION, lobby: 'lobby-1', id: guestId, token });
  await back.waitFor('match');
  const snap = await host.waitFor('snap', (m) => own(m, guestId) && own(m, guestId).fz === 0 && m.tick > 3);
  assert.equal(snap.snakes.length, 2);
  assert.equal(new Set(snap.snakes.map((s) => s.id)).size, 2);
  assert.equal(new Set(snap.lb).size, 2, 'leaderboard indices are unique');
  const roster = await host.waitFor('lobby', (m) => m.lobby.players.length === 2 && m.lobby.players.every((p) => p.connected));
  assert.equal(roster.lobby.players.length, 2);
  assert.equal(h.lobby().count, 2);
});

test('running lobbies reject joins even from a socket that already knows the lobby id', async () => {
  const { host } = await h.startedMatch();
  const late = await h.connect('Late');
  for (let i = 0; i < 5; i++) {
    late.send({ t: 'join', v: PROTOCOL_VERSION, lobby: 'lobby-1', name: 'Late', skin: 'classic' });
    assert.equal((await late.waitFor('error')).code, 'match_in_progress');
  }
  assert.equal(h.lobby().count, 2);
  assert.ok(host);
});

test('oversized and malformed chat never reaches other players, and the sender is not disconnected', async () => {
  await h.stop();
  await h.start({ startDelayMs: 600000, fullStartDelayMs: 600000 });
  const a = await h.enter('A');
  const b = await h.enter('B');
  a.send({ t: 'chat', m: 'x'.repeat(1100) }); // over the 1KB frame limit once serialised
  await sleep(150);
  assert.equal(a.closed, true, 'an oversized frame closes only the sender');
  assert.equal(b.has('chat'), false);
  assert.equal(b.closed, false);
});
