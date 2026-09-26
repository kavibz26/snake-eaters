// Client-side prediction for the LOCAL player's snake - visual/input prediction
// only. The server stays authoritative for positions, food, kills and deaths;
// nothing computed here is ever sent to the server as state. All the server
// ever receives from this class's owner is a tiny sequenced intent
// ("turn up", "boost"); the prediction just lets the local snake react
// instantly instead of waiting a full network round trip + server tick.
//
// How it works
//   1. Every snapshot gives the AUTHORITATIVE local snake at server tick k,
//      together with `ack` = highest input sequence the server has processed.
//   2. Inputs the server has not acknowledged yet are kept in `inputs`.
//   3. From the authoritative state we run the very same Snake movement rules
//      the server uses (queueDirection / nextHead / commitMove / boost) forward
//      to the "target tick" J, replaying the unacknowledged inputs at the tick
//      the server is expected to apply them.
//   4. J leads the snapshot stream by the measured round trip time, so an
//      input pressed NOW is expected to be processed by the server at tick J -
//      the very step the snake is currently gliding toward. The head therefore
//      turns immediately AND agrees with what the server will do.
//   5. When the next snapshot disagrees (jitter, a rejected input, someone
//      else's food grab...), the prediction is simply rebuilt from the new
//      authoritative state; the small visual difference is absorbed by the
//      renderer's decaying offset (see NetGame), big ones just snap.
import { CONFIG, cellKey } from '../config.js';
import { Snake } from '../snake.js';
import { hitsTerrain } from '../collision.js';
import { takesExtraStep } from '../powerups/effects.js';
import { DIR_VECS, dirIndex } from './snapcodec.js';

const PLACEHOLDER_SKIN = { ui: '#ffffff' };
const MAX_LEAD_TICKS = 6; // stop predicting further ahead if snapshots stall
const PHI_WINDOW = 12;
const PHI_SLEW_MS = 6; // max phase correction per snapshot
const RTT_SHIFT_STREAK = 2; // consecutive pings that are trusted over the older ones when they are all far above/below them
const RTT_WINDOW = 6; // ~12s of pings: how long a stale low sample can pin the lead

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Builds the predictor's authoritative-state input from one snake entry of a
// snapshot (`s`) plus that snake's decoded flat cells. Shared by the game and tests.
export function predictorState(snap, s, flat) {
  const dir = { x: s.d[0], y: s.d[1] };
  return {
    tick: snap.tick,
    cells: flat,
    dir,
    pending: s.p ? s.p[0] : dirIndex(dir),
    buffered: s.p ? s.p[1] : -1,
    growPending: s.g || 0,
    boostTicksLeft: s.b[0],
    boostCooldownLeft: s.b[1],
    speedTicksLeft: s.e ? s.e[0] : 0,
    ack: s.q || 0,
    alive: s.a === 1,
  };
}

export class LocalPredictor {
  constructor(tickMs = CONFIG.TICK_MS) {
    this.tickMs = tickMs;
    this.obstacles = new Set(); // the match's map obstacles (solid for prediction, exactly like the board edge)
    this.reset();
  }

  reset() {
    this.active = false;
    this.baseTick = 0;
    this.base = null; // authoritative snake state at baseTick
    this.food = new Map();
    this.inputs = []; // unacknowledged inputs, oldest first
    this.lastSeq = 0; // highest sequence number ever added: inputs must arrive in strictly increasing order
    this.sim = null;
    this.eaten = new Set();
    this.simTick = 0;
    this.prevCells = [];
    this.curCells = [];
    this.phiSamples = [];
    this.phi = null;
    this.rttSamples = this.rttSamples || [];
    this.jitter = this.jitter || 0;
    this.history = new Map(); // tick -> predicted head cell (used to measure accuracy)
  }

  // --- timing model -------------------------------------------------------------------

  // A snapshot for `tick` arrived at client time `now`. Arrival times follow
  // phi + tick * tickMs, plus network jitter that can only ever ADD delay, so the
  // minimum over a short window is the best estimate of the tick phase.
  noteSnapshot(tick, now) {
    this.phiSamples.push(now - tick * this.tickMs);
    if (this.phiSamples.length > PHI_WINDOW) this.phiSamples.shift();
    const min = Math.min(...this.phiSamples);
    if (this.phi === null) this.phi = min;
    else this.phi += clamp(min - this.phi, -PHI_SLEW_MS, PHI_SLEW_MS); // slew-limited: no visible glide jumps
  }

  noteRtt(rttMs) {
    // The lead follows the LOW end of recent samples (jitter only ever adds delay), which alone
    // would take a whole window to notice the path changing for good. So when the last few pings
    // are ALL clearly outside the older ones - above their low end, or below their median - treat
    // it as a real level shift and forget the older samples (also so stale ones stop inflating the
    // jitter estimate). "Clearly" scales with how jittery the link already was, so a naturally
    // noisy connection does not trip it; a single spike or dip never does.
    const n = this.rttSamples.length;
    if (n >= RTT_SHIFT_STREAK) {
      const older = this.rttSamples.slice(0, n - (RTT_SHIFT_STREAK - 1)).sort((a, b) => a - b);
      const min = older[0];
      const median = older[Math.floor(older.length / 2)];
      const p75 = older[Math.floor(older.length * 0.75)];
      const margin = Math.max(40, 1.5 * (p75 - min));
      const recent = [...this.rttSamples.slice(n - (RTT_SHIFT_STREAK - 1)), rttMs];
      if (recent.every((v) => v > min + margin) || recent.every((v) => v < median - margin)) {
        this.rttSamples = recent;
        this._updateJitter();
        return;
      }
    }
    this.rttSamples.push(rttMs);
    if (this.rttSamples.length > RTT_WINDOW) this.rttSamples.shift();
    this._updateJitter();
  }

  _updateJitter() {
    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    this.jitter = sorted[Math.floor(sorted.length / 2)] - sorted[0];
  }

  // Round trip the lead is based on: the low end of recent samples (same
  // reference as the min-filtered tick phase), plus a small jitter allowance.
  get lead() {
    if (!this.rttSamples.length) return 60;
    const min = Math.min(...this.rttSamples);
    return min + clamp(this.jitter * 0.5, 0, 40);
  }

  // Fractional server tick that an input pressed at `now` is expected to reach.
  _u(now) {
    return (now + this.lead - this.phi) / this.tickMs;
  }

  targetTick(now) {
    if (!this.active || this.phi === null) return this.baseTick;
    const j = Math.ceil(this._u(now));
    return clamp(j, this.baseTick, this.baseTick + MAX_LEAD_TICKS);
  }

  // --- authoritative updates ------------------------------------------------------------------

  // state: { tick, cells:[x,y,...] (head first), dir:{x,y}, pending:idx, buffered:idx|-1,
  //          growPending, boostTicksLeft, boostCooldownLeft, ack, alive }
  onSnapshot(state, food, now) {
    if (!state.alive || !state.cells.length) {
      this.active = false;
      this.inputs = [];
      return;
    }
    this.active = true;
    this.baseTick = state.tick;
    this.base = state;
    this.food = food;
    const expireAfter = Math.max(1500, this.lead * 4 + 300);
    this.inputs = this.inputs.filter((i) => i.seq > state.ack && now - i.sentAt < expireAfter);
    // An unacknowledged input can't have been applied yet; the earliest it can
    // land is the next tick after the state we're rebuilding from.
    for (const i of this.inputs) if (i.tick <= state.tick) i.tick = state.tick + 1;
    this.rebuild(now);
  }

  // Inputs in flight belong to a dead connection; the server never saw them.
  dropInFlightInputs() {
    this.inputs = [];
  }

  addInput(kind, dir, seq, now) {
    if (!this.active || this.phi === null) return false;
    if (!(seq > this.lastSeq)) return false; // duplicate / out-of-order / stale: never buffered twice
    this.lastSeq = seq;
    const tick = Math.max(this.baseTick + 1, Math.ceil(this._u(now)));
    this.inputs.push({ seq, kind, dir, tick, sentAt: now, done: false });
    this.rebuild(now);
    return true;
  }

  // --- simulation ---------------------------------------------------------------------------------

  rebuild(now) {
    const b = this.base;
    const cells = [];
    for (let i = 0; i < b.cells.length; i += 2) cells.push({ x: b.cells[i], y: b.cells[i + 1] });
    const s = new Snake({ isPlayer: true, cells, direction: b.dir, skin: PLACEHOLDER_SKIN, profile: null });
    s.pendingDirection = DIR_VECS[b.pending] || b.dir;
    s.inputBuffer = b.buffered >= 0 ? [DIR_VECS[b.buffered]] : [];
    s.growPending = b.growPending || 0;
    s.boostTicksLeft = b.boostTicksLeft || 0;
    s.boostCooldownLeft = b.boostCooldownLeft || 0;
    s.speedTicksLeft = b.speedTicksLeft || 0; // authoritative Speed power-up timer (the server decides pickups)
    this.sim = s;
    this.eaten = new Set();
    this.simTick = b.tick;
    this.curCells = this._cellsOf(s);
    this.prevCells = this.curCells;
    for (const i of this.inputs) i.done = false;
    this._advanceTo(this.targetTick(now));
  }

  _advanceTo(target) {
    while (this.simTick < target) this._step(this.simTick + 1);
  }

  _cellsOf(s) {
    return s.body.map((c) => ({ x: c.x, y: c.y }));
  }

  // One server tick for our own snake: same order as MatchSim.tick() -
  // queued inputs, boost pre-step, normal move. Collisions and deaths are
  // deliberately NOT predicted (the server decides); we only refuse to draw the
  // snake leaving the arena.
  _step(j) {
    const s = this.sim;
    for (const i of this.inputs) {
      if (i.done || i.tick > j) continue;
      i.done = true;
      if (i.kind === 'dir') s.queueDirection(i.dir);
      else s.activateBoost(CONFIG.BOOST_DURATION_TICKS);
    }
    // Same order as the server: the extra step (Boost every tick, Speed every 2nd; never more than one), then the normal move.
    const boosting = s.boostTicksLeft > 0;
    const extra = takesExtraStep(s, j);
    if (s.speedTicksLeft > 0) s.speedTicksLeft--;
    if (extra) this._move(s);
    if (boosting) {
      s.boostTicksLeft--;
      if (s.boostTicksLeft === 0) s.boostCooldownLeft = CONFIG.BOOST_COOLDOWN_TICKS;
    } else if (s.boostCooldownLeft > 0) {
      s.boostCooldownLeft--;
    }
    this._move(s);
    this.simTick = j;
    this.prevCells = this.curCells;
    this.curCells = this._cellsOf(s);
    this.history.set(j, this.curCells[0]);
    this.history.delete(j - 24);
  }

  // Obstacles are static for a match and identical on both sides (same map id -> same layout).
  setObstacles(obstacles) {
    this.obstacles = obstacles || new Set();
  }

  _move(s) {
    const nh = s.nextHead();
    if (hitsTerrain(this.obstacles, nh.x, nh.y)) return; // solid: hold still, like the server does when a shield absorbs the hit
    const key = cellKey(nh.x, nh.y);
    if (this.food.has(key) && !this.eaten.has(key)) {
      this.eaten.add(key);
      s.grow(1);
    }
    s.commitMove(nh);
  }

  // --- reading the prediction ---------------------------------------------------------------------------

  // Cells to draw at `now`: the head glides from the previous predicted tick to the
  // target tick over one tick interval.
  displayCells(now) {
    if (!this.active || !this.sim) return null;
    const J = this.targetTick(now);
    if (this.simTick > J) this.rebuild(now); // tick phase estimate moved backwards
    else this._advanceTo(J);
    if (this.simTick === this.baseTick) return this.curCells.map((c) => ({ x: c.x, y: c.y }));
    const f = clamp(this._u(now) - (this.simTick - 1), 0, 1);
    const a = this.prevCells;
    const b = this.curCells;
    const out = new Array(b.length);
    const lastA = a[a.length - 1];
    for (let i = 0; i < b.length; i++) {
      const from = a[i] || lastA || b[i];
      out[i] = { x: from.x + (b[i].x - from.x) * f, y: from.y + (b[i].y - from.y) * f };
    }
    return out;
  }

  // The predicted committed heading (what the head is facing / moving toward).
  direction(now) {
    if (!this.active || !this.sim) return null;
    this.displayCells(now);
    return this.sim.direction;
  }

  predictedBoost() {
    return this.sim ? { ticksLeft: this.sim.boostTicksLeft, cooldown: this.sim.boostCooldownLeft } : null;
  }

  // Would the server accept a boost right now, judging by the predicted state?
  canBoost() {
    return Boolean(this.sim) && this.sim.canBoost() && !this.inputs.some((i) => i.kind === 'boost');
  }
}
