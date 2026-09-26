import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONFIG } from '../../js/config.js';
import { MATCH_EVENTS, EVENT_IDS, isEventId } from '../../js/events/config.js';
import { MatchEvents } from '../../js/events/tracker.js';
import { MatchSim } from '../match.js';
import { Profile } from '../../js/profile/profile.js';
import { fromSinglePlayer, fromMultiplayer } from '../../js/profile/results.js';
import { STORAGE_KEY } from '../../js/profile/config.js';
import { collectSpecial } from '../../js/powerups/effects.js';

globalThis.window ??= { devicePixelRatio: 1 };
const { Game } = await import('../../js/game.js');

// --- helpers ------------------------------------------------------------------------------------------
const snake = (id, o = {}) => ({ id, alive: true, length: 7, foodEaten: 0, powerupsCollected: 0, megaCollected: 0, eliminations: 0, ...o });
const idOf = (s) => s.id;
const kinds = (ev) => ev.map((e) => `${e.k}:${e.id}`);
const SURVIVE_TICKS = Math.round((MATCH_EVENTS.survivor.seconds * 1000) / CONFIG.TICK_MS);

test('the event set is exactly the eight requested, each defined once with a name, icon and prominence', () => {
  assert.deepEqual(EVENT_IDS, ['first_blood', 'food_hunter', 'power_collector', 'giant_snake', 'survivor', 'longest_snake', 'most_food', 'comeback']);
  for (const id of EVENT_IDS) {
    const d = MATCH_EVENTS[id];
    assert.ok(d.name && d.icon && ['major', 'minor'].includes(d.prominence), id);
  }
  assert.equal(MATCH_EVENTS.first_blood.prominence, 'major', 'First Blood is the prominent one');
  assert.equal(isEventId('first_blood'), true);
  for (const bad of ['nope', '', null, 7, '__proto__', 'constructor']) assert.equal(isEventId(bad), false, String(bad));
});

// ---- each trigger ---------------------------------------------------------------------------------------

test('First Blood: the first elimination of the match, once for the whole match, with killer and victim', () => {
  const ev = new MatchEvents();
  ev.noteKill('a', 'b', 12);
  assert.deepEqual(ev.drain().map((e) => ({ k: e.k, id: e.id, v: e.v, t: e.t })), [{ k: 'first_blood', id: 'a', v: 'b', t: 12 }]);
  ev.noteKill('c', 'd', 30);
  ev.noteKill('a', 'c', 31);
  assert.deepEqual(ev.drain(), [], 'later kills are not First Blood');
  assert.equal(ev.summary().filter((e) => e.k === 'first_blood').length, 1);
});

test('First Blood also fires from state alone if a kill path skipped noteKill (safety net)', () => {
  const ev = new MatchEvents();
  const a = snake('a');
  ev.update(5, [a, snake('b')], idOf);
  assert.deepEqual(ev.drain(), []);
  a.eliminations = 1;
  ev.update(6, [a, snake('b')], idOf);
  assert.deepEqual(kinds(ev.drain()), ['first_blood:a']);
});

test('Food Hunter: exactly at the configured amount of normal food, not before', () => {
  const n = MATCH_EVENTS.food_hunter.food;
  const ev = new MatchEvents();
  const a = snake('a', { foodEaten: n - 1 });
  ev.update(1, [a, snake('b')], idOf);
  assert.deepEqual(ev.drain(), []);
  a.foodEaten = n;
  ev.update(2, [a, snake('b')], idOf);
  assert.deepEqual(kinds(ev.drain()), ['food_hunter:a']);
});

test('Power Collector: power-ups and Mega Food both count toward the configured number', () => {
  const n = MATCH_EVENTS.power_collector.powerups;
  const ev = new MatchEvents();
  const a = snake('a', { powerupsCollected: n - 2, megaCollected: 1 });
  ev.update(1, [a, snake('b')], idOf);
  assert.deepEqual(ev.drain(), []);
  a.powerupsCollected = n - 1;
  ev.update(2, [a, snake('b')], idOf);
  assert.deepEqual(kinds(ev.drain()), ['power_collector:a']);
});

test('Giant Snake: at the configured length', () => {
  const n = MATCH_EVENTS.giant_snake.length;
  const ev = new MatchEvents();
  const a = snake('a', { length: n - 1 });
  ev.update(1, [a, snake('b')], idOf);
  assert.deepEqual(ev.drain(), []);
  a.length = n;
  ev.update(2, [a, snake('b')], idOf);
  assert.deepEqual(kinds(ev.drain()), ['giant_snake:a']);
});

test('Survivor: only for a snake still alive when the configured time is reached', () => {
  const ev = new MatchEvents();
  const a = snake('a');
  const dead = snake('b', { alive: false });
  ev.update(SURVIVE_TICKS - 1, [a, dead], idOf);
  assert.deepEqual(ev.drain(), []);
  ev.update(SURVIVE_TICKS, [a, dead], idOf);
  assert.deepEqual(kinds(ev.drain()), ['survivor:a'], 'the dead snake earns nothing');
  assert.equal(SURVIVE_TICKS, 400, '60 seconds at the 150ms tick');
});

test('Longest Snake (final): the longest peak wins, ties share it, and it must beat the minimum', () => {
  const min = MATCH_EVENTS.longest_snake.minLength;
  const ev = new MatchEvents();
  const a = snake('a', { length: min + 6 });
  const b = snake('b', { length: min + 2 });
  ev.update(10, [a, b], idOf);
  b.alive = false; // b dies but a's peak still stands
  ev.finalize([a, b], idOf, 20);
  assert.deepEqual(kinds(ev.drain().filter((e) => e.k === 'longest_snake')), ['longest_snake:a']);

  const tie = new MatchEvents();
  const x = snake('x', { length: min + 3 });
  const y = snake('y', { length: min + 3 });
  tie.update(1, [x, y], idOf);
  tie.finalize([x, y], idOf, 2);
  assert.deepEqual(kinds(tie.drain().filter((e) => e.k === 'longest_snake')).sort(), ['longest_snake:x', 'longest_snake:y']);

  const small = new MatchEvents();
  const p = snake('p', { length: min });
  small.update(1, [p, snake('q')], idOf);
  small.finalize([p, snake('q')], idOf, 2);
  assert.equal(small.drain().some((e) => e.k === 'longest_snake'), false, 'a trivially short "longest" snake earns nothing');
});

test('Longest Snake uses the PEAK length: a snake that was longest and then died still counts', () => {
  const min = MATCH_EVENTS.longest_snake.minLength;
  const ev = new MatchEvents();
  const a = snake('a', { length: min + 8 });
  const b = snake('b', { length: min + 3 });
  ev.update(5, [a, b], idOf);
  a.alive = false;
  a.length = 2; // whatever is left of it after death
  ev.finalize([a, b], idOf, 9);
  assert.ok(ev.drain().some((e) => e.k === 'longest_snake' && e.id === 'a'));
});

test('Most Food (final): most normal food, ties share it, minimum required', () => {
  const min = MATCH_EVENTS.most_food.minFood;
  const ev = new MatchEvents();
  const a = snake('a', { foodEaten: min + 2 });
  const b = snake('b', { foodEaten: min });
  ev.finalize([a, b], idOf, 30);
  assert.deepEqual(kinds(ev.drain().filter((e) => e.k === 'most_food')), ['most_food:a']);
  const tie = new MatchEvents();
  tie.finalize([snake('x', { foodEaten: min }), snake('y', { foodEaten: min })], idOf, 1);
  assert.equal(tie.drain().filter((e) => e.k === 'most_food').length, 2);
  const low = new MatchEvents();
  low.finalize([snake('x', { foodEaten: min - 1 }), snake('y', { foodEaten: 0 })], idOf, 1);
  assert.equal(low.drain().some((e) => e.k === 'most_food'), false);
});

test('final events need someone to compare against (a one-snake match awards nothing)', () => {
  const ev = new MatchEvents();
  ev.finalize([snake('a', { length: 40, foodEaten: 30 })], idOf, 5);
  assert.deepEqual(ev.drain(), []);
});

test('Comeback: from the bottom third of the ranking to first place with a real gain - and not otherwise', () => {
  const start = MATCH_EVENTS.comeback.startAfterTicks;
  const every = MATCH_EVENTS.comeback.sampleEveryTicks;
  const at = (n) => Math.ceil(n / every) * every; // a sampled tick
  const mk = () => [snake('a', { length: 6 }), snake('b', { length: 12 }), snake('c', { length: 14 }), snake('d', { length: 16 })];

  const ev = new MatchEvents();
  const s = mk();
  ev.update(at(start), s, idOf); // a is last of four: "low" recorded
  assert.deepEqual(ev.drain(), []);
  s[0].length = 20; // a grows past everyone, +14
  ev.update(at(start) + every, s, idOf);
  assert.deepEqual(kinds(ev.drain()), ['comeback:a']);
  s[0].length = 25;
  ev.update(at(start) + 2 * every, s, idOf);
  assert.deepEqual(ev.drain().filter((e) => e.k === 'comeback'), [], 'once per snake');

  // never low -> no comeback
  const e2 = new MatchEvents();
  const t = [snake('a', { length: 15 }), snake('b', { length: 12 }), snake('c', { length: 14 }), snake('d', { length: 13 })];
  e2.update(at(start), t, idOf);
  t[0].length = 30;
  e2.update(at(start) + every, t, idOf);
  assert.deepEqual(e2.drain().filter((e) => e.k === 'comeback'), []);

  // low but only a small gain -> no comeback
  const e3 = new MatchEvents();
  const u = [snake('a', { length: 10 }), snake('b', { length: 12 }), snake('c', { length: 14 }), snake('d', { length: 16 })];
  e3.update(at(start), u, idOf);
  u[0].length = 17; // first place, but only +7... make the gain too small instead:
  e3.update(at(start) + every, u, idOf);
  assert.ok(u[0].length - 10 >= MATCH_EVENTS.comeback.minLengthGain, 'sanity: this gain is big enough');
  assert.deepEqual(kinds(e3.drain().filter((e) => e.k === 'comeback')), ['comeback:a']);
  const e4 = new MatchEvents();
  const w = [snake('a', { length: 13 }), snake('b', { length: 14 }), snake('c', { length: 15 }), snake('d', { length: 16 })];
  e4.update(at(start), w, idOf);
  w[0].length = 17; // +4 < minLengthGain
  e4.update(at(start) + every, w, idOf);
  assert.deepEqual(e4.drain().filter((e) => e.k === 'comeback'), [], 'a small gain is not a comeback');

  // too few players / too early / off-sample ticks
  const e5 = new MatchEvents();
  const two = [snake('a', { length: 5 }), snake('b', { length: 30 })];
  e5.update(at(start), two, idOf);
  two[0].length = 40;
  e5.update(at(start) + every, two, idOf);
  assert.deepEqual(e5.drain().filter((e) => e.k === 'comeback'), [], 'needs at least 3 snakes alive');
  const e6 = new MatchEvents();
  const early = mk();
  e6.update(every, early, idOf); // before startAfterTicks
  early[0].length = 40;
  e6.update(at(start), early, idOf);
  assert.deepEqual(e6.drain().filter((e) => e.k === 'comeback'), [], 'the low point must be recorded first (after the warm-up)');
});

// ---- once only, determinism, configurability ----------------------------------------------------------------

test('events fire only once per match: repeated updates, finalize and drain never repeat one', () => {
  const ev = new MatchEvents();
  const a = snake('a', { foodEaten: 50, length: 40, powerupsCollected: 9 });
  const b = snake('b');
  for (let t = 1; t <= 600; t++) ev.update(t, [a, b], idOf);
  ev.finalize([a, b], idOf, 601);
  ev.finalize([a, b], idOf, 602);
  const all = kinds(ev.summary());
  assert.equal(new Set(all).size, all.length, `no duplicates in ${all.join(', ')}`);
  assert.equal(ev.drain().length, all.length, 'everything fired is delivered exactly once');
  assert.deepEqual(ev.drain(), []);
});

test('events are deterministic: the same states produce the same events in the same order', () => {
  const run = () => {
    const ev = new MatchEvents();
    const a = snake('a');
    const b = snake('b');
    for (let t = 1; t <= 500; t++) {
      a.foodEaten = Math.floor(t / 20);
      b.length = 7 + Math.floor(t / 15);
      if (t === 100) ev.noteKill('a', 'b', t);
      ev.update(t, [a, b], idOf);
    }
    ev.finalize([a, b], idOf, 500);
    return JSON.stringify(ev.summary());
  };
  assert.equal(run(), run());
});

test('thresholds come from the config (a custom config changes when events fire)', () => {
  const cfg = { ...MATCH_EVENTS, food_hunter: { ...MATCH_EVENTS.food_hunter, food: 2 } };
  const ev = new MatchEvents({ config: cfg });
  const a = snake('a', { foodEaten: 2 });
  ev.update(1, [a, snake('b')], idOf);
  assert.deepEqual(kinds(ev.drain()), ['food_hunter:a']);
});

test('the tracker is cheap: one pass over the snakes per tick (no board scans, no growth over a long match)', () => {
  const ev = new MatchEvents();
  const snakes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => snake(id, { length: 7 + i }));
  for (let t = 1; t <= 5000; t++) ev.update(t, snakes, idOf);
  assert.ok(ev.log.length <= EVENT_IDS.length * 6, 'bounded by (events x players)');
  assert.equal(ev.stats.size, 6);
});

// ---- server simulation: authoritative, synchronised through the snapshot ----------------------------------------

const ENTRIES = [{ id: 'a', name: 'A', skinId: 'classic' }, { id: 'b', name: 'B', skinId: 'inferno' }];
function quietSim() {
  const sim = new MatchSim(ENTRIES);
  sim.food.items.clear();
  sim.food.target = 0;
  sim.specials.clear();
  sim.specials.cooldown = 1e9;
  const place = (id, head, dirName, length) => {
    const s = sim.byId.get(id);
    const d = CONFIG.DIRECTIONS[dirName];
    s.body = Array.from({ length }, (_, i) => ({ x: head.x - d.x * i, y: head.y - d.y * i }));
    s.direction = s.pendingDirection = d;
    s.inputBuffer = [];
    s.growPending = 0;
  };
  place('a', { x: 20, y: 30 }, 'right', 7);
  place('b', { x: 60, y: 45 }, 'left', 7);
  sim._commitBaseline();
  return sim;
}
const mevs = (sim) => sim.events.filter((e) => e.e === 'mev');

test('server: milestones are derived from the simulation\'s own state and travel in the snapshot events', () => {
  const sim = quietSim();
  sim.byId.get('a').foodEaten = MATCH_EVENTS.food_hunter.food;
  sim.tick();
  assert.deepEqual(mevs(sim), [{ e: 'mev', k: 'food_hunter', id: 'a' }]);
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  assert.deepEqual(snap.ev.filter((e) => e.e === 'mev'), [{ e: 'mev', k: 'food_hunter', id: 'a' }]);
  sim.tick();
  assert.deepEqual(mevs(sim), [], 'not repeated on later ticks');
  assert.deepEqual(JSON.parse(JSON.stringify(sim.snapshot({ full: true }))).ev, [], 'a full snapshot (rejoin / resync) never replays events');
});

test('server: a real elimination fires First Blood with killer and victim', () => {
  const sim = quietSim();
  sim.byId.get('a').body = Array.from({ length: 12 }, (_, i) => ({ x: 20 - i, y: 30 })); // a is bigger
  sim.byId.get('b').body = Array.from({ length: 5 }, (_, i) => ({ x: 21, y: 28 + i })); // b crosses a's path
  sim.setFrozen('b', true);
  sim.tick();
  assert.equal(sim.byId.get('b').alive, false);
  assert.deepEqual(mevs(sim).filter((e) => e.k === 'first_blood'), [{ e: 'mev', k: 'first_blood', id: 'a', v: 'b' }]);
  assert.equal(sim.over, true, 'b was the last opponent: the match ended, so the final events were decided on the same tick');
});

test('server: match-end events (Longest Snake, Most Food) are decided at the end and included in the summary', () => {
  const sim = quietSim();
  const a = sim.byId.get('a');
  a.body = Array.from({ length: 16 }, (_, i) => ({ x: 20 - i, y: 30 }));
  a.foodEaten = 6;
  sim.tick();
  sim.forfeit('b'); // b leaves: a is the last snake standing
  sim.tick();
  assert.equal(sim.over, true);
  const final = kinds(sim.eventSummary());
  assert.ok(final.includes('longest_snake:a'));
  assert.ok(final.includes('most_food:a'));
  assert.ok(mevs(sim).some((e) => e.k === 'longest_snake'), 'the final events also ride in the last snapshot');
  assert.equal(new Set(final).size, final.length);
});

test('server: Speed / Magnet / Shield / Mega pickups count toward Power Collector', () => {
  const sim = quietSim();
  const a = sim.byId.get('a');
  collectSpecial(a, 'speed');
  collectSpecial(a, 'magnet');
  collectSpecial(a, 'mega');
  sim.tick();
  assert.deepEqual(kinds(sim.eventSummary()), ['power_collector:a']);
});

// ---- single player ---------------------------------------------------------------------------------------------------

function makeGame() {
  const game = new Game({ width: 0, height: 0, getContext: () => ({ scale() {} }) }, { update() {} });
  game.init();
  const player = game.playerSnake;
  const ai = game.snakes.find((s) => !s.isPlayer);
  game.snakes = [player, ai];
  player.body = Array.from({ length: 7 }, (_, i) => ({ x: 20 - i, y: 30 }));
  player.direction = player.pendingDirection = CONFIG.DIRECTIONS.right;
  ai.body = Array.from({ length: 7 }, (_, i) => ({ x: 70 + (i % 5), y: 5 + Math.floor(i / 5) * 2 }));
  ai.direction = ai.pendingDirection = CONFIG.DIRECTIONS.left;
  game.food.items.clear();
  game.food.target = 0;
  game.specials.clear();
  game.specials.cooldown = 1e9;
  const seen = [];
  game.onMatchEvent = (e) => seen.push(e);
  return { game, player, ai, seen };
}

test('single player: the player\'s milestones fire once, from the game\'s own state', () => {
  const { game, player, seen } = makeGame();
  player.foodEaten = MATCH_EVENTS.food_hunter.food;
  game.tick();
  game.tick();
  assert.deepEqual(seen.filter((e) => e.id === player.id).map((e) => e.k), ['food_hunter']);
});

test('single player: First Blood reports killer and victim, and names resolve ("You" / the AI\'s skin)', () => {
  const { game, player, ai, seen } = makeGame();
  game._creditKill(player, ai);
  game._emitMatchEvents();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].k, 'first_blood');
  assert.equal(game.eventName(seen[0].id), 'You');
  assert.equal(game.eventName(seen[0].v), ai.skin.name);
});

test('single player: AI activity counts for the match, but only the player\'s events reach the player\'s profile', () => {
  const { game, player, ai, seen } = makeGame();
  ai.foodEaten = MATCH_EVENTS.food_hunter.food;
  player.foodEaten = 2;
  game.tick();
  assert.ok(seen.some((e) => e.id === ai.id && e.k === 'food_hunter'), 'the AI\'s milestone is recorded for the match');
  assert.equal(seen.some((e) => e.id === player.id), false);
  let over = null;
  game.onGameOver = (r) => { over = r; };
  game._endGame(false);
  assert.ok(over.events.some((e) => e.id === ai.id));
  const result = fromSinglePlayer(over, 'run-1');
  assert.deepEqual(result.events, [], 'nothing of the AI\'s is credited to the player');
});

test('single player: the game over payload carries the player id and every event, and the profile records the player\'s once', () => {
  const { game, player } = makeGame();
  player.foodEaten = MATCH_EVENTS.food_hunter.food;
  game.tick();
  let over = null;
  game.onGameOver = (r) => { over = r; };
  game._endGame(true);
  assert.equal(over.playerId, player.id);
  const profile = new Profile({ storage: { getItem: () => null, setItem() {} }, now: () => 1, schedule: () => 1, cancel: () => {} });
  const res = fromSinglePlayer(over, 'run-2');
  assert.ok(res.events.includes('food_hunter'));
  assert.ok(profile.applyMatchResult(res));
  assert.equal(profile.stats.eventsEarned, res.events.length);
  assert.equal(profile.applyMatchResult(res), null, 'the same result cannot be recorded twice');
  assert.equal(profile.stats.eventsEarned, res.events.length);
});

test('AI never target events: the AI module knows nothing about them', () => {
  const src = fs.readFileSync(new URL('../../js/ai.js', import.meta.url), 'utf8');
  assert.equal(/matchEvents|first_blood|MATCH_EVENTS|events\//.test(src), false);
});

test('restarting a run starts a fresh event history', () => {
  const { game, player } = makeGame();
  player.foodEaten = MATCH_EVENTS.food_hunter.food;
  game.tick();
  assert.ok(game.matchEvents.summary().length > 0);
  game.init();
  assert.equal(game.matchEvents.summary().length, 0);
  const seen = [];
  game.onMatchEvent = (e) => seen.push(e);
  game.playerSnake.foodEaten = MATCH_EVENTS.food_hunter.food;
  game.tick();
  assert.ok(seen.some((e) => e.k === 'food_hunter'), 'the milestone can fire again in the new run');
});

// ---- profile ------------------------------------------------------------------------------------------------------------

const fakeStorage = () => {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
};
const mkProfile = (storage) => new Profile({ storage, now: () => 1, schedule: () => 1, cancel: () => {} });
const base = { mode: 'single', victory: false, survived: false, score: 0, length: 7, kills: 0, food: 0, playSeconds: 5 };

test('profile: events are recorded with the match result, counted by id, and persisted', () => {
  const storage = fakeStorage();
  const p = mkProfile(storage);
  const xpBefore = p.xp;
  p.applyMatchResult({ ...base, key: 'm1', events: ['first_blood', 'survivor', 'first_blood'] });
  assert.equal(p.stats.eventsEarned, 2, 'duplicates inside one result count once');
  assert.deepEqual(p.data.events, { first_blood: 1, survivor: 1 });
  assert.equal(p.xp - xpBefore, 0, 'events award no XP');
  p.applyMatchResult({ ...base, key: 'm2', events: ['first_blood'] });
  assert.deepEqual(p.data.events, { first_blood: 2, survivor: 1 });
  assert.equal(p.stats.eventsEarned, 3);
  p.flush();
  const again = mkProfile(storage);
  assert.equal(again.stats.eventsEarned, 3, 'survives a reload');
  assert.deepEqual(again.data.events, { first_blood: 2, survivor: 1 });
});

test('profile: the same match key never records events twice (existing idempotency)', () => {
  const p = mkProfile(fakeStorage());
  p.applyMatchResult({ ...base, key: 'dup', events: ['comeback'] });
  for (let i = 0; i < 4; i++) assert.equal(p.applyMatchResult({ ...base, key: 'dup', events: ['comeback'] }), null);
  assert.equal(p.stats.eventsEarned, 1);
  assert.deepEqual(p.data.events, { comeback: 1 });
});

test('profile: unknown / forged event ids are dropped, and a corrupted stored events map is repaired', () => {
  const p = mkProfile(fakeStorage());
  p.applyMatchResult({ ...base, key: 'bad', events: ['nope', '__proto__', 7, null, 'giant_snake'] });
  assert.deepEqual(p.data.events, { giant_snake: 1 });
  const storage = fakeStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, xp: 0, events: { first_blood: 'lots', giant_snake: -4, comeback: 2.9, nope: 5 }, stats: { eventsEarned: 'x' } }));
  const q = mkProfile(storage);
  assert.deepEqual(q.data.events, { comeback: 2 });
  assert.equal(q.stats.eventsEarned, 0);
  const old = fakeStorage();
  old.setItem(STORAGE_KEY, JSON.stringify({ version: 1, xp: 0, nickname: 'Early' }));
  assert.deepEqual(mkProfile(old).data.events, {}, 'a profile saved before events existed gets an empty history');
});

test('multiplayer adapter: only THIS player\'s events from the server\'s authoritative list are recorded', () => {
  const over = {
    winnerId: 'p1',
    results: [{ id: 'p1', rank: 1, score: 100, length: 12, kills: 1, survived: true }, { id: 'p2', rank: 2, score: 0, length: 7, kills: 0, survived: false }],
    events: [{ k: 'first_blood', id: 'p1', v: 'p2', t: 40 }, { k: 'survivor', id: 'p1', t: 400 }, { k: 'survivor', id: 'p2', t: 400 }, { k: 'bogus', id: 'p1' }],
  };
  assert.deepEqual(fromMultiplayer(over, 'p1', 'k', 60).events.sort(), ['first_blood', 'survivor']);
  assert.deepEqual(fromMultiplayer(over, 'p2', 'k', 60).events, ['survivor']);
  assert.deepEqual(fromMultiplayer({ ...over, events: undefined }, 'p1', 'k', 60).events, [], 'an older server without events: nothing to record');
});
