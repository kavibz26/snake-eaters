// Dev-only per-match event telemetry: a data-derivation and console-logging layer used to tune the
// thresholds in js/events/config.js against real matches. It is strictly READ-ONLY description built
// from the same authoritative data that already drives the real event system - MatchEvents.summary()
// (the fire log, see js/events/tracker.js) and each snake's own final stats. It never fires, suppresses,
// or reorders an event, changes no threshold, and is never sent anywhere: nothing here reaches the
// server, an analytics endpoint, or the normal results/profile UI. It is gated off by default; see
// isTelemetryEnabled() below.
import { MATCH_EVENTS, EVENT_IDS } from './config.js';
import { CONFIG } from '../config.js';

const toSeconds = (tick, tickMs) => Math.round((tick * tickMs) / 1000);

// The configured threshold for an event, for display ("peak 21 / 25"). Comeback has no single scalar
// threshold (it is a rank + gain rule), so it has none here.
function thresholdOf(id) {
  const c = MATCH_EVENTS[id];
  switch (id) {
    case 'food_hunter': return c.food;
    case 'power_collector': return c.powerups;
    case 'giant_snake': return c.length;
    case 'survivor': return c.seconds;
    case 'longest_snake': return c.minLength;
    case 'most_food': return c.minFood;
    default: return null;
  }
}

// How close a snake got to a not-yet-fired event's threshold, for "peak 21 / 25"-style tuning context.
function progressOf(id, snake) {
  switch (id) {
    case 'food_hunter': return snake.food;
    case 'power_collector': return snake.powerups;
    case 'giant_snake':
    case 'longest_snake': return snake.peakLength;
    case 'most_food': return snake.food;
    default: return null;
  }
}

// Builds the developer telemetry summary for one finished match.
//
// log: the authoritative fire log, in fire order - MatchEvents.summary() (single player) or the
//      server's eventSummary() / the `over` message's `events` (multiplayer). Each entry looks like
//      { k, id, t, v?, a? } - v is First Blood's victim id, a is snakes-alive-when-it-fired (may be
//      absent for older data; telemetry degrades gracefully without it).
// snakes: [{ id, name?, food, powerups, peakLength, kills }] - one row per snake in the match (AI
//      included in single player; every connected player in multiplayer).
// tickMs, durationTicks: for turning ticks into seconds.
// focusId: whose numbers populate the top-level Duration/Food/Power-ups/Peak length/Kills block (the
//      local player in both modes). Defaults to the first row when omitted.
export function buildMatchTelemetry({ log = [], snakes = [], tickMs = CONFIG.TICK_MS, durationTicks = 0, focusId = null } = {}) {
  // Per-event fires, in fire order, deduplicated by player (the tracker already guarantees at most one
  // fire per snake per event id, and at most one First Blood for the whole match - this is a defensive
  // second dedup so telemetry itself never double-counts even if it is ever fed a hand-built log).
  const perEventFires = new Map(); // id -> [{ playerId, tick, alive }]
  let firstBlood = null;
  for (const ev of log) {
    if (ev.k === 'first_blood') {
      if (!firstBlood) firstBlood = ev; // match-wide: fires once; the first entry IS the only one
      continue;
    }
    if (!perEventFires.has(ev.k)) perEventFires.set(ev.k, []);
    const fires = perEventFires.get(ev.k);
    if (!fires.some((f) => f.playerId === ev.id)) fires.push({ playerId: ev.id, tick: ev.t, alive: ev.a ?? null });
  }

  const perPlayerEvents = EVENT_IDS.filter((id) => id !== 'first_blood').map((id) => {
    const fires = perEventFires.get(id) || [];
    const achieved = fires.length > 0;
    const entry = {
      id,
      name: MATCH_EVENTS[id].name,
      matchWide: false,
      // Under the current once-per-snake rule an event fires the instant its threshold is reached, so
      // these two are always equal today; they are kept distinct so a future asynchronous-award event
      // (reached now, credited later) does not need a new telemetry shape.
      thresholdReached: achieved,
      awarded: achieved,
      earnedBy: fires.map((f) => f.playerId),
      earnedCount: fires.length,
      threshold: thresholdOf(id),
    };
    if (achieved) {
      entry.firstTick = fires[0].tick;
      entry.firstSeconds = toSeconds(fires[0].tick, tickMs);
      entry.aliveAtFirst = fires[0].alive;
    } else {
      const progress = snakes.map((s) => progressOf(id, s)).filter((v) => v != null);
      entry.bestProgress = progress.length ? Math.max(...progress) : null;
    }
    return entry;
  });

  const firstBloodEntry = {
    id: 'first_blood',
    name: MATCH_EVENTS.first_blood.name,
    matchWide: true,
    thresholdReached: !!firstBlood,
    awarded: !!firstBlood,
    earnedBy: firstBlood ? [firstBlood.id] : [],
    earnedCount: firstBlood ? 1 : 0,
    threshold: null,
    killerId: firstBlood ? firstBlood.id : null,
    victimId: firstBlood ? firstBlood.v : null,
    firstTick: firstBlood ? firstBlood.t : null,
    firstSeconds: firstBlood ? toSeconds(firstBlood.t, tickMs) : null,
    aliveAtFirst: firstBlood ? (firstBlood.a ?? null) : null,
  };

  const events = [firstBloodEntry, ...perPlayerEvents];

  const players = snakes.map((s) => {
    const eventIds = [...new Set(log.filter((e) => e.k !== 'first_blood' && e.id === s.id).map((e) => e.k))];
    return {
      id: s.id,
      name: s.name ?? String(s.id),
      food: s.food ?? 0,
      powerups: s.powerups ?? 0,
      peakLength: s.peakLength ?? 0,
      kills: s.kills ?? 0,
      eventIds,
      events: eventIds.map((id) => MATCH_EVENTS[id]?.name || id),
    };
  });

  const focus = (focusId != null ? players.find((p) => p.id === focusId) : players[0]) || null;

  return {
    durationTicks,
    durationSeconds: toSeconds(durationTicks, tickMs),
    food: focus ? focus.food : 0,
    powerups: focus ? focus.powerups : 0,
    peakLength: focus ? focus.peakLength : 0,
    kills: focus ? focus.kills : 0,
    focusId: focus ? focus.id : null,
    firstBlood: firstBloodEntry,
    events,
    players,
  };
}

const UNIT = { food_hunter: 'food', power_collector: 'pickups' };

function eventLine(e) {
  const mark = e.awarded ? '✓' : '✗';
  if (e.id === 'first_blood') {
    return e.awarded ? `${mark} First Blood — killer ${e.killerId}, victim ${e.victimId} — ${e.firstSeconds}s` : `${mark} First Blood — none`;
  }
  if (e.awarded) {
    const who = e.earnedCount > 1 ? ` (${e.earnedCount} players)` : '';
    const count = UNIT[e.id] && e.threshold != null ? `${e.threshold} ${UNIT[e.id]} — ` : '';
    return `${mark} ${e.name} — ${count}${e.firstSeconds}s${who}`;
  }
  if (e.bestProgress != null && e.threshold != null) return `${mark} ${e.name} — peak ${e.bestProgress} / ${e.threshold}`;
  return `${mark} ${e.name} — requirement not met`;
}

// Plain-text rendering for console.log, roughly matching the format used to review real matches.
export function formatMatchTelemetry(t) {
  const lines = [
    'Match telemetry',
    `Duration: ${t.durationSeconds}s`,
    `Food: ${t.food}`,
    `Power-ups: ${t.powerups}`,
    `Peak length: ${t.peakLength}`,
    `Kills: ${t.kills}`,
    '',
    'Events:',
    ...t.events.map(eventLine),
  ];
  if (t.players.length > 1) {
    lines.push('');
    for (const p of t.players) {
      lines.push(`${p.name}:`);
      lines.push(`  food: ${p.food}`);
      lines.push(`  peak length: ${p.peakLength}`);
      lines.push(`  kills: ${p.kills}`);
      lines.push(`  events: ${p.events.length ? p.events.join(', ') : 'none'}`);
    }
  }
  return lines.join('\n');
}

// Dev-only gate: off unless explicitly opted into with ?telemetry=1 (same pattern as the existing
// ?map= dev override in js/main.js). Never on for a normal player who did not add this to the URL.
export function isTelemetryEnabled() {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).get('telemetry') === '1';
  } catch {
    return false;
  }
}

// console.log only - never a network call, never storage, never rendered into the page.
export function logMatchTelemetry(telemetry) {
  if (typeof console !== 'undefined' && console.log) {
    console.log(formatMatchTelemetry(telemetry));
    console.log('[telemetry:data]', telemetry);
  }
}
