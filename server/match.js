// Authoritative multiplayer simulation. This is the server-side counterpart of
// Game.tick() in js/game.js: same steps, same rules, same shared modules
// (Snake, FoodManager, collision helpers, CONFIG) - minus AI, particles, HUD
// and the single "player" notion. Clients never report state, only intents.
import { CONFIG, cellKey } from '../js/config.js';
import { Snake } from '../js/snake.js';
import { FoodManager } from '../js/food.js';
import { inBounds, cellsEqual, buildOccupancyMap, hitsTerrain } from '../js/collision.js';
import { buildMap, DEFAULT_MAP_ID, isKnownMap } from '../js/maps/maps.js';
import { findSpawn } from '../js/maps/spawn.js';
import { MatchEvents } from '../js/events/tracker.js';
import { getSkinById } from '../js/skins.js';
import { MATCH_MAX_TICKS } from './protocol.js';
import { dirIndex, encodeBodyDelta } from '../js/net/snapcodec.js';
import { PowerUpManager, magnetPull } from '../js/powerups/manager.js';
import { POWERUP_INDEX } from '../js/powerups/config.js';
import { collectSpecial, takesExtraStep, absorbLethal, endOfTickEffects } from '../js/powerups/effects.js';

export class MatchSim {
  // entries: [{ id, name, skinId }]   options: { rng, mapId }
  //   rng: tests inject a seeded generator for the power-up spawner
  //   mapId: which map this match is played on (the lobby's configured map); unknown ids fall back to Classic
  constructor(entries, options = {}) {
    this.tickCount = 0;
    this.events = [];
    this.over = false;
    this.winnerId = null;
    this.endReason = null;
    this.snakes = [];
    this.byId = new Map();
    this.mapId = isKnownMap(options.mapId) ? options.mapId : DEFAULT_MAP_ID;
    this.map = buildMap(this.mapId); // deterministic: the clients build the very same layout from the id
    this.obstacles = this.map.obstacles;
    this.food = new FoodManager(CONFIG.GRID_COLS, CONFIG.GRID_ROWS);
    this.matchEvents = new MatchEvents(); // authoritative: clients only receive events, they can never award them
    this.specials = new PowerUpManager({ rng: options.rng || Math.random }); // server-owned: where items spawn, who collects them

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
    // The Speed power-up rides on the same extra-step mechanism (one extra step every 2nd tick);
    // a snake never takes more than ONE extra step per tick, so Boost + Speed cap at 2 cells/tick.
    const n = this.snakes.length;
    for (let k = 0; k < n; k++) {
      const snake = this.snakes[(k + this.tickCount) % n];
      if (!snake.alive || snake.frozen) continue;
      const boosting = snake.boostTicksLeft > 0;
      const extra = takesExtraStep(snake, this.tickCount);
      if (snake.speedTicksLeft > 0) snake.speedTicksLeft--;
      if (extra) {
        const preOcc = buildOccupancyMap(this.snakes);
        const nh = snake.nextHead();
        if (hitsTerrain(this.obstacles, nh.x, nh.y) || preOcc.has(cellKey(nh.x, nh.y))) {
          if (!this._absorb(snake)) this._killSnake(snake, null, 'boost');
        } else {
          if (this.food.has(nh.x, nh.y)) {
            snake.grow(1);
            snake.foodEaten++;
            snake.score += CONFIG.FOOD_SCORE;
            snake.justAte = true;
            this.food.removeAt(nh.x, nh.y);
            this.events.push({ e: 'eat', id: snake.playerId, x: nh.x, y: nh.y });
          }
          this._pickup(snake, nh.x, nh.y);
          snake.commitMove(nh);
        }
      }
      if (boosting) {
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
      this._pickup(snake, nh.x, nh.y);
    }

    // 4. Solid-body occupancy (frozen snakes included, tail solid).
    const occupancyMap = buildOccupancyMap(this.snakes);
    const deaths = new Map(); // snake -> killer | null
    const bounced = new Set();

    // 5a. Wall and body contact: strictly bigger eats, equal or smaller dies,
    // your own body and walls are always fatal.
    for (const snake of movers) {
      const nh = moves.get(snake);
      if (hitsTerrain(this.obstacles, nh.x, nh.y)) { // wall or obstacle: one lethal rule, one Shield rule
        this._lethal(snake, null, deaths, bounced);
        continue;
      }
      const occupant = occupancyMap.get(cellKey(nh.x, nh.y));
      if (!occupant) continue;
      if (occupant === snake) {
        this._lethal(snake, null, deaths, bounced);
        continue;
      }
      if (deaths.has(occupant)) continue;
      if (snake.length > occupant.length) {
        // The occupant would be eaten. A shield takes the hit instead: the attacker is held back and nobody dies.
        if (this._absorb(occupant)) bounced.add(snake);
        else {
          this._creditKill(snake, occupant);
          deaths.set(occupant, snake);
        }
      } else {
        this._lethal(snake, occupant, deaths, bounced);
      }
    }

    // 5b. Head-to-head pileups on the same free cell.
    const cellGroups = new Map();
    for (const snake of movers) {
      if (deaths.has(snake) || bounced.has(snake)) continue;
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

    // 7b. Power-ups: Magnet pull, then spawn / expire special items, then end-of-tick effect timers.
    const order = this.snakes.filter((s) => s.alive && !s.frozen);
    if (order.length > 1) order.push(...order.splice(0, this.tickCount % order.length)); // rotate: no permanent first-puller edge
    magnetPull({
      snakes: order,
      food: this.food,
      isBlocked: (x, y) => this._isCellBlocked(x, y),
      collect: (snake, f) => {
        snake.grow(1);
        snake.foodEaten++;
        snake.score += CONFIG.FOOD_SCORE;
        snake.justAte = true;
        this.events.push({ e: 'eat', id: snake.playerId, x: f.x, y: f.y });
      },
    });
    this.specials.update({ tick: this.tickCount, snakes: this.snakes, isBlocked: (x, y) => this._isCellBlocked(x, y) });
    for (const s of this.snakes) if (s.alive) endOfTickEffects(s);

    // 8. Keep food topped up.
    this.food.replenish((x, y) => this._isCellBlocked(x, y));

    // 8b. Match events: one cheap pass over the snakes (see js/events/tracker.js).
    this.matchEvents.update(this.tickCount, this.snakes, (s) => s.playerId);
    this._collectMatchEvents();

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
    if (this.over) {
      this.matchEvents.finalize(this.snakes, (s) => s.playerId, this.tickCount); // Longest Snake / Most Food
      this._collectMatchEvents();
    }
  }

  // Newly fired events ride along in this tick's snapshot (`ev`), for every client alike.
  _collectMatchEvents() {
    for (const ev of this.matchEvents.drain()) {
      this.events.push(ev.v !== undefined ? { e: 'mev', k: ev.k, id: ev.id, v: ev.v } : { e: 'mev', k: ev.k, id: ev.id });
    }
  }

  // Everything that has fired so far (sent in `over`, and to a reconnecting player so they never see a repeat).
  eventSummary() {
    return this.matchEvents.summary().map((e) => (e.v !== undefined ? { k: e.k, id: e.id, v: e.v, t: e.t } : { k: e.k, id: e.id, t: e.t }));
  }

  _resolveCollisionGroup(group, deaths, bounced) {
    const maxLen = Math.max(...group.map((s) => s.length));
    const survivors = group.filter((s) => s.length === maxLen);
    if (survivors.length === 1) {
      const winner = survivors[0];
      for (const loser of group) {
        if (loser === winner) continue;
        if (this._absorb(loser)) bounced.add(loser); // the shield holds the loser back: no kill, no death
        else {
          this._creditKill(winner, loser);
          deaths.set(loser, winner);
        }
      }
    } else {
      for (const s of survivors) bounced.add(s);
      for (const s of group) {
        if (survivors.includes(s)) continue;
        if (this._absorb(s)) bounced.add(s);
        else deaths.set(s, null);
      }
    }
  }

  // --- power-ups (the server decides everything: what spawns, who collects, whether a shield blocks) ---

  // The lethal-collision rule (js/powerups/effects.js). true = the shield absorbed it (event emitted).
  _absorb(snake) {
    const r = absorbLethal(snake);
    if (r === 'consumed') this.events.push({ e: 'shield', id: snake.playerId, x: snake.head.x, y: snake.head.y });
    return r !== false;
  }

  // A snake would die here: held in place if a shield absorbs it, otherwise it dies.
  _lethal(snake, killer, deaths, bounced) {
    if (this._absorb(snake)) bounced.add(snake);
    else deaths.set(snake, killer);
  }

  _pickup(snake, x, y) {
    const item = this.specials.take(x, y);
    if (!item) return;
    if (collectSpecial(snake, item.type)) this.events.push({ e: 'pu', id: snake.playerId, k: item.type, x, y });
  }

  _creditKill(winner, loser) {
    this.matchEvents.noteKill(winner.playerId, loser.playerId, this.tickCount);
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
    if (this.food.has(x, y) || this.specials.has(x, y) || this.obstacles.has(cellKey(x, y))) return true;
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
    const taken = new Set(); // cells used by snakes already placed
    entries.forEach((entry, i) => {
      const zone = chosen[i];
      const length = CONFIG.PLAYER_INITIAL_LENGTH; // everyone starts equal
      const dir = CONFIG.DIRECTIONS[dirNames[Math.floor(Math.random() * dirNames.length)]];
      const margin = CONFIG.SPAWN_MARGIN + length;
      const cx = clamp(Math.floor((zone.x0 + zone.x1) / 2), margin, CONFIG.GRID_COLS - 1 - margin);
      const cy = clamp(Math.floor((zone.y0 + zone.y1) / 2), margin, CONFIG.GRID_ROWS - 1 - margin);
      // On a map with obstacles the spawn moves to open ground (unchanged on Classic).
      const spot = findSpawn(this.obstacles, cx, cy, length, dir, 9, taken) || { cx, cy, dir };
      const cells = [];
      for (let seg = 0; seg < length; seg++) cells.push({ x: spot.cx - spot.dir.x * seg, y: spot.cy - spot.dir.y * seg });
      for (const c of cells) taken.add(cellKey(c.x, c.y));

      const snake = new Snake({ isPlayer: true, cells, direction: spot.dir, skin: getSkinById(entry.skinId), profile: null });
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

  _flatSpecials() {
    const out = [];
    for (const i of this.specials.all()) out.push(i.x, i.y, POWERUP_INDEX[i.type]);
    return out;
  }

  // Remembers what the last broadcast contained; the next delta snapshot is
  // expressed relative to it.
  _commitBaseline() {
    this.prevBodies = new Map(this.snakes.map((s) => [s.playerId, this._flatBody(s)]));
    this.prevFood = new Set([...this.food.all()].map((f) => cellKey(f.x, f.y)));
    this.prevSpecials = new Map([...this.specials.all()].map((i) => [cellKey(i.x, i.y), POWERUP_INDEX[i.type]]));
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
        // Active power-up timers [speed, magnet, shield] in ticks; absent when none is active.
        if (s.alive && (s.speedTicksLeft > 0 || s.magnetTicksLeft > 0 || s.shieldTicksLeft > 0)) out.e = [s.speedTicksLeft, s.magnetTicksLeft, s.shieldTicksLeft];
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
      snap.sp = this._flatSpecials();
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
      const nowSp = new Map([...this.specials.all()].map((i) => [cellKey(i.x, i.y), i]));
      const spAdded = [];
      const spRemoved = [];
      for (const [k, i] of nowSp) if (!this.prevSpecials.has(k)) spAdded.push(i.x, i.y, POWERUP_INDEX[i.type]);
      for (const k of this.prevSpecials.keys()) {
        if (!nowSp.has(k)) {
          const [x, y] = k.split(',');
          spRemoved.push(Number(x), Number(y));
        }
      }
      if (spAdded.length) snap.spa = spAdded;
      if (spRemoved.length) snap.spr = spRemoved;
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
      powerups: s.powerupsCollected,
      mega: s.megaCollected,
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
      powerups: r.powerups,
      mega: r.mega,
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
