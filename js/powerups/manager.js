// Special items on the board (spawning, lifetime, pickup) and the Magnet's food attraction. Shared
// by the single-player Game and the authoritative multiplayer MatchSim: the same rules, the same
// numbers, driven from each simulation's fixed tick. No DOM, no rendering.
import { CONFIG, cellKey } from '../config.js';
import { POWERUPS, POWERUP_TYPES } from './config.js';

export class PowerUpManager {
  // rng: () => [0,1) - injectable so tests (and, if ever needed, replays) are deterministic.
  constructor({ cols = CONFIG.GRID_COLS, rows = CONFIG.GRID_ROWS, rng = Math.random, config = POWERUPS } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.rng = rng;
    this.cfg = config;
    this.items = new Map(); // "x,y" -> { x, y, type, born }
    this.cooldown = config.spawn.startCooldownTicks;
  }

  get count() { return this.items.size; }
  has(x, y) { return this.items.has(cellKey(x, y)); }
  all() { return this.items.values(); }
  clear() { this.items.clear(); this.cooldown = this.cfg.spawn.startCooldownTicks; }

  // A snake head reached (x, y): the item (if any) is removed and returned - exactly once.
  take(x, y) {
    const k = cellKey(x, y);
    const item = this.items.get(k);
    if (!item) return null;
    this.items.delete(k);
    return item;
  }

  // One simulation tick of spawning + expiry.
  //   ctx: { tick, snakes: [{ alive, body: [{x,y}] }], isBlocked(x, y) }   (isBlocked: food / bodies / items)
  // -> { spawned: item | null, expired: [item] }
  update(ctx) {
    const sp = this.cfg.spawn;
    const expired = [];
    for (const [k, item] of this.items) {
      if (ctx.tick - item.born >= sp.lifetimeTicks) {
        this.items.delete(k);
        expired.push(item);
      }
    }
    if (this.items.size >= sp.maxActive) return { spawned: null, expired };
    if (this.cooldown > 0) {
      this.cooldown--;
      return { spawned: null, expired };
    }
    if (this.rng() >= sp.chancePerTick) return { spawned: null, expired };
    const cell = this._pickCell(ctx);
    if (!cell) return { spawned: null, expired };
    const item = { x: cell.x, y: cell.y, type: this._pickType(), born: ctx.tick };
    this.items.set(cellKey(item.x, item.y), item);
    this.cooldown = sp.cooldownTicks;
    return { spawned: item, expired };
  }

  _pickType() {
    const w = this.cfg.spawn.weights;
    const total = POWERUP_TYPES.reduce((sum, t) => sum + (w[t] || 0), 0);
    let r = this.rng() * total;
    for (const t of POWERUP_TYPES) {
      r -= w[t] || 0;
      if (r < 0) return t;
    }
    return POWERUP_TYPES[POWERUP_TYPES.length - 1];
  }

  // A valid cell: inside the board (with an edge margin), not on anything, not near any snake, and
  // with at least two open neighbours so it can actually be reached.
  _pickCell(ctx) {
    const sp = this.cfg.spawn;
    const m = sp.edgeMargin;
    const segments = [];
    for (const s of ctx.snakes) if (s.alive) for (const c of s.body) segments.push(c);
    for (let attempt = 0; attempt < sp.maxAttempts; attempt++) {
      const x = m + Math.floor(this.rng() * (this.cols - 2 * m));
      const y = m + Math.floor(this.rng() * (this.rows - 2 * m));
      if (this.has(x, y) || ctx.isBlocked(x, y)) continue;
      if (segments.some((c) => Math.abs(c.x - x) + Math.abs(c.y - y) < sp.minSnakeDistance)) continue;
      let open = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < this.cols && ny < this.rows && !ctx.isBlocked(nx, ny)) open++;
      }
      if (open < 2) continue;
      return { x, y };
    }
    return null; // a crowded board simply skips this spawn attempt
  }
}

// Magnet: every snake whose magnet is active pulls the food around its head one cell closer per tick
// and collects food that is already adjacent. Bounded work (one pass over the food, per magnet), and
// food only ever moves onto free cells, never onto a snake, another food or an item.
//   snakes: alive snakes (any object with head + magnetTicksLeft); the order decides ties, so the
//           caller rotates it each tick to stay fair.
//   food:   FoodManager   isBlocked(x, y): bodies / food / items   collect(snake, cell): eat it
// -> number of food items moved or collected (for tests / diagnostics)
export function magnetPull({ snakes, food, isBlocked, collect, radius = POWERUPS.magnet.radius }) {
  let touched = 0;
  const moved = new Set();
  for (const snake of snakes) {
    if (!(snake.magnetTicksLeft > 0) || !snake.head) continue;
    const hx = snake.head.x;
    const hy = snake.head.y;
    const near = [];
    for (const f of food.items.values()) {
      const dx = f.x - hx;
      const dy = f.y - hy;
      if (Math.abs(dx) <= radius && Math.abs(dy) <= radius) near.push(f);
    }
    for (const f of near) {
      const k = cellKey(f.x, f.y);
      if (moved.has(k) || !food.items.has(k)) continue;
      const dx = hx - f.x;
      const dy = hy - f.y;
      if (Math.abs(dx) + Math.abs(dy) <= 1) {
        food.items.delete(k);
        collect(snake, f);
        touched++;
        continue;
      }
      // one step along the longer axis first, then the other
      const steps = Math.abs(dx) >= Math.abs(dy)
        ? [[Math.sign(dx), 0], [0, Math.sign(dy)]]
        : [[0, Math.sign(dy)], [Math.sign(dx), 0]];
      for (const [sx, sy] of steps) {
        if (sx === 0 && sy === 0) continue;
        const nx = f.x + sx;
        const ny = f.y + sy;
        if (isBlocked(nx, ny)) continue;
        food.items.delete(k);
        const nk = cellKey(nx, ny);
        food.items.set(nk, { x: nx, y: ny });
        moved.add(nk);
        touched++;
        break;
      }
    }
  }
  return touched;
}
