import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, sleep, FAST, PROTOCOL_VERSION } from './helpers.js';
import { Profile } from '../../js/profile/profile.js';
import { fromMultiplayer } from '../../js/profile/results.js';
import { validateNickname } from '../../js/profile/store.js';
import { REWARDS } from '../../js/profile/config.js';

// Multiplayer progression against the REAL server: names round-trip, rewards come only from the
// server's `over` message, and a match pays out exactly once (also across a reconnect).
const h = harness(FAST);
h.hooks();

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
}
const newProfile = () => new Profile({ storage: new FakeStorage(), now: () => 1, random: () => 0.5, schedule: () => 1, cancel: () => {} });

// The same bridge js/main.js uses: one key per match, consumed on the first `over`.
function bridge(profile) {
  let key = null;
  return {
    start(resumed) { if (resumed && key) return; key = `mp:${Math.random()}`; },
    over(msg, myId, seconds = 60) {
      const k = key;
      key = null;
      if (!k) return null;
      const result = fromMultiplayer(msg, myId, k, seconds);
      return result ? profile.applyMatchResult(result) : null;
    },
  };
}

test('the profile nickname is the name everyone sees: lobby roster, match start and results', async () => {
  const nick = validateNickname('  Nova   7  ').value;
  assert.equal(nick, 'Nova 7');
  const host = await h.enter(nick, { skin: 'classic' });
  const guest = await h.enter('Rival', { skin: 'inferno' });
  const roster = await host.waitFor('lobby', (m) => m.lobby.players.length === 2);
  assert.ok(roster.lobby.players.some((p) => p.name === nick), 'roster shows the nickname');
  const match = await host.waitFor('match');
  assert.ok(match.players.some((p) => p.name === nick), 'match start shows the nickname');
  guest.send({ t: 'leave' });
  const over = await host.waitFor('over');
  assert.ok(over.results.some((r) => r.name === nick), 'results show the nickname');
  assert.ok(JSON.stringify(over).indexOf(host.joined.you.token) === -1, 'no reconnect token or other secret leaks into the results');
});

test('an authoritative result grants progression exactly once, and never from a duplicated over message', async () => {
  const { host, guest, hostId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  const profile = newProfile();
  const b = bridge(profile);
  b.start(false);
  guest.send({ t: 'leave' }); // the opponent forfeits: the host wins, decided by the server
  const over = await host.waitFor('over');
  assert.equal(over.winnerId, hostId);

  const first = b.over(over, hostId);
  assert.ok(first, 'first result is applied');
  assert.equal(first.rewards.items.some((i) => i.id === 'victory'), true, 'the win comes from the server (winnerId)');
  const xp = profile.xp;
  assert.ok(xp >= REWARDS.multiplayer.victory);
  assert.equal(profile.stats.multiplayerGames, 1);
  assert.equal(profile.stats.multiplayerWins, 1);
  assert.equal(profile.stats.gamesPlayed, 1);

  for (let i = 0; i < 4; i++) assert.equal(b.over(over, hostId), null, 'a replayed over message pays nothing');
  assert.equal(profile.xp, xp);
  assert.equal(profile.stats.multiplayerGames, 1);
});

test('reconnecting mid-match keeps the same match, and the reconnected player is rewarded once at the end', async () => {
  const { host, guest, hostId, guestId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  const profile = newProfile();
  const b = bridge(profile);
  b.start(false);
  const { token } = host.joined.you;
  host.ws.terminate();
  await guest.waitFor('lobby', (m) => m.lobby.players.some((p) => p.id === hostId && !p.connected));
  const back = await h.connect('Alice again');
  back.send({ t: 'rejoin', v: PROTOCOL_VERSION, lobby: 'lobby-1', id: hostId, token });
  const resumed = await back.waitFor('match');
  assert.equal(resumed.resumed, true);
  b.start(resumed.resumed); // the UI treats the resumed match as the SAME match
  assert.equal(profile.stats.gamesPlayed, 0, 'nothing is paid at reconnect time');

  guest.send({ t: 'leave' });
  const over = await back.waitFor('over');
  assert.equal(over.results.filter((r) => r.id === hostId).length, 1, 'the reconnected player appears exactly once in the results');
  assert.ok(b.over(over, hostId));
  assert.equal(b.over(over, hostId), null);
  assert.equal(profile.stats.gamesPlayed, 1);
  assert.equal(profile.stats.multiplayerGames, 1);
  void guestId;
});

test('a player who is not in the results (left before the end) earns nothing', async () => {
  const { host, guest, hostId, guestId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  guest.send({ t: 'leave' });
  const over = await host.waitFor('over');
  const profile = newProfile();
  const b = bridge(profile);
  b.start(false);
  // The leaver's results (if the server listed them) still come from the server; a stranger's id gets nothing.
  assert.equal(b.over(over, 'p_not_in_this_match'), null);
  assert.equal(profile.xp, 0);
  assert.equal(profile.stats.gamesPlayed, 0);
  void hostId; void guestId;
});

test('the client cannot claim rewards: progression messages are not part of the protocol, and results never echo client-supplied numbers', async () => {
  const { host, guest, hostId } = await h.startedMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  for (const forged of [
    { t: 'result', kills: 99, xp: 99999, level: 50, wins: 10 },
    { t: 'profile', xp: 99999 },
    { t: 'over', winnerId: hostId, results: [{ id: hostId, rank: 1, score: 99999, kills: 99, length: 500, survived: true }] },
    { t: 'input', seq: 1, dir: 'up', score: 99999, kills: 99, xp: 99999 },
  ]) host.send(forged);
  await sleep(200);
  guest.send({ t: 'leave' });
  const over = await host.waitFor('over');
  const me = over.results.find((r) => r.id === hostId);
  assert.ok(me.score < 500 && me.kills === 0 && me.length < 100, `server-computed figures only (score ${me.score}, kills ${me.kills}, length ${me.length})`);
  assert.equal(host.closed, false, 'forged messages are ignored, not fatal');
});

test('multiplayer food XP is derived from the server score, so a fabricated kills/food count cannot raise it', () => {
  const profile = newProfile();
  const over = { winnerId: 'a', reason: 'last_standing', results: [{ id: 'a', rank: 1, name: 'A', score: 60, length: 10, kills: 0, survived: true }, { id: 'b', rank: 2, name: 'B', score: 0, length: 7, kills: 0, survived: false }] };
  const r = profile.applyMatchResult(fromMultiplayer(over, 'a', 'k1', 60));
  const food = r.rewards.items.find((i) => i.id === 'food');
  assert.equal(food.count, 6, '60 points = 6 food');
  assert.equal(food.xp, 6 * REWARDS.multiplayer.foodEach);
});
