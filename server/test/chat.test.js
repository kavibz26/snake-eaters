import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, sleep, IDLE, PROTOCOL_VERSION } from './helpers.js';
import { sanitizeChat, CHAT_MAX } from '../protocol.js';

// Fresh idle server per test: lobbies never auto-start, so chat can be tested without a match.
const h = harness(IDLE);
h.hooks();

// Two players in a lobby: resolves { a, b }.
async function pair(lobby = 'lobby-1') {
  const a = await h.enter('Alice', { lobby, skin: 'classic' });
  const b = await h.enter('Bob', { lobby, skin: 'inferno' });
  return { a, b };
}

test('chat: relayed to everyone in the lobby with the SERVER-known sender name, id and a timestamp', async () => {
  const { a, b } = await pair();
  b.send({ t: 'chat', m: 'hello team', name: 'Admin', id: a.joined.you.id, ts: 1 }); // forged fields
  const [ga, gb] = await Promise.all([a.waitFor('chat'), b.waitFor('chat')]);
  for (const m of [ga, gb]) {
    assert.equal(m.m, 'hello team');
    assert.equal(m.name, 'Bob', 'name comes from the server, not the client');
    assert.equal(m.id, b.joined.you.id, 'id comes from the server, not the client');
    assert.ok(Math.abs(m.ts - Date.now()) < 5000, 'server timestamp');
  }
  assert.ok(!JSON.stringify(ga).includes(a.joined.you.token));
  assert.ok(!JSON.stringify(ga).includes(b.joined.you.token));
});

test('chat is scoped to ONE lobby: other lobbies and browsers never see it', async () => {
  const { a, b } = await pair('lobby-1');
  const c = await h.enter('Carol', { lobby: 'lobby-2' });
  const d = await h.enter('Dave', { lobby: 'lobby-2' });
  const browser = await h.connect('Browser');
  await browser.browse();

  a.send({ t: 'chat', m: 'lobby one only' });
  const one = await Promise.all([a.waitFor('chat'), b.waitFor('chat')]);
  c.send({ t: 'chat', m: 'lobby two only' });
  const two = await Promise.all([c.waitFor('chat'), d.waitFor('chat')]);
  await sleep(150);

  assert.deepEqual(one.map((m) => m.m), ['lobby one only', 'lobby one only']);
  assert.deepEqual(two.map((m) => m.m), ['lobby two only', 'lobby two only']);
  // waitFor consumed each player's own copy; anything still queued would be a foreign message.
  for (const client of [a, b, c, d, browser]) assert.equal(client.has('chat'), false, `${client.name} received a message from another lobby`);
});

test('chat: a player who left the lobby stops receiving its chat and cannot post to it', async () => {
  const { a, b } = await pair();
  await b.leave();
  b.msgs.length = 0;
  a.send({ t: 'chat', m: 'after you left' });
  await a.waitFor('chat');
  b.send({ t: 'chat', m: 'ghost' });
  await sleep(200);
  assert.equal(b.has('chat'), false, 'ex-member receives nothing');
  assert.equal(a.has('chat', (m) => m.m === 'ghost'), false, 'ex-member cannot post');
  assert.equal(b.closed, false);
});

test('chat: validation - plain text only, control/bidi stripped, length capped, empty rejected', async () => {
  const { a, b } = await pair();
  b.send({ t: 'chat', m: '  <img src=x onerror=alert(1)>‮   spaced\u0000   out  ' });
  assert.equal((await a.waitFor('chat')).m, '<img src=x onerror=alert(1)> spaced out', 'kept as inert text; invisible/control chars removed');
  b.send({ t: 'chat', m: 'x'.repeat(400) });
  assert.equal((await a.waitFor('chat')).m.length, CHAT_MAX);
  b.send({ t: 'chat', m: '   \u0000​  ' });
  assert.equal((await b.waitFor('chat_error')).code, 'chat_empty');
  for (const bad of [123, null, { a: 1 }, ['x']]) b.send({ t: 'chat', m: bad });
  await sleep(150);
  assert.equal(b.closed, false);
  assert.equal(sanitizeChat('a‮b​c'), 'abc');
});

test('chat: rate limited per player (burst then throttled), others unaffected', async () => {
  const { a, b } = await pair();
  for (let i = 0; i < 9; i++) b.send({ t: 'chat', m: `spam ${i}` });
  const err = await b.waitFor('chat_error', (m) => m.code === 'chat_rate');
  assert.match(err.message, /too quickly/);
  await sleep(200);
  const delivered = a.all('chat').length;
  assert.ok(delivered >= 4 && delivered <= 6, `roughly the burst allowance got through (${delivered})`);
  a.send({ t: 'chat', m: 'I can still talk' });
  assert.equal((await b.waitFor('chat', (m) => m.m === 'I can still talk')).name, 'Alice', 'the spammer does not throttle others');
});

test('chat: late joiners and reconnecting players get the lobby history; an emptied lobby starts clean', async () => {
  const a = await h.enter('Alice', { lobby: 'lobby-1' });
  a.send({ t: 'chat', m: 'first' });
  await a.waitFor('chat');
  const b = await h.enter('Bob', { lobby: 'lobby-1', skin: 'inferno' });
  assert.deepEqual(b.joined.chat.map((c) => c.m), ['first'], 'history replayed on join');
  assert.ok(b.joined.chat.every((c) => c.id && c.name && !('token' in c)));

  const { id, token } = b.joined.you;
  b.ws.terminate();
  await a.waitFor('lobby', (m) => m.lobby.players.some((p) => !p.connected));
  a.send({ t: 'chat', m: 'while you were gone' });
  await a.waitFor('chat');
  const back = await h.connect('Bob again');
  back.send({ t: 'rejoin', v: PROTOCOL_VERSION, lobby: 'lobby-1', id, token });
  const rj = await back.waitFor('joined');
  assert.deepEqual(rj.chat.map((c) => c.m), ['first', 'while you were gone'], 'reconnect replays the history');

  await a.leave();
  await back.leave();
  const fresh = await h.enter('Newcomer', { lobby: 'lobby-1' });
  assert.deepEqual(fresh.joined.chat, [], 'nothing leaks from the previous group');
});
