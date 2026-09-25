import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

// Short timers so lifecycle tests run in seconds (must be set before the
// server modules are imported).
process.env.COUNTDOWN_MS = '300';
process.env.RECONNECT_GRACE_MS = '1200';
const { createServer } = await import('../index.js');
const { PROTOCOL_VERSION } = await import('../protocol.js');
const { CONFIG } = await import('../../js/config.js');

let server;
let url;
const open = [];

before(async () => {
  server = createServer({ port: 0, allowedOrigins: ['https://kavibz26.github.io', '*localhost'], maxConnsPerIp: 500 });
  const port = await server.listen();
  url = `ws://127.0.0.1:${port}`;
});

after(async () => {
  for (const c of open) c.ws.terminate();
  await server.close();
});

class Client {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.waiters = [];
    this.closed = false;
  }

  static async connect(name, opts = {}) {
    const c = new Client(name);
    c.ws = new WebSocket(url, opts);
    c.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      c.msgs.push(m);
      c.waiters = c.waiters.filter((w) => !w.try(m));
    });
    c.ws.on('close', (code) => { c.closed = true; c.closeCode = code; });
    await new Promise((res, rej) => { c.ws.on('open', res); c.ws.on('error', rej); });
    open.push(c);
    return c;
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  // Resolves with the next message (already received or future) matching type/predicate.
  waitFor(type, pred = () => true, timeout = 4000) {
    const hit = this.msgs.find((m) => m.t === type && pred(m));
    if (hit) { this.msgs.splice(this.msgs.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: timed out waiting for ${type}`)), timeout);
      this.waiters.push({
        try: (m) => {
          if (m.t === type && pred(m)) {
            clearTimeout(timer);
            this.msgs.splice(this.msgs.indexOf(m), 1);
            resolve(m);
            return true;
          }
          return false;
        },
      });
    });
  }

  latest(type) { return [...this.msgs].reverse().find((m) => m.t === type); }
}

const create = async (name, skin = 'classic') => {
  const c = await Client.connect(name);
  c.send({ t: 'create', v: PROTOCOL_VERSION, name, skin });
  c.joined = await c.waitFor('joined');
  return c;
};
const join = async (name, code, skin = 'inferno') => {
  const c = await Client.connect(name);
  c.send({ t: 'join', v: PROTOCOL_VERSION, code, name, skin });
  return c;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('create room returns a 5-char code and a private token', async () => {
  const host = await create('Host');
  assert.match(host.joined.room.code, /^[A-HJ-KM-NP-Z2-9]{5}$/);
  assert.equal(host.joined.room.hostId, host.joined.you.id);
  assert.ok(host.joined.you.token.length >= 16);
  assert.equal(host.joined.room.players.length, 1);
  assert.equal(host.joined.room.players[0].token, undefined, 'tokens are never broadcast');
});

test('invalid / malformed / unknown room codes fail gracefully', async () => {
  for (const code of ['ZZZZZ', 'abc', '', '!!!!!', 'O0O0O']) {
    const c = await join('Nobody', code);
    const err = await c.waitFor('error');
    assert.equal(err.code, 'invalid_room', `code "${code}"`);
    assert.ok(err.message.length > 5);
    assert.equal(c.closed, false, 'connection stays usable after an error');
  }
});

test('protocol version mismatch is rejected with a refresh hint', async () => {
  const c = await Client.connect('Old');
  c.send({ t: 'create', v: 0, name: 'Old', skin: 'classic' });
  const err = await c.waitFor('error');
  assert.equal(err.code, 'bad_version');
});

test('join is case-insensitive and the lobby lists both players to both', async () => {
  const host = await create('Alice');
  const guest = await join('Bob', host.joined.room.code.toLowerCase());
  const joined = await guest.waitFor('joined');
  assert.equal(joined.room.players.length, 2);
  const hostView = await host.waitFor('room', (m) => m.room.players.length === 2);
  assert.deepEqual(hostView.room.players.map((p) => p.name).sort(), ['Alice', 'Bob']);
  assert.notEqual(joined.you.id, host.joined.you.id, 'unique player ids');
});

test('duplicate skin is swapped for a free one; duplicate names are disambiguated', async () => {
  const host = await create('Sam', 'frost');
  const guest = await join('Sam', host.joined.room.code, 'frost');
  const joined = await guest.waitFor('joined');
  const skins = joined.room.players.map((p) => p.skinId);
  assert.equal(new Set(skins).size, 2, 'skins are unique in a room');
  const names = joined.room.players.map((p) => p.name);
  assert.equal(new Set(names).size, 2, 'names are unique in a room');
});

test('nicknames are sanitized (no control chars / markup / bidi tricks / overflow)', async () => {
  const host = await create('‮<img src=x onerror=alert(1)>\u0000ABCDEFGHIJKLMNOPQRST');
  const name = host.joined.room.players[0].name;
  assert.ok(!/[<>‮\u0000]/.test(name), name);
  assert.ok(Array.from(name).length <= 14);
  const blank = await create('   \u0000  ');
  assert.equal(blank.joined.room.players[0].name, 'Player');
});

test('only the host can start, and never with a single player', async () => {
  const host = await create('Host');
  host.send({ t: 'start' });
  assert.equal((await host.waitFor('error')).code, 'need_players');
  const guest = await join('Guest', host.joined.room.code);
  await guest.waitFor('joined');
  guest.send({ t: 'start' });
  assert.equal((await guest.waitFor('error')).code, 'not_host');
});

test('room full at 8 players, and joining after start is refused', async () => {
  const host = await create('Host');
  const code = host.joined.room.code;
  const guests = [];
  for (let i = 0; i < 7; i++) {
    const g = await join(`G${i}`, code, ['inferno', 'frost', 'toxic', 'cosmic', 'golden', 'shadow', 'jungle'][i]);
    await g.waitFor('joined');
    guests.push(g);
  }
  const ninth = await join('Late', code);
  assert.equal((await ninth.waitFor('error')).code, 'room_full');

  host.send({ t: 'start' });
  await host.waitFor('match');
  const late2 = await join('Later', code);
  assert.equal((await late2.waitFor('error')).code, 'match_in_progress');
  for (const g of guests) g.send({ t: 'leave' });
  host.send({ t: 'leave' });
});

test('full 2-player match: both receive the match, snapshots, and drive ONLY their own snake', async () => {
  const host = await create('Alice', 'classic');
  const guest = await join('Bob', host.joined.room.code, 'inferno');
  guest.joined = await guest.waitFor('joined');
  await host.waitFor('room', (m) => m.room.players.length === 2);

  host.send({ t: 'start' });
  const [mh, mg] = await Promise.all([host.waitFor('match'), guest.waitFor('match')]);
  assert.equal(mh.you, host.joined.you.id);
  assert.equal(mg.you, guest.joined.you.id);
  assert.equal(mh.startsInMs > 0, true);
  assert.equal(mh.players.length, 2);
  assert.equal(mh.snap.snakes.length, 2);
  assert.equal(mh.tickMs, CONFIG.TICK_MS);

  const s1 = await host.waitFor('snap', (m) => m.tick >= 1);
  const s1g = await guest.waitFor('snap', (m) => m.tick >= 1);
  assert.equal(s1.snakes.length, 2);
  assert.ok(s1.f.length > 0, 'food is in the snapshot');
  assert.equal(JSON.stringify(s1.snakes.map((s) => s.id)), JSON.stringify(s1g.snakes.map((s) => s.id)));

  // Each client turns its own snake perpendicular to its heading.
  const me = host.joined.you.id;
  const other = guest.joined.you.id;
  const dirName = ([dx]) => (dx !== 0 ? 'up' : 'right');
  const before = s1.snakes.find((s) => s.id === me);
  const otherBefore = s1.snakes.find((s) => s.id === other);
  const want = dirName(before.d);
  // Forged fields must not let a client steer someone else.
  host.send({ t: 'dir', d: want, id: other, snake: other });
  await sleep(CONFIG.TICK_MS * 3);
  const after = host.latest('snap');
  const meAfter = after.snakes.find((s) => s.id === me);
  const otherAfter = after.snakes.find((s) => s.id === other);
  if (meAfter.a) {
    const wantVec = CONFIG.DIRECTIONS[want];
    assert.deepEqual(meAfter.d, [wantVec.x, wantVec.y], 'my snake turned');
  }
  if (otherAfter.a && otherBefore.a) {
    assert.deepEqual(otherAfter.d, otherBefore.d, "the other player's heading was not changed by my forged input");
  }

  // Boost via server: both sees timers in snapshot.
  guest.send({ t: 'boost' });
  const boosted = await guest.waitFor('snap', (m) => {
    const g = m.snakes.find((s) => s.id === other);
    return !g.a || g.b[0] > 0;
  });
  assert.ok(boosted);

  // Clean up: guest leaves -> host wins -> match over -> room returns to lobby.
  guest.send({ t: 'leave' });
  const over = await host.waitFor('over', () => true, 6000);
  assert.equal(over.winnerId, me);
  assert.equal(over.results[0].id, me);
  assert.equal(over.results.length, 2);
  const lobby = await host.waitFor('room', (m) => m.room.state === 'lobby');
  assert.equal(lobby.room.players.length, 1);
  host.send({ t: 'leave' });
});

test('snapshots never contain tokens or other private fields', async () => {
  const host = await create('Priv');
  const guest = await join('Priv2', host.joined.room.code);
  await guest.waitFor('joined');
  host.send({ t: 'start' });
  const snap = await host.waitFor('snap', (m) => m.tick >= 1);
  const raw = JSON.stringify(snap) + JSON.stringify(host.latest('match') || {});
  assert.ok(!raw.includes(host.joined.you.token));
  assert.ok(!raw.includes(guest.joined?.you?.token || 'x-none'));
  guest.send({ t: 'leave' });
  host.send({ t: 'leave' });
});

test('disconnect freezes the snake, reconnect with the token resumes it', async () => {
  const host = await create('Alice');
  const guest = await join('Bob', host.joined.room.code, 'inferno');
  const gj = await guest.waitFor('joined');
  await host.waitFor('room', (m) => m.room.players.length === 2);
  host.send({ t: 'start' });
  await host.waitFor('match');
  await host.waitFor('snap', (m) => m.tick >= 1);

  const bobId = gj.you.id;
  const code = host.joined.room.code;
  guest.ws.terminate(); // abrupt drop
  const dcView = await host.waitFor('room', (m) => m.room.players.some((p) => p.id === bobId && !p.connected));
  assert.ok(dcView);
  const frozen = await host.waitFor('snap', (m) => m.snakes.find((s) => s.id === bobId).fz === 1);
  const headA = frozen.snakes.find((s) => s.id === bobId).c.slice(0, 2);
  await sleep(CONFIG.TICK_MS * 3);
  const headB = host.latest('snap').snakes.find((s) => s.id === bobId).c.slice(0, 2);
  assert.deepEqual(headB, headA, 'frozen snake did not move while disconnected');

  // Wrong token is refused; the right one resumes.
  const imposter = await Client.connect('Imposter');
  imposter.send({ t: 'rejoin', v: PROTOCOL_VERSION, code, id: bobId, token: 'nope' });
  assert.equal((await imposter.waitFor('error')).code, 'invalid_session');

  const back = await Client.connect('Bob2');
  back.send({ t: 'rejoin', v: PROTOCOL_VERSION, code, id: bobId, token: gj.you.token });
  const rj = await back.waitFor('joined');
  assert.equal(rj.you.id, bobId);
  const resumed = await back.waitFor('match');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.you, bobId);
  const live = await host.waitFor('snap', (m) => m.snakes.find((s) => s.id === bobId).fz === 0);
  assert.ok(live, 'snake unfrozen after reconnect');

  back.send({ t: 'leave' });
  await host.waitFor('over', () => true, 6000);
  host.send({ t: 'leave' });
});

test('a player who never comes back is forfeited after the grace period', async () => {
  const host = await create('Alice');
  const guest = await join('Bob', host.joined.room.code, 'inferno');
  await guest.waitFor('joined');
  await host.waitFor('room', (m) => m.room.players.length === 2);
  host.send({ t: 'start' });
  await host.waitFor('match');
  guest.ws.terminate();
  const over = await host.waitFor('over', () => true, 5000);
  assert.equal(over.winnerId, host.joined.you.id);
  host.send({ t: 'leave' });
});

test('host leaving hands the host role to someone else', async () => {
  const host = await create('Alice');
  const guest = await join('Bob', host.joined.room.code, 'inferno');
  const gj = await guest.waitFor('joined');
  host.send({ t: 'leave' });
  const room = await guest.waitFor('room', (m) => m.room.hostId === gj.you.id);
  assert.equal(room.room.players.length, 1);
  guest.send({ t: 'leave' });
});

test('rooms clean themselves up when empty (leave, disconnect, grace expiry)', async () => {
  const a = await create('A');
  const b = await create('B');
  const c = await create('C');
  const codes = [a, b, c].map((x) => x.joined.room.code);
  assert.ok(codes.every((code) => server.manager.rooms.has(code)));
  a.send({ t: 'leave' });
  b.ws.terminate();
  c.ws.terminate();
  await sleep(100);
  assert.equal(server.manager.rooms.has(codes[0]), false, 'explicit leave removes the empty room immediately');
  assert.equal(server.manager.rooms.has(codes[1]), true, 'a dropped socket keeps the seat during the grace period');
  await sleep(1600); // > RECONNECT_GRACE_MS
  assert.equal(server.manager.rooms.has(codes[1]), false);
  assert.equal(server.manager.rooms.has(codes[2]), false);
});

test('abuse: bad JSON, oversized frames, unknown types and message floods do not crash the server', async () => {
  const c = await Client.connect('Abuser');
  c.ws.send('not json {{{');
  c.send({ t: 'nonsense' });
  c.send({ nothing: true });
  c.send({ t: 'dir', d: 'up' }); // not in a room: ignored
  c.ws.send('x'.repeat(5000));
  await sleep(200);
  assert.equal(c.closeCode, 1009, 'oversized payload closes the socket');

  const f = await Client.connect('Flooder');
  for (let i = 0; i < 600; i++) f.send({ t: 'ping', c: i });
  await sleep(300);
  assert.equal(f.closed, true, 'flooding client is disconnected');

  const ok = await create('StillWorks');
  assert.ok(ok.joined.room.code);
});

test('origin check: unknown web origins are refused, known ones accepted', async () => {
  await assert.rejects(Client.connect('Evil', { headers: { Origin: 'https://evil.example' } }));
  const good = await Client.connect('Pages', { headers: { Origin: 'https://kavibz26.github.io' } });
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

test('health endpoint reports rooms and players', async () => {
  const res = await fetch(url.replace('ws://', 'http://') + '/health');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.protocol, PROTOCOL_VERSION);
  assert.equal(typeof body.rooms, 'number');
});

