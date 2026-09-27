import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, sleep, FAST, PROTOCOL_VERSION } from './helpers.js';
import { SOLO_BOT_COUNT, BOT_NAMES } from '../bots/config.js';
import { fromMultiplayer } from '../../js/profile/results.js';
import { Profile } from '../../js/profile/profile.js';

// Server-authoritative AI bots: fill a solo human's lobby so a match is always playable, run entirely
// on the server (never in a client), obey exactly the same rules as any other snake, and never touch a
// human's profile/XP beyond the human's own normal in-match performance. Bots are OFF by default for
// every OTHER test file in this suite (LobbyManager defaults botsEnabled to false) - this file is the
// one place that turns them on, so nothing here can change behaviour anywhere else.
const h = harness({ ...FAST, botsEnabled: true, botDifficulty: 'normal' });
h.hooks();

const botsOf = (players) => players.filter((p) => p.bot);
const humansOf = (players) => players.filter((p) => !p.bot);

// A lone human joins an empty lobby and waits for the match to actually start.
async function soloMatch(lobby = 'lobby-1') {
  const host = await h.enter('Solo', { lobby });
  const match = await host.waitFor('match');
  return { host, hostId: host.joined.you.id, match, lobby };
}

test('an empty lobby fills with bots the moment a lone human joins', async () => {
  const host = await h.enter('Solo');
  const { players } = host.joined.lobby;
  assert.equal(humansOf(players).length, 1);
  assert.equal(botsOf(players).length, SOLO_BOT_COUNT);
  assert.equal(players.length, 1 + SOLO_BOT_COUNT);
});

test('bot count starts at exactly 3 for a single human', () => {
  assert.equal(SOLO_BOT_COUNT, 3);
});

test('bots plus humans never exceed the lobby cap; further joins are refused once full', async () => {
  const host = await h.enter('Solo'); // 1 human + 3 bots = 4
  assert.equal(host.joined.lobby.players.length, 4);
  await h.enter('B', { lobby: 'lobby-1' }); // 5
  const c = await h.enter('C', { lobby: 'lobby-1' }); // 6: full
  assert.equal(c.joined.lobby.players.length, 6);
  await assert.rejects(h.enter('D', { lobby: 'lobby-1' }), (err) => err.code === 'lobby_full');
});

test('bot identities are deterministic, drawn from the bot pool, and never collide with a human name', async () => {
  const host = await h.enter('Solo');
  const bots = botsOf(host.joined.lobby.players);
  assert.deepEqual(bots.map((p) => p.name), BOT_NAMES.slice(0, SOLO_BOT_COUNT));
  for (const b of bots) assert.ok(b.id.startsWith('b_'), 'bot ids are distinguishable from human ids');
});

test('a human claiming a bot\'s usual name first still gets a unique name for both (Lobby._uniqueName applies to bots too)', async () => {
  const named = await h.enter('Viper');
  const bots = botsOf(named.joined.lobby.players);
  assert.equal(bots.some((p) => p.name === 'Viper 2'), true, bots.map((p) => p.name).join(','));
});

test('a lone human does not have to wait for a second human - the match starts on its own', async () => {
  const { match, hostId } = await soloMatch();
  assert.equal(match.players.length, 1 + SOLO_BOT_COUNT);
  assert.equal(match.you, hostId);
  assert.equal(h.lobby().state, 'running');
});

test('a client cannot control a bot: forged input never reaches it, and the connection survives', async () => {
  const { host } = await soloMatch();
  await host.waitFor('snap', (m) => m.tick >= 1);
  const sim = h.lobby().match;
  const botId = [...sim.byId.keys()].find((id) => sim.byId.get(id).isBot);
  for (const forged of [
    { t: 'input', seq: 1, dir: 'up', id: botId },
    { t: 'input', seq: 2, dir: 'left', target: botId, playerId: botId },
    { t: 'input', seq: 3, dir: 'down', bot: botId },
  ]) host.send(forged);
  await sleep(300);
  assert.equal(sim.byId.get(botId).lastSeq, 0, 'applyInput is only ever called with the sender\'s OWN id - a bot never receives one');
  assert.equal(host.closed, false);
});

test('bots move under their own decisions once the match is running', async () => {
  await soloMatch();
  const sim = h.lobby().match;
  const bot = sim.snakes.find((s) => s.isBot);
  const startHead = { ...bot.head };
  for (let i = 0; i < 20; i++) sim.tick();
  assert.notDeepEqual(bot.head, startHead, 'the bot actually moved on its own, with no client driving it');
});

test('a bot dies exactly like any other snake: no immunity, no extra cells, no extra speed', async () => {
  await soloMatch();
  const sim = h.lobby().match;
  const bot = sim.snakes.find((s) => s.isBot);
  // Corner it with no legal move at all (the AI actively avoids danger, so a single open wall is not
  // enough to force a death - block every one of its three non-reversing options: two with terrain,
  // one with the board edge) and confirm it dies through the exact same hitsTerrain path (js/collision.js)
  // every snake uses - nothing here is bot-specific.
  bot.body = [{ x: 0, y: 0 }];
  bot.direction = bot.pendingDirection = { x: 0, y: 1 }; // "up" (the reverse) is the only excluded candidate
  bot.inputBuffer = [];
  const before = bot.length;
  sim.obstacles.add('0,1'); // blocks "continue down"
  sim.obstacles.add('1,0'); // blocks "turn right"
  // "turn left" runs off the left edge of the board on its own.
  sim.tick();
  assert.equal(bot.alive, false);
  assert.equal(bot.length, before, 'no hidden growth, shield or immunity kept it alive');
});

test('bots never choose a direction into obstacle terrain (Blocks map)', async () => {
  await soloMatch('lobby-3'); // lobby-3 is configured for Blocks (see server/protocol.js)
  const sim = h.lobby('lobby-3').match;
  assert.equal(sim.mapId, 'blocks');
  assert.ok(sim.obstacles.size > 0, 'the map actually has obstacles to navigate around');
  for (let i = 0; i < 60; i++) {
    sim.tick();
    for (const s of sim.snakes) {
      if (!s.alive || !s.isBot) continue;
      assert.equal(sim.obstacles.has(`${s.head.x},${s.head.y}`), false, `a bot walked onto an obstacle at tick ${i}`);
    }
  }
});

test('bots collect ordinary food through the same authoritative pickup path as anyone else', async () => {
  await soloMatch();
  const sim = h.lobby().match;
  const bot = sim.snakes.find((s) => s.isBot);
  for (let i = 0; i < 200 && bot.foodEaten === 0 && bot.alive; i++) sim.tick();
  assert.ok(bot.foodEaten > 0, 'foraging eventually finds the food seeded near every spawn');
});

test('bots collect power-ups through the same authoritative pickup path as anyone else', async () => {
  await soloMatch();
  const sim = h.lobby().match;
  const bot = sim.snakes.find((s) => s.isBot);
  sim.specials.clear();
  // Cover every direction the bot could legally choose next (no reversal), so pickup is certain
  // regardless of which one decideBotDirection (or a difficulty "mistake") ends up picking.
  const { x, y } = bot.head;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    sim.specials.items.set(`${x + dx},${y + dy}`, { x: x + dx, y: y + dy, type: 'speed', born: sim.tickCount });
  }
  sim.tick();
  assert.ok(bot.powerupsCollected >= 1, 'the bot walked onto a power-up and collected it like any snake would');
});

test('bots are ranked on the leaderboard by the exact same rule as everyone else', async () => {
  await soloMatch();
  const sim = h.lobby().match;
  const bot = sim.snakes.find((s) => s.isBot);
  bot.score = 999999;
  const order = sim.leaderboardOrder();
  assert.equal(sim.snakes[order[0]], bot, 'highest score leads, whether it belongs to a human or a bot');
});

test('results include bots, correctly marked, alongside humans', async () => {
  const { hostId } = await soloMatch();
  const sim = h.lobby().match;
  const rows = sim.results();
  assert.equal(rows.length, 1 + SOLO_BOT_COUNT);
  const human = rows.find((r) => r.id === hostId);
  assert.equal(human.bot, false);
  const bots = rows.filter((r) => r.id !== hostId);
  assert.equal(bots.length, SOLO_BOT_COUNT);
  for (const b of bots) assert.equal(b.bot, true);
});

test('a human plus bots produces a normal, playable match end to end', async () => {
  const { host, match } = await soloMatch();
  assert.equal(match.snap.snakes.length, 1 + SOLO_BOT_COUNT);
  const snap = await host.waitFor('snap', (m) => m.tick >= 3);
  assert.ok(snap.snakes.length >= 1);
  assert.equal(host.closed, false);
});

test('multiple humans plus bots share the same match', async () => {
  await h.enter('Solo'); // triggers the bot fill and starts the lobby countdown
  const guest = await h.enter('Guest', { lobby: 'lobby-1' }); // joins while still in the countdown
  const m = await guest.waitFor('match');
  assert.equal(m.players.length, 2 + SOLO_BOT_COUNT);
  assert.equal(humansOf(m.players).length, 2);
});

test('a reconnecting human sees the exact same bots - no duplication, no reset, no identity change', async () => {
  const { host, hostId } = await soloMatch();
  const before = botsOf(host.joined.lobby.players).map((p) => `${p.id}:${p.name}:${p.skinId}`).sort();
  const { token } = host.joined.you;
  host.ws.terminate();
  await sleep(100);
  const back = await h.connect('Solo again');
  back.send({ t: 'rejoin', v: PROTOCOL_VERSION, lobby: 'lobby-1', id: hostId, token });
  const resumed = await back.waitFor('match');
  const after = botsOf(resumed.players).map((p) => `${p.id}:${p.name}:${p.skinId}`).sort();
  assert.deepEqual(after, before);
  assert.equal(resumed.resumed, true);
});

test('a human leaving mid-match does not affect the bots; they keep playing', async () => {
  const host = await h.enter('Solo'); // triggers the bot fill and starts the lobby countdown
  const guest = await h.enter('Guest', { lobby: 'lobby-1' }); // joins while still in the countdown
  await Promise.all([host.waitFor('match'), guest.waitFor('match')]);
  const sim = h.lobby().match;
  const botIdsBefore = sim.snakes.filter((s) => s.isBot).map((s) => s.playerId).sort();
  await host.leave();
  await sleep(50);
  assert.equal(h.lobby().state, 'running', 'a human remains, so the match continues normally');
  const botIdsAfter = sim.snakes.filter((s) => s.isBot).map((s) => s.playerId).sort();
  assert.deepEqual(botIdsAfter, botIdsBefore);
});

test('when every human leaves, the match ends right away instead of running on with only bots', async () => {
  const { host } = await soloMatch();
  await host.leave();
  await sleep(50);
  assert.equal(h.lobby().state, 'waiting', 'no orphaned bots-only match is left running');
  assert.equal(h.lobby().players.size, 0);
  assert.equal(h.lobby().match, null);
});

test('a new human joining after that reset gets a fresh, clean bot fill', async () => {
  const first = await h.enter('Solo');
  await first.leave();
  await sleep(50);
  const second = await h.enter('SoloAgain');
  const { players } = second.joined.lobby;
  assert.equal(humansOf(players).length, 1);
  assert.equal(botsOf(players).length, SOLO_BOT_COUNT);
});

test('no duplicate bots are ever added to the same lobby occupancy', async () => {
  const host = await h.enter('Solo');
  assert.equal(botsOf(host.joined.lobby.players).length, SOLO_BOT_COUNT);
  const guest = await h.enter('Guest', { lobby: 'lobby-1' });
  assert.equal(botsOf(guest.joined.lobby.players).length, SOLO_BOT_COUNT, 'a second human does not trigger another fill');
});

test('no duplicate bot identities within one lobby', async () => {
  const host = await h.enter('Solo');
  const bots = botsOf(host.joined.lobby.players);
  assert.equal(new Set(bots.map((p) => p.id)).size, bots.length);
  assert.equal(new Set(bots.map((p) => p.name)).size, bots.length);
});

test('a bot cannot contaminate a human profile: XP and rewards come only from the human\'s own results row', async () => {
  const { hostId } = await soloMatch();
  const sim = h.lobby().match;
  const human = sim.byId.get(hostId);
  const bot = sim.snakes.find((s) => s.isBot);
  human.score = 500;
  bot.score = 999999; // the bot "wins" on paper - must never leak into the human's own reward numbers
  bot.foodEaten = 999;
  for (const s of sim.snakes) if (s !== human) s.alive = false; // end the match: human is last standing
  sim.tick();
  assert.equal(sim.over, true);
  assert.equal(sim.winnerId, hostId);

  const over = { winnerId: sim.winnerId, reason: sim.endReason, results: sim.results(), events: sim.eventSummary() };
  const res = fromMultiplayer(over, hostId, 'k1', 30);
  assert.equal(res.score, human.score, 'the human\'s own score, never the bot\'s');
  assert.notEqual(res.food, bot.foodEaten, 'food is derived from the human\'s OWN score, not any bot\'s foodEaten');

  const profile = new Profile({ storage: { getItem: () => null, setItem() {} }, now: () => 1, schedule: () => 1, cancel: () => {} });
  const summary = profile.applyMatchResult(res);
  assert.ok(summary);
  assert.equal(profile.stats.highestScore, human.score);
  assert.notEqual(profile.stats.highestScore, bot.score);
});

test('match events involving bots: attribution works normally but stay out of the human\'s own history', async () => {
  const { hostId } = await soloMatch();
  const sim = h.lobby().match;
  const bots = sim.snakes.filter((s) => s.isBot);
  sim.matchEvents.noteKill(bots[0].playerId, bots[1].playerId, sim.tickCount);
  const summary = sim.eventSummary();
  const fb = summary.find((e) => e.k === 'first_blood');
  assert.equal(fb.id, bots[0].playerId, 'First Blood can identify a bot as the killer');
  assert.equal(fb.v, bots[1].playerId);
  const human = fromMultiplayer({ winnerId: hostId, reason: 'last_standing', results: sim.results(), events: summary }, hostId, 'k2', 10);
  assert.deepEqual(human.events, [], 'the bot-vs-bot kill is never the human\'s event');
});

for (const [lobbyId, mapId] of [['lobby-1', 'classic'], ['lobby-3', 'blocks'], ['lobby-5', 'arena']]) {
  test(`bots work on the ${mapId} map`, async () => {
    const { match } = await soloMatch(lobbyId);
    assert.equal(match.map, mapId);
    const sim = h.lobby(lobbyId).match;
    assert.equal(sim.hasBots, true);
    for (let i = 0; i < 10; i++) sim.tick();
    assert.ok(sim.snakes.some((s) => s.isBot));
  });
}

test('forged bot-shaped protocol messages are ignored and never crash the connection', async () => {
  const { host } = await soloMatch();
  const sim = h.lobby().match;
  const before = sim.matchEvents.summary().length;
  for (const forged of [
    { t: 'bot', id: 'b_forged', dir: 'up' },
    { t: 'addBot', lobby: 'lobby-1' },
    { t: 'input', seq: 1, dir: 'up', bot: true },
    { t: 'sync', bot: 'b_forged' },
  ]) host.send(forged);
  await sleep(200);
  assert.equal(host.closed, false);
  assert.equal(sim.matchEvents.summary().length, before);
});
