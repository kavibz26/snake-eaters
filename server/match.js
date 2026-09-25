// Authoritative multiplayer simulation. This is the server-side counterpart of
// Game.tick() in js/game.js: same steps, same rules, same shared modules
// (Snake, FoodManager, collision helpers, CONFIG) - minus AI, particles, HUD
// and the single "player" notion. Clients never report state, only intents.
import { CONFIG, cellKey } from '../js/config.js';
import { Snake } from '../js/snake.js';
import { FoodManager } from '../js/food.js';
import { inBounds, cellsEqual, buildOccupancyMap } from '../js/collision.js';
import { getSkinById } from '../js/skins.js';
import { MATCH_MAX_TICKS } from './protocol.js';
import { dirIndex, encodeBodyDelta } from '../js/net/snapcodec.js';

export class MatchSim {
  // entries: [{ id, name, skinId }]
  constructor(entries) {
    this.tickCount = 0;
    this.events = [];
    this.over = false;
    this.winnerId = null;
    this.endReason = null;
    this.snakes = [];
    this.byId = new Map();
    this.food = new FoodManager(CONFIG.GRID_COLS, CONFIG.GRID_ROWS);

    this._spawnSnakes(entries);
    for (const s of this.snakes) this._seedSpawnFood(s);
    this.food.replenish((x, y) => this._isCellBlocked(x, y), this.food.target);
    this._commitBaseline();
  }

  // --- intents (the only thing clients can influence) ----------------------

  // Sequenced input from a client. `seq` only ever increases per player; the
  // highest one processed is echoed back in every snapshot (`q`) so the client
  // knows which of its predicted inputs the server has now accounted for.
  // Receipt is acknowledged even when the input can't take effect (dead,
  // frozen, illegal reversal): the authoritative state decides what happens.
  applyInput(id, seq, { dir, boost } = {}) {
    const snake = this.byId.get(id);
    if (!snake || !Number.isSafeInteger(seq) || seq <= snake.lastSeq) return false;
    snake.lastSeq = seq;
    if (!snake.alive || snake.frozen) return true;
    if (dir && CONFIG.DIRECTIONS[dir]) snake.queueDirection(CONFIG.DIRECTIONS[dir]);
    if (boost === true) snake.activateBoost(CONFIG.BOOST_DURATION_TICKS);
    return true;
  }

  setDirection(id, dirName) {
    const snake = this.byId.get(id);
    const dir = CONFIG.DIRECTIONS[dirName];
    if (!snake || !snake.alive || snake.frozen || !dir) return;
    snake.queueDirection(dir);
  }

  activateBoost(id) {
    const snake = this.byId.get(id);
    if (!snake || !snake.alive || snake.frozen) return false;
    return snake.activateBoost(CONFIG.BOOST_DURATION_TICKS);
  }

  // A disconnected player's snake stops in place (still a solid obstacle) for
  // the reconnect grace period rather than driving itself into a wall.
  setFrozen(id, frozen) {
    const snake = this.byId.get(id);
    if (!snake || !snake.alive) return;
    snake.frozen = frozen;
    if (frozen) {
      // Nothing vacates the tail while frozen, so the whole body is solid.
      snake.collidableBody = function () { return this.body; };
    } else {
      delete snake.collidableBody;
    }
  }

  forfeit(id) {
    const snake = this.byId.get(id);
    if (!snake || !snake.alive) return;
    this._killSnake(snake, null, 'forfeit');
  }

  // --- simulation -----------------------------------------------------------

  tick() {
    if (this.over) return;
    this.tickCount++;
    this.events = [];
    for (const s of this.snakes) s.justAte = false;

    // 0. Boost pre-step. A boosting snake gets one extra, self-contained move
    // resolved against the world as it stood before anyone else moved this
    // tick; hitting a wall or any body during it is a plain death (existing
    // rule). Boosters are processed in a rotating order so nobody gets a
    // permanent first-mover edge.
    const n = this.snakes.length;
    for (let k = 0; k < n; k++) {
      const snake = this.snakes[(k + this.tickCount) % n];
      if (!snake.alive || snake.frozen) continue;
      if (snake.boostTicksLeft > 0) {
        const preOcc = buildOccupancyMap(this.snakes);
        const nh = snake.nextHead();
        if (!inBounds(nh.x, nh.y) || preOcc.has(cellKey(nh.x, nh.y))) {
          this._killSnake(snake, null, 'boost');
          continue;
        }
        if (this.food.has(nh.x, nh.y)) {
          snake.grow(1);
          snake.foodEaten++;
          snake.score += CONFIG.FOOD_SCORE;
          snake.justAte = true;
          this.food.removeAt(nh.x, nh.y);
          this.events.push({ e: 'eat', id: snake.playerId, x: nh.x, y: nh.y });
        }
        snake.commitMove(nh);
        snake.boostTicksLeft--;
        if (snake.boostTicksLeft === 0) snake.boostCooldownLeft = CONFIG.BOOST_COOLDOWN_TICKS;
      } else if (snake.boostCooldownLeft > 0) {
        snake.boostCooldownLeft--;
      }
    }

    const movers = this.snakes.filter((s) => s.alive && !s.frozen);

    // 2. Each mover's intended next head cell.
    const moves = new Map();
    for (const snake of movers) moves.set(snake, snake.nextHead());

    // 3. Food consumption (decides who grows, which affects collisions below).
    for (const snake of movers) {
      const nh = moves.get(snake);
      if (this.food.has(nh.x, nh.y)) {
        snake.grow(1);
        snake.foodEaten++;
        snake.score += CONFIG.FOOD_SCORE;
        snake.justAte = true;
        this.food.removeAt(nh.x, nh.y);
        this.events.push({ e: 'eat', id: snake.playerId, x: nh.x, y: nh.y });
      }
    }

    // 4. Solid-body occupancy (frozen snakes included, tail solid).
    const occupancyMap = buildOccupancyMap(this.snakes);
    const deaths = new Map(); // snake -> killer | null
    const bounced = new Set();

    // 5a. Wall and body contact: strictly bigger eats, equal or smaller dies,
    // your own body and walls are always fatal.
    for (const snake of movers) {
      const nh = moves.get(snake);
      if (!inBounds(nh.x, nh.y)) {
        deaths.set(snake, null);
        continue;
      }
      const occupant = occupancyMap.get(cellKey(nh.x, nh.y));
      if (!occupant) continue;
      if (occupant === snake) {
        deaths.set(snake, null);
        continue;
      }
      if (deaths.has(occupant)) continue;
      if (snake.length > occupant.length) {
        this._creditKill(snake, occupant);
        deaths.set(occupant, snake);
      } else {
        deaths.set(snake, occupant);
      }
    }

    // 5b. Head-to-head pileups on the same free cell.
    const cellGroups = new Map();
    for (const snake of movers) {
      if (deaths.has(snake)) continue;
      const nh = moves.get(snake);
      if (!inBounds(nh.x, nh.y)) continue;
      const key = cellKey(nh.x, nh.y);
      if (!cellGroups.has(key)) cellGroups.set(key, []);
      cellGroups.get(key).push(snake);
    }
    for (const group of cellGroups.values()) {
      if (group.length < 2) continue;
      this._resolveCollisionGroup(group, deaths, bounced);
    }

    // 5c. Crossing pairs swapping cells.
    for (let i = 0; i < movers.length; i++) {
      for (let j = i + 1; j < movers.length; j++) {
        const a = movers[i];
        const b = movers[j];
        if (deaths.has(a) || deaths.has(b) || bounced.has(a) || bounced.has(b)) continue;
        if (cellsEqual(moves.get(a), b.head) && cellsEqual(moves.get(b), a.head)) {
          this._resolveCollisionGroup([a, b], deaths, bounced);
        }
      }
    }

    // 6. Apply moves for everyone still standing.
    for (const snake of movers) {
      if (deaths.has(snake) || bounced.has(snake)) continue;
      snake.commitMove(moves.get(snake));
    }

    // 7. Process deaths.
    for (const [snake, killer] of deaths) {
      this._killSnake(snake, killer, killer ? 'eaten' : 'crash');
    }

    // 8. Keep food topped up.
    this.food.replenish((x, y) => this._isCellBlocked(x, y));

    // 9. End conditions: last snake standing, or the time cap.
    const alive = this.snakes.filter((s) => s.alive);
    if (alive.length <= 1) {
      this.over = true;
      this.winnerId = alive.length === 1 ? alive[0].playerId : null;
      this.endReason = alive.length === 1 ? 'last_standing' : 'draw';
    } else if (this.tickCount >= MATCH_MAX_TICKS) {
      this.over = true;
      const top = Math.max(...alive.map((s) => s.length));
      const leaders = alive.filter((s) => s.length === top);
      this.winnerId = leaders.length === 1 ? leaders[0].playerId : null;
      this.endReason = 'time_limit';
    }
  }

  _resolveCollisionGroup(group, deaths, bounced) {
    const maxLen = Math.max(...group.map((s) => s.length));
    const survivors = group.filter((s) => s.length === maxLen);
    if (survivors.length === 1) {
      const winner = survivors[0];
      for (const loser of group) {
        if (loser === winner) continue;
        this._creditKill(winner, loser);
        deaths.set(loser, winner);
      }
    } else {
      for (const s of survivors) bounced.add(s);
      for (const s of group) {
        if (!survivors.includes(s)) deaths.set(s, null);
      }
    }
  }

  _creditKill(winner, loser) {
    winner.grow(Math.ceil(loser.length * CONFIG.KILL_GROWTH_RATIO));
    winner.eliminations += 1;
    winner.score += CONFIG.KILL_SCORE;
    winner.justAte = true;
  }

  _killSnake(snake, killer, cause) {
    if (!snake.alive) return;
    const head = snake.head;
    snake.kill();
    snake.diedTick = this.tickCount;
    if (snake.frozen) {
      snake.frozen = false;
      delete snake.collidableBody;
    }
    this.food.scatterAt(snake.corpseFoodCells(), (x, y) => this.food.has(x, y));
    if (killer) {
      this.events.push({ e: 'kill', x: head.x, y: head.y, killer: killer.playerId, victim: snake.playerId });
    } else {
      this.events.push({ e: 'death', x: head.x, y: head.y, id: snake.playerId, cause });
    }
  }

  _isCellBlocked(x, y) {
    if (this.food.has(x, y)) return true;
    for (const s of this.snakes) {
      if (!s.alive) continue;
      for (const c of s.body) {
        if (c.x === x && c.y === y) return true;
      }
    }
    return false;
  }

  // --- spawning ---------------------------------------------------------------

  _spawnSnakes(entries) {
    const count = entries.length;
    const zonesX = Math.ceil(Math.sqrt(count + 1));
    const zonesY = Math.ceil((count + 1) / zonesX);
    const zoneW = Math.floor(CONFIG.GRID_COLS / zonesX);
    const zoneH = Math.floor(CONFIG.GRID_ROWS / zonesY);
    const zones = [];
    for (let zy = 0; zy < zonesY; zy++) {
      for (let zx = 0; zx < zonesX; zx++) {
        zones.push({ x0: zx * zoneW, y0: zy * zoneH, x1: zx * zoneW + zoneW, y1: zy * zoneH + zoneH });
      }
    }
    shuffle(zones);

    // Greedy farthest-first pick so nobody spawns next to another player.
    const centerOf = (z) => ({ x: Math.floor((z.x0 + z.x1) / 2), y: Math.floor((z.y0 + z.y1) / 2) });
    const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    const chosen = [zones.shift()];
    while (chosen.length < count) {
      let bestIdx = 0;
      let bestMin = -1;
      zones.forEach((z, idx) => {
        const minD = Math.min(...chosen.map((c) => dist(centerOf(z), centerOf(c))));
        if (minD > bestMin) {
          bestMin = minD;
          bestIdx = idx;
        }
      });
      chosen.push(zones.splice(bestIdx, 1)[0]);
    }
    shuffle(chosen);

    const dirNames = Object.keys(CONFIG.DIRECTIONS);
    entries.forEach((entry, i) => {
      const zone = chosen[i];
      const length = CONFIG.PLAYER_INITIAL_LENGTH; // everyone starts equal
      const dir = CONFIG.DIRECTIONS[dirNames[Math.floor(Math.random() * dirNames.length)]];
      const margin = CONFIG.SPAWN_MARGIN + length;
      const cx = clamp(Math.floor((zone.x0 + zone.x1) / 2), margin, CONFIG.GRID_COLS - 1 - margin);
      const cy = clamp(Math.floor((zone.y0 + zone.y1) / 2), margin, CONFIG.GRID_ROWS - 1 - margin);
      const cells = [];
      for (let seg = 0; seg < length; seg++) cells.push({ x: cx - dir.x * seg, y: cy - dir.y * seg });

      const snake = new Snake({ isPlayer: true, cells, direction: dir, skin: getSkinById(entry.skinId), profile: null });
      snake.playerId = entry.id;
      snake.name = entry.name;
      snake.skinId = entry.skinId;
      snake.frozen = false;
      snake.lastSeq = 0;
      snake.joinIndex = i;
      this.snakes.push(snake);
      this.byId.set(entry.id, snake);
    });
  }

  _seedSpawnFood(snake) {
    const r = CONFIG.PLAYER_SPAWN_FOOD_RADIUS;
    const cells = [];
    let attempts = 0;
    while (cells.length < CONFIG.PLAYER_SPAWN_FOOD_COUNT && attempts < 300) {
      attempts++;
      const x = snake.head.x + Math.floor(Math.random() * (r * 2 + 1)) - r;
      const y = snake.head.y + Math.floor(Math.random() * (r * 2 + 1)) - r;
      if (!inBounds(x, y)) continue;
      if (this._isCellBlocked(x, y)) continue;
      if (cells.some((c) => c.x === x && c.y === y)) continue;
      cells.push({ x, y });
    }
    this.food.scatterAt(cells, (x, y) => this.food.has(x, y));
  }

  // --- output -----------------------------------------------------------------

  // Deterministic live ranking: higher score first; ties go to a living snake,
  // then more kills, then join order. The server owns this order - clients
  // just display it (snapshot `lb` holds indices into `snakes`).
  leaderboardOrder() {
    return this.snakes
      .map((s, idx) => ({ s, idx }))
      .sort((a, b) => (
        (b.s.score - a.s.score)
        || ((b.s.alive ? 1 : 0) - (a.s.alive ? 1 : 0))
        || (b.s.eliminations - a.s.eliminations)
        || (a.s.joinIndex - b.s.joinIndex)
      ))
      .map((r) => r.idx);
  }

  _flatBody(s) {
    const cells = [];
    if (s.alive) for (const c of s.body) cells.push(c.x, c.y);
    return cells;
  }

  _flatFood() {
    const out = [];
    for (const f of this.food.all()) out.push(f.x, f.y);
    return out;
  }

  // Remembers what the last broadcast contained; the next delta snapshot is
  // expressed relative to it.
  _commitBaseline() {
    this.prevBodies = new Map(this.snakes.map((s) => [s.playerId, this._flatBody(s)]));
    this.prevFood = new Set([...this.food.all()].map((f) => cellKey(f.x, f.y)));
  }

  // full = true: complete state (match start, rejoin, resync request) - never
  // touches the delta baseline, so it can be sent to one player at any time.
  // Otherwise a compact delta against the previous broadcast tick.
  snapshot({ full = false } = {}) {
    const snap = {
      t: 'snap',
      tick: this.tickCount,
      snakes: this.snakes.map((s) => {
        const cells = this._flatBody(s);
        const out = {
          id: s.playerId,
          a: s.alive ? 1 : 0,
          d: [s.direction.x, s.direction.y],
          sc: s.score,
          k: s.eliminations,
          ate: s.justAte ? 1 : 0,
          b: [s.boostTicksLeft, s.boostCooldownLeft],
          fz: s.frozen ? 1 : 0,
          q: s.lastSeq, // last input sequence number the server has processed for this player
        };
        if (s.alive) {
          // State the client needs to keep predicting this snake exactly like
          // the server would (turns already accepted but not yet moved on).
          const pd = dirIndex(s.pendingDirection);
          const ib = s.inputBuffer.length ? dirIndex(s.inputBuffer[0]) : -1;
          if (pd !== dirIndex(s.direction) || ib >= 0) out.p = [pd, ib];
          if (s.growPending > 0) out.g = s.growPending;

          const delta = full ? null : encodeBodyDelta(this.prevBodies.get(s.playerId) || [], cells);
          if (delta) {
            out.n = delta.n;
            if (delta.h.length) out.h = delta.h;
          } else {
            out.c = cells;
          }
        }
        return out;
      }),
      lb: this.leaderboardOrder(),
      ev: full ? [] : this.events,
    };

    if (full) {
      snap.full = 1;
      snap.f = this._flatFood();
    } else {
      const now = new Map([...this.food.all()].map((f) => [cellKey(f.x, f.y), f]));
      const added = [];
      const removed = [];
      for (const [k, f] of now) if (!this.prevFood.has(k)) added.push(f.x, f.y);
      for (const k of this.prevFood) {
        if (!now.has(k)) {
          const [x, y] = k.split(',');
          removed.push(Number(x), Number(y));
        }
      }
      if (added.length) snap.fa = added;
      if (removed.length) snap.fr = removed;
      this._commitBaseline();
    }
    return snap;
  }

  results() {
    const rows = this.snakes.map((s) => ({
      id: s.playerId,
      name: s.name,
      skinId: s.skinId,
      score: s.score,
      length: s.length,
      kills: s.eliminations,
      alive: s.alive,
      diedTick: s.alive ? Infinity : (s.diedTick ?? 0),
      joinIndex: s.joinIndex,
    }));
    rows.sort((a, b) => {
      if (a.id === this.winnerId) return -1;
      if (b.id === this.winnerId) return 1;
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (b.diedTick !== a.diedTick) return b.diedTick - a.diedTick;
      return (b.score - a.score) || (a.joinIndex - b.joinIndex);
    });
    return rows.map((r, i) => ({
      rank: i + 1,
      id: r.id,
      name: r.name,
      skinId: r.skinId,
      score: r.score,
      length: r.length,
      kills: r.kills,
      survived: r.alive,
    }));
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
