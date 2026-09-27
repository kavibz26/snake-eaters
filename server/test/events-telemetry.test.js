import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchEvents } from '../../js/events/tracker.js';
import { buildMatchTelemetry, formatMatchTelemetry } from '../../js/events/telemetry.js';
import { CONFIG } from '../../js/config.js';

// Dev-only per-match event telemetry (js/events/telemetry.js): a pure, read-only description of a
// finished match, built from the exact same data the real event system already produces. It never
// changes an event's semantics or thresholds - these tests only check the derived numbers are right.
const idOf = (s) => s.id;
const snake = (id, extra = {}) => ({ id, alive: true, length: 3, foodEaten: 0, powerupsCollected: 0, megaCollected: 0, eliminations: 0, ...extra });

test('duration: ticks convert to seconds using the real tick length', () => {
  const t = buildMatchTelemetry({ log: [], snakes: [snake('a')], durationTicks: 400 });
  assert.equal(t.durationTicks, 400);
  assert.equal(t.durationSeconds, Math.round((400 * CONFIG.TICK_MS) / 1000));
});

test('food, power-ups, peak length and kills reported are the focus player\'s own numbers', () => {
  const players = [
    { id: 'a', food: 18, powerups: 4, peakLength: 21, kills: 2 },
    { id: 'b', food: 9, powerups: 1, peakLength: 14, kills: 0 },
  ];
  const t = buildMatchTelemetry({ log: [], snakes: players, focusId: 'a' });
  assert.equal(t.food, 18);
  assert.equal(t.powerups, 4);
  assert.equal(t.peakLength, 21);
  assert.equal(t.kills, 2);
  assert.equal(t.focusId, 'a');

  const other = buildMatchTelemetry({ log: [], snakes: players, focusId: 'b' });
  assert.equal(other.food, 9);
  assert.equal(other.kills, 0);
});

test('an event that fired reports the tick and the second it first fired', () => {
  const tick = Math.round((48 * 1000) / CONFIG.TICK_MS); // the tick that lands at 48s at the real tick rate
  const t = buildMatchTelemetry({ log: [{ k: 'food_hunter', id: 'a', t: tick, n: 12 }], snakes: [snake('a')] });
  const fh = t.events.find((e) => e.id === 'food_hunter');
  assert.equal(fh.thresholdReached, true);
  assert.equal(fh.awarded, true);
  assert.equal(fh.firstTick, tick);
  assert.equal(fh.firstSeconds, 48);
  assert.equal(fh.threshold, 12);
});

test('an event that never fired reports how close the match got, not a fake timestamp', () => {
  const t = buildMatchTelemetry({ log: [], snakes: [{ id: 'a', food: 0, powerups: 0, peakLength: 21, kills: 0 }] });
  const giant = t.events.find((e) => e.id === 'giant_snake');
  assert.equal(giant.thresholdReached, false);
  assert.equal(giant.awarded, false);
  assert.equal(giant.firstTick, undefined);
  assert.equal(giant.threshold, 25);
  assert.equal(giant.bestProgress, 21);
});

test('First Blood attribution: killer, victim and none', () => {
  const withKill = buildMatchTelemetry({ log: [{ k: 'first_blood', id: 'hunter', v: 'prey', t: 40, a: 3 }], snakes: [snake('hunter'), snake('prey')] });
  assert.equal(withKill.firstBlood.awarded, true);
  assert.equal(withKill.firstBlood.matchWide, true);
  assert.equal(withKill.firstBlood.killerId, 'hunter');
  assert.equal(withKill.firstBlood.victimId, 'prey');
  assert.equal(withKill.firstBlood.aliveAtFirst, 3);
  assert.match(formatMatchTelemetry(withKill), /First Blood — killer hunter, victim prey/);

  const none = buildMatchTelemetry({ log: [], snakes: [snake('a')] });
  assert.equal(none.firstBlood.awarded, false);
  assert.equal(none.firstBlood.killerId, null);
  assert.match(formatMatchTelemetry(none), /✗ First Blood — none/);
});

test('per-player event counts: each player\'s own earned events are counted and named, independently', () => {
  const log = [
    { k: 'food_hunter', id: 'a', t: 10 },
    { k: 'survivor', id: 'a', t: 20 },
    { k: 'survivor', id: 'b', t: 20 },
  ];
  const t = buildMatchTelemetry({ log, snakes: [{ id: 'a', name: 'Player A' }, { id: 'b', name: 'Player B' }] });
  const a = t.players.find((p) => p.id === 'a');
  const b = t.players.find((p) => p.id === 'b');
  assert.deepEqual(a.eventIds.sort(), ['food_hunter', 'survivor']);
  assert.deepEqual(b.eventIds, ['survivor']);
  assert.equal(a.events.includes('Food Hunter'), true);
  assert.equal(b.events.includes('Food Hunter'), false);
});

test('match-wide vs per-player is explicit on every event entry', () => {
  const t = buildMatchTelemetry({ log: [], snakes: [snake('a')] });
  const first = t.events.find((e) => e.id === 'first_blood');
  assert.equal(first.matchWide, true);
  for (const e of t.events.filter((e) => e.id !== 'first_blood')) assert.equal(e.matchWide, false);
});

test('an event earned by two players in one match is counted for both, once each', () => {
  const log = [
    { k: 'survivor', id: 'a', t: 400 },
    { k: 'survivor', id: 'b', t: 400 },
  ];
  const t = buildMatchTelemetry({ log, snakes: [snake('a'), snake('b')] });
  const survivor = t.events.find((e) => e.id === 'survivor');
  assert.equal(survivor.earnedCount, 2);
  assert.deepEqual(survivor.earnedBy.sort(), ['a', 'b']);
});

test('no duplicate events: a repeated log entry for the same player is not double-counted', () => {
  const log = [
    { k: 'power_collector', id: 'a', t: 61 },
    { k: 'power_collector', id: 'a', t: 61 }, // defensively deduplicated even though the tracker never emits this
  ];
  const t = buildMatchTelemetry({ log, snakes: [snake('a')] });
  const pc = t.events.find((e) => e.id === 'power_collector');
  assert.equal(pc.earnedCount, 1);
  assert.deepEqual(pc.earnedBy, ['a']);
});

test('no duplicate First Blood even if the log somehow held more than one entry', () => {
  const log = [
    { k: 'first_blood', id: 'a', v: 'b', t: 10 },
    { k: 'first_blood', id: 'c', v: 'd', t: 50 },
  ];
  const t = buildMatchTelemetry({ log, snakes: [snake('a'), snake('b'), snake('c'), snake('d')] });
  assert.equal(t.firstBlood.killerId, 'a');
  assert.equal(t.firstBlood.firstTick, 10);
});

test('real MatchEvents data flows through unchanged: peakOf(), and alive-count travels with noteKill', () => {
  const ev = new MatchEvents();
  const a = snake('a', { foodEaten: 12 });
  const b = snake('b');
  ev.update(1, [a, b], idOf);
  a.length = 9;
  ev.update(2, [a, b], idOf);
  assert.equal(ev.peakOf('a'), 9, 'peak length is tracked as snakes grow');
  assert.equal(ev.peakOf('nobody'), 0, 'an unknown id has no peak yet');

  ev.noteKill('a', 'b', 30, 2);
  const fb = ev.summary().find((e) => e.k === 'first_blood');
  assert.equal(fb.a, 2, 'the alive count at the moment of the kill rides along for telemetry');

  // Existing consumers only ever read k/id/v/t (see server/test/events.test.js) - the extra `a` field
  // must not change what they see.
  assert.deepEqual({ k: fb.k, id: fb.id, v: fb.v, t: fb.t }, { k: 'first_blood', id: 'a', v: 'b', t: 30 });
});

test('a per-tick fired event also carries the alive count for telemetry, without changing its identity', () => {
  const ev = new MatchEvents();
  const a = snake('a', { foodEaten: 12 });
  const b = snake('b');
  ev.update(1, [a, b], idOf);
  const fh = ev.summary().find((e) => e.k === 'food_hunter');
  assert.equal(fh.a, 2);
  assert.deepEqual({ k: fh.k, id: fh.id, t: fh.t }, { k: 'food_hunter', id: 'a', t: 1 });
});

test('buildMatchTelemetry degrades gracefully when alive-count data is missing (older-shaped log)', () => {
  const t = buildMatchTelemetry({ log: [{ k: 'survivor', id: 'a', t: 400 }], snakes: [snake('a')] });
  const survivor = t.events.find((e) => e.id === 'survivor');
  assert.equal(survivor.aliveAtFirst, null);
});

test('formatMatchTelemetry only lists the per-player breakdown when there is more than one player', () => {
  const solo = buildMatchTelemetry({ log: [], snakes: [{ id: 'a', name: 'You', food: 5, powerups: 0, peakLength: 3, kills: 0 }] });
  assert.doesNotMatch(formatMatchTelemetry(solo), /You:/);

  const duo = buildMatchTelemetry({ log: [], snakes: [
    { id: 'a', name: 'Player A', food: 5, powerups: 0, peakLength: 3, kills: 0 },
    { id: 'b', name: 'Player B', food: 2, powerups: 0, peakLength: 3, kills: 0 },
  ] });
  assert.match(formatMatchTelemetry(duo), /Player A:/);
  assert.match(formatMatchTelemetry(duo), /Player B:/);
});
