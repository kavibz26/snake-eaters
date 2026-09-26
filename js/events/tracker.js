// MatchEvents: derives match events from authoritative simulation state. One instance per match, owned by
// the simulation that already owns the truth (the single-player Game, or the multiplayer MatchSim on the
// server) - clients only ever RECEIVE events, they can never award them.
//
// Cost: update() is one pass over the (at most six) snakes per tick with a few integer comparisons, plus a
// small ranking every `sampleEveryTicks` ticks for Comeback. Nothing scans the board.
//
// Every event fires at most once per match (First Blood: once for the whole match; the others: once per
// snake). Snake identity is whatever `idOf(snake)` returns (server: playerId, single player: snake.id).
import { CONFIG } from '../config.js';
import { MATCH_EVENTS } from './config.js';

export class MatchEvents {
  constructor({ config = MATCH_EVENTS, tickMs = CONFIG.TICK_MS } = {}) {
    this.cfg = config;
    this.survivorTicks = Math.round((config.survivor.seconds * 1000) / tickMs);
    this.fired = new Set(); // "event:id" (First Blood: just "first_blood")
    this.pending = []; // fired since the last drain()
    this.log = []; // everything fired this match, in order
    this.stats = new Map(); // id -> { peak, low }
    this.tick = 0;
    this.finalized = false;
  }

  _stat(id) {
    let s = this.stats.get(id);
    if (!s) {
      s = { peak: 0, low: null };
      this.stats.set(id, s);
    }
    return s;
  }

  _fire(k, id, extra = null) {
    const key = k === 'first_blood' ? k : `${k}:${id}`;
    if (this.fired.has(key)) return null;
    this.fired.add(key);
    const ev = { k, id, t: this.tick, ...(extra || {}) };
    this.log.push(ev);
    this.pending.push(ev);
    return ev;
  }

  // The simulation calls this from its kill-credit path (it knows who eliminated whom).
  noteKill(killerId, victimId, tick = this.tick) {
    this.tick = tick;
    this._fire('first_blood', killerId, { v: victimId });
  }

  // Once per tick, after the tick's moves and deaths are resolved.
  update(tick, snakes, idOf) {
    this.tick = tick;
    const c = this.cfg;
    let alive = 0;
    for (const s of snakes) if (s.alive) alive++;
    const sampleRanks = alive >= c.comeback.minPlayers && tick >= c.comeback.startAfterTicks && tick % c.comeback.sampleEveryTicks === 0;

    for (const s of snakes) {
      if (!s.alive) continue;
      const id = idOf(s);
      const st = this._stat(id);
      const len = s.length;
      if (len > st.peak) st.peak = len;
      if (s.foodEaten >= c.food_hunter.food) this._fire('food_hunter', id, { n: c.food_hunter.food });
      if (s.powerupsCollected + s.megaCollected >= c.power_collector.powerups) this._fire('power_collector', id, { n: c.power_collector.powerups });
      if (len >= c.giant_snake.length) this._fire('giant_snake', id, { n: c.giant_snake.length });
      if (tick >= this.survivorTicks) this._fire('survivor', id, { n: c.survivor.seconds });
      if (s.eliminations > 0 && !this.fired.has('first_blood')) this._fire('first_blood', id); // safety net if a kill path skipped noteKill
      if (sampleRanks) {
        let rank = 1;
        for (const o of snakes) if (o.alive && o.length > len) rank++;
        if (rank > alive * c.comeback.lowRankFraction) st.low = st.low === null ? len : Math.min(st.low, len);
        else if (rank === 1 && st.low !== null && len - st.low >= c.comeback.minLengthGain) this._fire('comeback', id, { from: st.low });
      }
    }
  }

  // When the match ends: the "most at the end" awards. Ties share the award.
  finalize(snakes, idOf, tick = this.tick) {
    if (this.finalized) return;
    this.finalized = true;
    this.tick = tick;
    if (snakes.length < 2) return; // nothing to compare against
    const c = this.cfg;
    let maxLen = 0;
    let maxFood = 0;
    const peaks = new Map();
    for (const s of snakes) {
      const id = idOf(s);
      const peak = Math.max(this._stat(id).peak, s.alive ? s.length : 0);
      peaks.set(id, peak);
      if (peak > maxLen) maxLen = peak;
      if (s.foodEaten > maxFood) maxFood = s.foodEaten;
    }
    for (const s of snakes) {
      const id = idOf(s);
      if (maxLen > c.longest_snake.minLength && peaks.get(id) === maxLen) this._fire('longest_snake', id, { n: maxLen });
      if (maxFood >= c.most_food.minFood && s.foodEaten === maxFood) this._fire('most_food', id, { n: maxFood });
    }
  }

  drain() {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  summary() {
    return this.log.map((e) => ({ ...e }));
  }
}
