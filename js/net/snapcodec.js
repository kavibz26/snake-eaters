// Snapshot helpers shared by the server (encoding), the browser client
// (decoding) and the tests, so both ends agree on the wire format.
//
// Per-tick snapshots are DELTAS: a snake's body only ever changes by gaining
// new head cells and losing tail cells, so we send just the new head cells
// and the new length. Food is sent as added/removed cells. Full state is
// sent once when a match starts / a player rejoins, and on request ('sync').
import { CONFIG, cellKey } from '../config.js';

export const DIR_VECS = [
  CONFIG.DIRECTIONS.up,
  CONFIG.DIRECTIONS.down,
  CONFIG.DIRECTIONS.left,
  CONFIG.DIRECTIONS.right,
];
export const DIR_NAMES = ['up', 'down', 'left', 'right'];

export function dirIndex(vec) {
  for (let i = 0; i < DIR_VECS.length; i++) {
    if (DIR_VECS[i].x === vec.x && DIR_VECS[i].y === vec.y) return i;
  }
  return -1;
}

const MAX_HEAD_DELTA = 4; // boost (2 moves) + growth never needs more

// prev/next are flat [x0,y0,x1,y1,...] arrays, head first.
// Returns { h, n } (new head cells + new length) or null if a delta can't express it.
export function encodeBodyDelta(prev, next) {
  const newLen = next.length / 2;
  const oldLen = prev.length / 2;
  for (let h = 0; h <= MAX_HEAD_DELTA && h <= newLen; h++) {
    const keep = newLen - h;
    if (keep > oldLen) continue;
    let same = true;
    for (let i = 0; i < keep * 2; i++) {
      if (next[h * 2 + i] !== prev[i]) { same = false; break; }
    }
    if (same) return { h: next.slice(0, h * 2), n: newLen };
  }
  return null;
}

export function applyBodyDelta(prev, heads, n) {
  const keep = n - heads.length / 2;
  if (keep < 0 || keep > prev.length / 2) return null;
  return heads.concat(prev.slice(0, keep * 2));
}

// Rebuilds authoritative state from a stream of snapshots.
export class SnapTracker {
  constructor() {
    this.bodies = new Map(); // player id -> flat cells (head first)
    this.food = new Map(); // "x,y" -> {x,y}
    this.needsSync = false;
  }

  reset() {
    this.bodies.clear();
    this.food.clear();
    this.needsSync = false;
  }

  apply(snap) {
    this.needsSync = false;
    if (snap.full) {
      this.bodies.clear();
      this.food.clear();
    }
    for (const s of snap.snakes) {
      if (!s.a) {
        this.bodies.delete(s.id);
        continue;
      }
      if (s.c) {
        this.bodies.set(s.id, s.c);
        continue;
      }
      const prev = this.bodies.get(s.id);
      const next = prev && applyBodyDelta(prev, s.h || [], s.n);
      if (next) this.bodies.set(s.id, next);
      else this.needsSync = true; // missed state: ask the server for a full snapshot
    }
    if (snap.f) {
      this.food.clear();
      for (let i = 0; i < snap.f.length; i += 2) this.food.set(cellKey(snap.f[i], snap.f[i + 1]), { x: snap.f[i], y: snap.f[i + 1] });
    } else {
      if (snap.fr) for (let i = 0; i < snap.fr.length; i += 2) this.food.delete(cellKey(snap.fr[i], snap.fr[i + 1]));
      if (snap.fa) for (let i = 0; i < snap.fa.length; i += 2) this.food.set(cellKey(snap.fa[i], snap.fa[i + 1]), { x: snap.fa[i], y: snap.fa[i + 1] });
    }
    return this;
  }
}
