// Map configuration layer: which obstacles exist on which map. Pure data + one deterministic builder -
// no randomness, no DOM - so the browser, the single-player game and the multiplayer server all build
// EXACTLY the same obstacle layout from a map id. Adding a map = adding one entry to MAPS.
//
// Grid: CONFIG.GRID_COLS x CONFIG.GRID_ROWS (84 x 60). Rectangles are { x, y, w, h } in cells.
// Rules every map must satisfy (enforced by tests): obstacles stay inside the board with a free rim,
// the free cells form ONE connected region (nothing is enclosed), and there is room to spawn.
import { CONFIG, cellKey } from '../config.js';

const R = (x, y, w, h) => ({ x, y, w, h });

export const MAPS = {
  // The original open board: no obstacles at all (current behaviour).
  classic: {
    id: 'classic',
    name: 'Classic',
    blurb: 'Open board',
    rects: [],
  },

  // Several fixed rectangular clusters scattered over the board.
  blocks: {
    id: 'blocks',
    name: 'Blocks',
    blurb: 'Rectangular obstacle clusters',
    rects: [
      R(24, 14, 7, 4), R(53, 14, 7, 4), R(24, 42, 7, 4), R(53, 42, 7, 4), // four slabs
      R(37, 26, 10, 8), // central cluster
      R(6, 25, 3, 10), R(75, 25, 3, 10), // short side walls
      R(12, 6, 4, 4), R(68, 6, 4, 4), R(12, 50, 4, 4), R(68, 50, 4, 4), // small corner posts
    ],
  },

  // Symmetric layout with open lanes: only the top-left quarter is written down and it is mirrored
  // across both axes, so every player has the same map from every side.
  arena: {
    id: 'arena',
    name: 'Arena',
    blurb: 'Symmetric layout with open lanes',
    mirror: 'xy',
    rects: [
      R(8, 6, 10, 2), R(8, 6, 2, 10), // corner brackets
      R(22, 14, 4, 4), // inner pillar
      R(32, 6, 2, 9), // lane divider
      R(34, 24, 8, 2), // centre bar (its mirror leaves an open lane between the two bars)
    ],
  },
};

export const DEFAULT_MAP_ID = 'classic';
export const MAP_IDS = Object.keys(MAPS);

export function isKnownMap(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(MAPS, id);
}

// Unknown ids fall back to the default rather than throwing: a bad id must never break a match.
export function getMapDef(id) {
  return isKnownMap(id) ? MAPS[id] : MAPS[DEFAULT_MAP_ID];
}

function expand(def) {
  const out = [];
  for (const r of def.rects) {
    out.push(r);
    if (def.mirror === 'xy') {
      out.push(R(CONFIG.GRID_COLS - r.x - r.w, r.y, r.w, r.h));
      out.push(R(r.x, CONFIG.GRID_ROWS - r.y - r.h, r.w, r.h));
      out.push(R(CONFIG.GRID_COLS - r.x - r.w, CONFIG.GRID_ROWS - r.y - r.h, r.w, r.h));
    }
  }
  return out;
}

// FNV-1a over the sorted cell keys: a short fingerprint two sides can compare.
function fingerprint(keys) {
  let h = 0x811c9dc5;
  for (const k of [...keys].sort()) {
    for (let i = 0; i < k.length; i++) {
      h ^= k.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x2c;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const cache = new Map();

// -> { id, name, blurb, obstacles: Set<"x,y">, cells: [{x,y}], hash }   (built once per id and shared)
export function buildMap(id) {
  const def = getMapDef(id);
  let built = cache.get(def.id);
  if (built) return built;
  const obstacles = new Set();
  for (const r of expand(def)) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x >= 0 && y >= 0 && x < CONFIG.GRID_COLS && y < CONFIG.GRID_ROWS) obstacles.add(cellKey(x, y));
      }
    }
  }
  const cells = [...obstacles].map((k) => {
    const [x, y] = k.split(',');
    return { x: Number(x), y: Number(y) };
  });
  built = Object.freeze({ id: def.id, name: def.name, blurb: def.blurb, obstacles, cells, hash: fingerprint(obstacles) });
  cache.set(def.id, built);
  return built;
}

export const EMPTY_OBSTACLES = new Set();
