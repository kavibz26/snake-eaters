import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, sleep, IDLE, PROTOCOL_VERSION } from './helpers.js';
import { LobbyManager } from '../lobbies.js';
import { LOBBY_COUNT, MAX_PLAYERS_PER_LOBBY } from '../protocol.js';

// Every test here runs against a fresh server that never auto-starts a match.
const h = harness(IDLE);
h.hooks();

const ids = (list) => list.lobbies.map((l) => l.id);

// --- the lobby list --------------------------------------------------------------------------------

test('lobby list: several fixed public lobbies, all starting empty (0/6) and waiting', async () => {
  const c = await h.connect('Browser');
  const list = await c.browse();
  assert.equal(list.lobbies.length, LOBBY_COUNT);
  assert.ok(list.lobbies.length > 1, 'multiple public lobbies exist');
  assert.equal(list.max, MAX_PLAYERS_PER_LOBBY);
  assert.equal(list.max, 6);
  assert.deepEqual(ids(list), ['lobby-1', 'lobby-2', 'lobby-3', 'lobby-4', 'lobby-5', 'lobby-6']);
  for (const l of list.lobbies) {
    assert.deepEqual(Object.keys(l).sort(), ['id', 'm', 'map', 'name', 'p', 's'], 'compact entries only (the configured map id is the one extra field)');
    assert.equal(l.p, 0);
    assert.equal(l.m, 6);
    assert.equal(l.s, 'waiting');
  }
  assert.equal(list.lobbies[2].name, 'Lobby 3');
  assert.equal(list.min, 2);
});

test('lobby count and capacity are configured in one place and can be changed', async () => {
  await h.stop();
  await h.start({ lobbyCount: 3, maxPlayers: 4 });
  const c = await h.connect('Browser');
  const list = await c.browse();
  assert.equal(list.lobbies.length, 3);
  assert.equal(list.max, 4);
  assert.ok(list.lobbies.every((l) => l.m === 4));

  // capacity can never exceed the number of skins (one per player)
  const big = new LobbyManager({ lobbyCount: 2, maxPlayers: 50 });
  assert.equal(big.maxPlayers, 8);
  big.shutdown();
});

test('nobody can create rooms: room codes and "create" no longer exist', async () => {
  const c = await h.connect('Old');
  c.send({ t: 'create', v: PROTOCOL_VERSION, name: 'Old', skin: 'classic' });
  c.send({ t: 'join', v: PROTOCOL_VERSION, code: 'ABCDE', name: 'Old', skin: 'classic' });
  const err = await c.waitFor('error');
  assert.equal(err.code, 'invalid_lobby', 'a room code is not a lobby');
  assert.equal(c.has('joined'), false);
  const list = await c.browse();
  assert.equal(list.lobbies.length, LOBBY_COUNT, 'no lobby was created');
});

// --- joining --------------------------------------------------------------------------------------------

test('a player can join an available lobby: gets a private token, the roster and the count', async () => {
  const c = await h.connect('Ann');
  const j = await c.join('lobby-4', 'Ann', 'inferno');
  assert.equal(j.lobby.id, 'lobby-4');
  assert.equal(j.lobby.name, 'Lobby 4');
  assert.equal(j.lobby.max, 6);
  assert.equal(j.lobby.players.length, 1);
  assert.equal(j.lobby.players[0].name, 'Ann');
  assert.equal(j.lobby.state, 'waiting');
  assert.ok(j.you.id && j.you.token.length >= 16);
  assert.equal(JSON.stringify(j.lobby).includes(j.you.token), false, 'the token is not part of the public roster');
  assert.equal(h.lobby('lobby-4').count, 1);
});

test('the lobby browser is updated by server push (compact, no polling) as players come and go', async () => {
  const watcher = await h.connect('Watcher');
  await watcher.browse();

  const a = await h.enter('A', { lobby: 'lobby-2' });
  assert.deepEqual(await watcher.waitFor('lu', (m) => m.id === 'lobby-2'), { t: 'lu', id: 'lobby-2', p: 1, m: 6, s: 'waiting' });
  const b = await h.enter('B', { lobby: 'lobby-2' });
  assert.equal((await watcher.waitFor('lu', (m) => m.id === 'lobby-2')).p, 2);
  await b.leave();
  assert.equal((await watcher.waitFor('lu', (m) => m.id === 'lobby-2')).p, 1);
  await a.leave();
  assert.equal((await watcher.waitFor('lu', (m) => m.id === 'lobby-2')).p, 0);

  // Other lobbies are untouched, and unsubscribing stops the pushes.
  watcher.send({ t: 'unbrowse' });
  await sleep(50);
  const before = watcher.all('lu').length;
  await h.enter('C', { lobby: 'lobby-5' });
  await sleep(150);
  assert.equal(watcher.all('lu').length, before);
});

test('a lobby with a browser open shows the update immediately: 5/6 -> 6/6 (FULL) -> 5/6', async () => {
  const watcher = await h.connect('Watcher');
  await watcher.browse();
  const players = [];
  for (let i = 1; i <= 5; i++) players.push(await h.enter(`P${i}`, { lobby: 'lobby-3' }));
  // 2+ players in the lobby means it is counting down to an automatic start (this idle server
  // just never lets the timer fire).
  assert.equal((await watcher.waitFor('lu', (m) => m.p === 5)).s, 'countdown');
  players.push(await h.enter('P6', { lobby: 'lobby-3' }));
  const full = await watcher.waitFor('lu', (m) => m.p === 6);
  assert.equal(full.m, 6, 'server says it is full: p === m');
  await players[0].leave();
  const freed = await watcher.waitFor('lu', (m) => m.p === 5);
  assert.ok(freed.p < freed.m, 'joinable again');
});

test('sixth player can join; the seventh is rejected with lobby_full', async () => {
  for (let i = 1; i <= 6; i++) await h.enter(`P${i}`, { lobby: 'lobby-1' });
  assert.equal(h.lobby('lobby-1').count, 6);
  const seventh = await h.connect('P7');
  await assert.rejects(seventh.join('lobby-1', 'P7'), (e) => e.code === 'lobby_full');
  assert.equal(h.lobby('lobby-1').count, 6, 'still 6');
  // ...but another lobby is open to them.
  await seventh.join('lobby-2', 'P7');
  assert.equal(h.lobby('lobby-2').count, 1);
});

test('RACE: simultaneous joins never produce a 7th player (many rounds, many sockets)', async () => {
  const sockets = [];
  for (let i = 0; i < 12; i++) sockets.push(await h.connect(`S${i}`));

  for (let round = 0; round < 6; round++) {
    const lobbyId = `lobby-${(round % 6) + 1}`;
    // Everybody fires their join in the same tick.
    for (const s of sockets) s.send({ t: 'join', v: PROTOCOL_VERSION, lobby: lobbyId, name: s.name, skin: 'classic' });
    const results = await Promise.all(sockets.map((s) => s.waitAny(['joined', 'error'])));
    const joined = results.filter((r) => r.t === 'joined');
    const rejected = results.filter((r) => r.t === 'error');
    assert.equal(joined.length, 6, `round ${round}: exactly 6 got in`);
    assert.equal(rejected.length, 6);
    assert.ok(rejected.every((r) => r.code === 'lobby_full'));
    assert.equal(h.lobby(lobbyId).count, 6, 'server-side count is exactly the maximum');
    assert.equal(new Set(joined.map((j) => j.you.id)).size, 6, 'six distinct players');

    // release them for the next round
    for (const s of sockets) if (s.msgs.length >= 0 && joined.some((j) => j.lobby && j === undefined)) { /* noop */ }
    const inside = sockets.filter((_, i) => results[i].t === 'joined');
    await Promise.all(inside.map((s) => s.leave()));
    assert.equal(h.lobby(lobbyId).count, 0);
  }
});

test('RACE: joining and leaving at the very same moment on a full lobby stays within capacity', async () => {
  const inside = [];
  for (let i = 1; i <= 6; i++) inside.push(await h.enter(`In${i}`, { lobby: 'lobby-6' }));
  const outsiders = [];
  for (let i = 0; i < 4; i++) outsiders.push(await h.connect(`Out${i}`));

  // Two players leave while four outsiders try to get in - all in the same tick.
  inside[0].send({ t: 'leave' });
  inside[1].send({ t: 'leave' });
  for (const o of outsiders) o.send({ t: 'join', v: PROTOCOL_VERSION, lobby: 'lobby-6', name: o.name, skin: 'classic' });
  const results = await Promise.all(outsiders.map((o) => o.waitAny(['joined', 'error'])));
  assert.equal(results.filter((r) => r.t === 'joined').length, 2, 'exactly the two freed slots were taken');
  assert.equal(h.lobby('lobby-6').count, 6);
  assert.ok(h.lobby('lobby-6').count <= h.lobby('lobby-6').max);
});

test('a client cannot claim capacity: nothing the client sends changes the limit or the count', async () => {
  const c = await h.connect('Cheat');
  c.send({ t: 'join', v: PROTOCOL_VERSION, lobby: 'lobby-1', name: 'Cheat', skin: 'classic', max: 99, p: 0, players: 0, maxPlayers: 99 });
  await c.waitFor('joined');
  assert.equal(h.lobby('lobby-1').max, 6);
  assert.equal(h.lobby('lobby-1').count, 1);
  const list = await (await h.connect('W')).browse();
  assert.equal(list.max, 6);
});

// --- leaving / disconnecting / reconnecting -----------------------------------------------------------------

test('leaving frees the slot immediately', async () => {
  const players = [];
  for (let i = 1; i <= 6; i++) players.push(await h.enter(`P${i}`, { lobby: 'lobby-1' }));
  const late = await h.connect('Late');
  await assert.rejects(late.join('lobby-1'), (e) => e.code === 'lobby_full');
  await players[3].leave();
  assert.equal(h.lobby('lobby-1').count, 5);
  await late.join('lobby-1', 'Late');
  assert.equal(h.lobby('lobby-1').count, 6);
});

test('a player who left no longer receives lobby traffic and can join a different lobby', async () => {
  const a = await h.enter('A', { lobby: 'lobby-1' });
  const b = await h.enter('B', { lobby: 'lobby-1' });
  await b.leave();
  b.msgs.length = 0;
  await h.enter('C', { lobby: 'lobby-1' });
  await sleep(100);
  assert.equal(b.has('lobby'), false, 'ex-member gets no roster updates for the lobby it left');
  await b.join('lobby-3', 'B');
  assert.equal(h.lobby('lobby-3').count, 1);
  assert.equal(a.closed, false);
});

test('disconnecting keeps the slot for the grace period; reconnecting reclaims it without a duplicate', async () => {
  const players = [];
  for (let i = 1; i <= 6; i++) players.push(await h.enter(`P${i}`, { lobby: 'lobby-1' }));
  const victim = players[2];
  const { id, token } = victim.joined.you;
  victim.ws.terminate();
  await sleep(150);

  const lobby = h.lobby('lobby-1');
  assert.equal(lobby.count, 6, 'slot is held during the grace period');
  assert.equal(lobby.players.get(id).connected, false);
  const stranger = await h.connect('Stranger');
  await assert.rejects(stranger.join('lobby-1'), (e) => e.code === 'lobby_full', 'the held slot cannot be taken');

  const back = await h.connect('P3 again');
  back.send({ t: 'rejoin', v: PROTOCOL_VERSION, lobby: 'lobby-1', id, token });
  const rj = await back.waitFor('joined');
  assert.equal(rj.you.id, id, 'same player identity');
  assert.equal(lobby.count, 6, 'no duplicate created');
  assert.equal(lobby.players.get(id).connected, true);
  assert.equal(new Set([...lobby.players.keys()]).size, 6);
  const roster = await players[0].waitFor('lobby', (m) => m.lobby.players.length === 6 && m.lobby.players.every((p) => p.connected));
  assert.equal(roster.lobby.players.length, 6);
});

test('when the grace period expires the slot is freed and the old token is dead', async () => {
  const a = await h.enter('A', { lobby: 'lobby-1' });
  const b = await h.enter('B', { lobby: 'lobby-1' });
  const { id, token } = b.joined.you;
  const watcher = await h.connect('Watcher');
  await watcher.browse();
  b.ws.terminate();
  await sleep(1700); // > RECONNECT_GRACE_MS (1200)
  assert.equal(h.lobby('lobby-1').count, 1);
  assert.equal((await watcher.waitFor('lu', (m) => m.id === 'lobby-1' && m.p === 1)).p, 1);
  const late = await h.connect('B again');
  late.send({ t: 'rejoin', v: PROTOCOL_VERSION, lobby: 'lobby-1', id, token });
  assert.equal((await late.waitFor('error')).code, 'invalid_session');
  assert.equal(a.closed, false);
});

test('rejoin needs the right lobby, player id AND secret token', async () => {
  const a = await h.enter('A', { lobby: 'lobby-1' });
  await h.enter('B', { lobby: 'lobby-1' });
  const { id, token } = a.joined.you;
  a.ws.terminate();
  await sleep(100);
  const tries = [
    { lobby: 'lobby-1', id, token: 'nope' },
    { lobby: 'lobby-2', id, token },
    { lobby: 'lobby-1', id: 'p_deadbeef', token },
    { lobby: 'not-a-lobby', id, token },
    { lobby: 'lobby-1', id, token: 12345 },
    { id, token },
  ];
  for (const t of tries) {
    const c = await h.connect('Imposter');
    c.send({ t: 'rejoin', v: PROTOCOL_VERSION, ...t });
    assert.equal((await c.waitFor('error')).code, 'invalid_session', JSON.stringify(t));
  }
  assert.equal(h.lobby('lobby-1').players.get(id).connected, false, 'seat still waiting for its real owner');
});

test('reconnecting to a lobby you are already connected in is refused; a second socket cannot double-join', async () => {
  const a = await h.enter('A', { lobby: 'lobby-1' });
  a.send({ t: 'join', v: PROTOCOL_VERSION, lobby: 'lobby-2', name: 'A', skin: 'classic' });
  assert.equal((await a.waitFor('error')).code, 'bad_state');
  assert.equal(h.lobby('lobby-2').count, 0);
  a.send({ t: 'lobbies', v: PROTOCOL_VERSION });
  assert.equal((await a.waitFor('error')).code, 'bad_state', 'browsing while inside a lobby is refused');
});

// --- names, skins, validation -----------------------------------------------------------------------------------

test('nicknames are sanitised and unique in a lobby; a taken skin is swapped for a free one', async () => {
  const a = await h.enter('‮<img src=x onerror=alert(1)>\u0000ABCDEFGHIJKLMNOPQRST', { lobby: 'lobby-1', skin: 'frost' });
  const name = a.joined.lobby.players[0].name;
  assert.ok(!/[<>‮\u0000]/.test(name), name);
  assert.ok(Array.from(name).length <= 14);
  const b = await h.enter('Sam', { lobby: 'lobby-2', skin: 'frost' });
  const c = await h.enter('Sam', { lobby: 'lobby-2', skin: 'frost' });
  const roster = c.joined.lobby.players;
  assert.equal(new Set(roster.map((p) => p.name)).size, 2, 'duplicate names disambiguated');
  assert.equal(new Set(roster.map((p) => p.skinId)).size, 2, 'skins unique within a lobby');
  const blank = await h.enter('   \u0000  ', { lobby: 'lobby-3' });
  assert.equal(blank.joined.lobby.players[0].name, 'Player');
  assert.ok(b);
});

test('unknown, malformed or non-string lobby ids fail gracefully and keep the connection usable', async () => {
  const c = await h.connect('X');
  for (const lobby of ['lobby-99', 'LOBBY-1', '', null, 7, { id: 'lobby-1' }, ['lobby-1'], '../etc', 'lobby-1 ']) {
    c.send({ t: 'join', v: PROTOCOL_VERSION, lobby, name: 'X', skin: 'classic' });
    assert.equal((await c.waitFor('error')).code, 'invalid_lobby', JSON.stringify(lobby));
  }
  assert.equal(c.closed, false);
  await c.join('lobby-1', 'X');
});

test('a client on another protocol version is told which side is behind', async () => {
  const c = await h.connect('Old');
  c.send({ t: 'lobbies', v: 2 });
  const err = await c.waitFor('error');
  assert.equal(err.code, 'bad_version');
  assert.equal(err.sv, PROTOCOL_VERSION);
  c.send({ t: 'join', v: 1, lobby: 'lobby-1', name: 'Old', skin: 'classic' });
  assert.equal((await c.waitFor('error')).code, 'bad_version');
  assert.equal(h.lobby('lobby-1').count, 0);
});

test('the private token is only ever sent to its owner, in the joined message', async () => {
  const a = await h.enter('A', { lobby: 'lobby-1' });
  const b = await h.enter('B', { lobby: 'lobby-1' });
  const watcher = await h.connect('W');
  await watcher.browse();
  await sleep(100);
  for (const c of [a, b, watcher]) {
    for (const m of c.msgs) {
      if (m.t === 'joined') continue;
      assert.equal(JSON.stringify(m).includes(a.joined.you.token), false, `${c.name} saw A's token in ${m.t}`);
      assert.equal(JSON.stringify(m).includes(b.joined.you.token), false, `${c.name} saw B's token in ${m.t}`);
    }
  }
});

test('health reports lobbies and players (no room concept)', async () => {
  await h.enter('A', { lobby: 'lobby-1' });
  const body = await (await fetch(h.url.replace('ws://', 'http://') + '/health')).json();
  assert.equal(body.ok, true);
  assert.equal(body.protocol, PROTOCOL_VERSION);
  assert.equal(body.lobbies, LOBBY_COUNT);
  assert.equal(body.players, 1);
  assert.equal('rooms' in body, false);
});
