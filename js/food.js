import { CONFIG, cellKey } from './config.js';

export class FoodManager {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.target = Math.floor((cols * rows) / CONFIG.FOOD_TARGET_DIVISOR);
    this.items = new Map(); // key -> {x,y}
  }

  has(x, y) {
    return this.items.has(cellKey(x, y));
  }

  removeAt(x, y) {
    this.items.delete(cellKey(x, y));
  }

  all() {
    return this.items.values();
  }

  get count() {
    return this.items.size;
  }

  // Scatter food at specific cells (e.g. a dead snake's corpse), skipping any
  // cell already occupied per the provided predicate.
  scatterAt(cells, isBlocked) {
    for (const cell of cells) {
      if (isBlocked && isBlocked(cell.x, cell.y)) continue;
      this.items.set(cellKey(cell.x, cell.y), { x: cell.x, y: cell.y });
    }
  }

  // Top up toward the target count, placing new food on cells the caller
  // confirms are free. Spawns gradually (bounded per call) to avoid a visible
  // pop-in burst after a mass die-off.
  replenish(isBlocked, maxSpawnPerTick = 3) {
    let attempts = 0;
    let spawned = 0;
    while (this.items.size < this.target && spawned < maxSpawnPerTick && attempts < 200) {
      attempts++;
      const x = Math.floor(Math.random() * this.cols);
      const y = Math.floor(Math.random() * this.rows);
      if (this.has(x, y)) continue;
      if (isBlocked && isBlocked(x, y)) continue;
      this.items.set(cellKey(x, y), { x, y });
      spawned++;
    }
  }

  render(ctx, cellSize) {
    ctx.save();
    for (const f of this.items.values()) {
      const cx = f.x * cellSize + cellSize / 2;
      const cy = f.y * cellSize + cellSize / 2;
      const r = cellSize * 0.28;
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2);
      gradient.addColorStop(0, '#fff7c2');
      gradient.addColorStop(1, '#ffd23f');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
