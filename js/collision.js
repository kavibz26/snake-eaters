import { CONFIG, cellKey } from './config.js';

export function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < CONFIG.GRID_COLS && y < CONFIG.GRID_ROWS;
}

export function cellsEqual(a, b) {
  return a.x === b.x && a.y === b.y;
}

// Terrain: the board edge and the map's obstacles. Both are equally lethal (or absorbed by a Shield) -
// this one check is what every simulation (single player, server, predictor) uses for "solid ground".
export function hitsTerrain(obstacles, x, y) {
  return !inBounds(x, y) || Boolean(obstacles && obstacles.has(cellKey(x, y)));
}

// Builds a map of cellKey -> snake for every snake's currently-solid body
// cells (tail excluded when it will vacate this tick, see Snake.collidableBody).
export function buildOccupancyMap(snakes) {
  const map = new Map();
  for (const snake of snakes) {
    if (!snake.alive) continue;
    for (const cell of snake.collidableBody()) {
      map.set(cellKey(cell.x, cell.y), snake);
    }
  }
  return map;
}
