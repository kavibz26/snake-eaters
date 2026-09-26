// Spawn placement on maps with obstacles. Shared by the single-player game and the multiplayer server:
// a snake is only ever placed where its body AND the stretch it will drive over first are clear of
// obstacles, so nobody starts the match already trapped against one.
import { CONFIG, cellKey } from '../config.js';

export const SPAWN_CLEARANCE = 3; // cells of free space kept around a spawning snake
export const SPAWN_LOOKAHEAD = 7; // cells straight ahead of the head that must be clear

function clearAround(obstacles, x, y, r) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) if (obstacles.has(cellKey(x + dx, y + dy))) return false;
  }
  return true;
}

// Would a snake of `length` with its head at (cx, cy) heading `dir` sit on open ground?
// `taken`: cells already used by snakes spawned earlier (a moved spawn must not land on them).
export function spawnFits(obstacles, cx, cy, length, dir, taken = null) {
  if (!obstacles || obstacles.size === 0) return true;
  for (let seg = -SPAWN_LOOKAHEAD; seg < length; seg++) {
    const x = cx - dir.x * seg;
    const y = cy - dir.y * seg;
    if (x < 1 || y < 1 || x >= CONFIG.GRID_COLS - 1 || y >= CONFIG.GRID_ROWS - 1) return false;
    if (!clearAround(obstacles, x, y, SPAWN_CLEARANCE)) return false;
    if (seg >= 0 && taken && taken.has(cellKey(x, y))) return false;
  }
  return true;
}

// Prefers the requested spot; otherwise walks outwards (bounded) trying every heading. Returns
// { cx, cy, dir } or null when nothing fits (callers then keep the original spot, which cannot happen
// on the shipped maps - a test proves every zone has a valid spawn).
export function findSpawn(obstacles, cx, cy, length, dir, maxRadius = 9, taken = null) {
  const dirs = [dir, ...Object.values(CONFIG.DIRECTIONS).filter((d) => d !== dir)];
  for (let r = 0; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        for (const d of dirs) if (spawnFits(obstacles, cx + dx, cy + dy, length, d, taken)) return { cx: cx + dx, cy: cy + dy, dir: d };
      }
    }
  }
  return null;
}
