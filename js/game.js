import { CONFIG, cellKey } from './config.js';
import { Snake } from './snake.js';
import { FoodManager } from './food.js';
import { inBounds, cellsEqual, buildOccupancyMap } from './collision.js';
import { decideAIDirection, getAIDisplayState } from './ai.js';
import { SKINS, DEFAULT_SKIN_ID, getSkinById } from './skins.js';
import { paintSnakeSegment, roundedSquare } from './snakeRender.js';

const AI_PROFILES = ['forager', 'hunter', 'cautious'];

export class Game {
  constructor(canvas, hud) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hud = hud;
    this.state = 'idle'; // idle | playing | paused | gameover
    this.rafId = null;
    this.lastTs = 0;
    this.accumulator = 0;
    this.particles = [];
    this.onGameOver = null; // callback({ victory, score, length, eliminations, remaining })
    this.playerSkin = getSkinById(DEFAULT_SKIN_ID); // overridable via setPlayerSkin() for skins

    this._loop = this._loop.bind(this);
    this._setupCanvas();
  }

  setPlayerSkin(skin) {
    if (skin) this.playerSkin = skin;
  }

  // High-res pixel buffer for crisp rendering; the element's on-screen box
  // size is controlled entirely by CSS (aspect-ratio) so it stays responsive.
  _setupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = CONFIG.GRID_COLS * CONFIG.CELL_SIZE;
    const h = CONFIG.GRID_ROWS * CONFIG.CELL_SIZE;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.scale(dpr, dpr);
  }

  get playerSnake() {
    return this.snakes.find((s) => s.isPlayer);
  }

  init() {
    this.snakes = this._spawnSnakes();
    this.food = new FoodManager(CONFIG.GRID_COLS, CONFIG.GRID_ROWS);
    this._seedPlayerSpawnFood();
    this.food.replenish((x, y) => this._isCellBlocked(x, y), this.food.target);
    this.particles = [];
    this.state = 'playing';
    this.tickCount = 0;
    this._updateHud('Playing');
  }

  // Guarantees a reachable cluster of food near the player's spawn, on top
  // of (before, so it doesn't shrink) the normal arena-wide replenishment -
  // the player shouldn't have to get lucky to find their first few meals.
  _seedPlayerSpawnFood() {
    const player = this.playerSnake;
    const r = CONFIG.PLAYER_SPAWN_FOOD_RADIUS;
    const cells = [];
    let attempts = 0;
    while (cells.length < CONFIG.PLAYER_SPAWN_FOOD_COUNT && attempts < 300) {
      attempts++;
      const x = player.head.x + Math.floor(Math.random() * (r * 2 + 1)) - r;
      const y = player.head.y + Math.floor(Math.random() * (r * 2 + 1)) - r;
      if (!inBounds(x, y)) continue;
      if (this._isCellBlocked(x, y)) continue;
      if (cells.some((c) => c.x === x && c.y === y)) continue;
      cells.push({ x, y });
    }
    this.food.scatterAt(cells, (x, y) => this.food.has(x, y));
  }

  restart() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.init();
    this.start();
  }

  start() {
    this.lastTs = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this._loop);
  }

  togglePause() {
    if (this.state === 'playing') {
      this.state = 'paused';
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this._updateHud('Paused');
      this.render();
    } else if (this.state === 'paused') {
      this.state = 'playing';
      this.lastTs = performance.now();
      this.accumulator = 0;
      this._updateHud('Playing');
      this.rafId = requestAnimationFrame(this._loop);
    }
  }

  setPlayerDirection(dir) {
    if (this.state !== 'playing') return;
    const player = this.playerSnake;
    if (player && player.alive) player.queueDirection(dir);
  }

  activateBoost() {
    if (this.state !== 'playing') return false;
    const player = this.playerSnake;
    if (!player || !player.alive) return false;
    return player.activateBoost(CONFIG.BOOST_DURATION_TICKS);
  }

  _loop(ts) {
    let dt = ts - this.lastTs;
    this.lastTs = ts;
    if (dt > 250) dt = 250;
    this.accumulator += dt;

    let ticks = 0;
    while (this.accumulator >= CONFIG.TICK_MS && ticks < CONFIG.MAX_CATCHUP_TICKS) {
      this.tick();
      this.accumulator -= CONFIG.TICK_MS;
      ticks++;
      if (this.state !== 'playing') break;
    }

    this._stepParticles(dt);
    this.render();

    if (this.state === 'playing') {
      this.rafId = requestAnimationFrame(this._loop);
    }
  }

  // --- simulation -----------------------------------------------------

  tick() {
    this.tickCount++;
    for (const s of this.snakes) s.justAte = false;

    const player = this.playerSnake;

    // 0. Boost pre-step: while boosting, the player gets one extra, fully
    // self-contained move before the shared tick even starts - resolved
    // against a snapshot of the world as it stood a moment ago (nobody else
    // has moved yet this tick), then AI react to the player's new position
    // exactly as normal. This is what makes boost genuinely faster rather
    // than a cosmetic effect, without touching the AI/collision pipeline at
    // all. A boost-step death is unambiguous - the player drove into
    // something in isolation - so it's treated as a normal, fair death.
    if (player.alive && player.boostTicksLeft > 0) {
      const preOcc = buildOccupancyMap(this.snakes);
      const nh = player.nextHead();
      if (!inBounds(nh.x, nh.y) || preOcc.has(cellKey(nh.x, nh.y))) {
        player.kill();
        this.food.scatterAt(player.corpseFoodCells(), (x, y) => this.food.has(x, y));
        this._spawnDeathParticles(player.head, player.color);
        this._endGame(false);
        return;
      }
      if (this.food.has(nh.x, nh.y)) {
        player.grow(1);
        player.foodEaten++;
        player.score += CONFIG.FOOD_SCORE;
        player.justAte = true;
        this.food.removeAt(nh.x, nh.y);
        this._spawnEatParticles(nh);
      }
      player.commitMove(nh);

      player.boostTicksLeft--;
      if (player.boostTicksLeft === 0) player.boostCooldownLeft = CONFIG.BOOST_COOLDOWN_TICKS;
    } else if (player.boostCooldownLeft > 0) {
      player.boostCooldownLeft--;
    }

    const aliveSnakes = this.snakes.filter((s) => s.alive);

    // 1. AI decisions, based on current (pre-move) positions. playerPressure
    // is shared across this tick's decisions so AI collectively cap how many
    // of them commit to attacking the player at once (see ai.js).
    const preMoveOccupancy = buildOccupancyMap(this.snakes);
    const playerPressure = { count: 0, cap: CONFIG.MAX_PLAYER_ATTACKERS };
    for (const snake of aliveSnakes) {
      if (!snake.isPlayer) {
        const dir = decideAIDirection(snake, {
          snakes: this.snakes,
          foodManager: this.food,
          occupancyMap: preMoveOccupancy,
          matchTicks: this.tickCount,
          playerPressure,
        });
        snake.setDirection(dir);
      }
    }

    // 2. Resolve each snake's intended next head cell.
    const moves = new Map();
    for (const snake of aliveSnakes) moves.set(snake, snake.nextHead());

    // 3. Food consumption (determines who grows, which affects collision below).
    for (const snake of aliveSnakes) {
      const nh = moves.get(snake);
      if (this.food.has(nh.x, nh.y)) {
        snake.grow(1);
        snake.foodEaten++;
        snake.score += CONFIG.FOOD_SCORE;
        snake.justAte = true;
        this.food.removeAt(nh.x, nh.y);
        // Visible feedback for the player's own progression only - the same
        // burst for every AI snack would just be noise.
        if (snake.isPlayer) this._spawnEatParticles(nh);
      }
    }

    // 4. Solid-body occupancy for this tick (tail cells excluded unless growing).
    const occupancyMap = buildOccupancyMap(this.snakes);

    const deaths = new Map(); // snake -> killer snake | null
    const bounced = new Set();

    // 5a. Wall and body collisions. Touching ANY part of another snake -
    // head or body, it doesn't matter - resolves purely by length: strictly
    // bigger eats and survives, equal or smaller dies. Your own body is
    // always fatal to touch regardless of size (you can't eat yourself),
    // and a wall is always fatal too. Same rule for the player and every AI.
    for (const snake of aliveSnakes) {
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
      if (deaths.has(occupant)) continue; // already eliminated by someone else this tick
      if (snake.length > occupant.length) {
        this._creditKill(snake, occupant);
        deaths.set(occupant, snake);
      } else {
        deaths.set(snake, occupant);
      }
    }

    // 5b. Head-to-head pileups: multiple snakes converging on the same free cell.
    const cellGroups = new Map();
    for (const snake of aliveSnakes) {
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

    // 5c. Crossing pairs: two snakes swap positions by passing through each other.
    for (let i = 0; i < aliveSnakes.length; i++) {
      for (let j = i + 1; j < aliveSnakes.length; j++) {
        const a = aliveSnakes[i];
        const b = aliveSnakes[j];
        if (deaths.has(a) || deaths.has(b) || bounced.has(a) || bounced.has(b)) continue;
        const ah = moves.get(a);
        const bh = moves.get(b);
        if (cellsEqual(ah, b.head) && cellsEqual(bh, a.head)) {
          this._resolveCollisionGroup([a, b], deaths, bounced);
        }
      }
    }

    // 6. Apply moves for everyone still standing.
    for (const snake of aliveSnakes) {
      if (deaths.has(snake) || bounced.has(snake)) continue;
      snake.commitMove(moves.get(snake));
    }

    // 7. Process deaths: scatter corpse food, spawn feedback particles. A
    // death with a credited killer (eaten by a bigger snake) gets the bigger,
    // more dramatic kill effect; an unattributed death (wall, self) gets the
    // plain burst.
    for (const [snake, killer] of deaths) {
      snake.kill();
      this.food.scatterAt(snake.corpseFoodCells(), (x, y) => this.food.has(x, y));
      if (killer) {
        this._spawnKillEffect(snake.head, killer.color, snake.color);
      } else {
        this._spawnDeathParticles(snake.head, snake.color);
      }
    }

    // 8. Keep food topped up.
    this.food.replenish((x, y) => this._isCellBlocked(x, y));

    // 9. End conditions.
    if (!player.alive) {
      this._endGame(false);
      return;
    }
    const remainingAI = this.snakes.filter((s) => s.alive && !s.isPlayer).length;
    if (remainingAI === 0) {
      this._endGame(true);
      return;
    }

    this._updateHud('Playing');
  }

  // Resolves a group of 2+ snakes whose heads land on/cross the same cell this
  // tick. Larger snake eats smaller ones; a tie among the largest bounces
  // (move cancelled, nobody dies) rather than resolving death arbitrarily.
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

  // The one reward path for every kill in the game, however it happened
  // (running into a bigger snake's body, or a head-to-head/crossing win):
  // same growth bonus, same score, same elimination credit.
  _creditKill(winner, loser) {
    winner.grow(Math.ceil(loser.length * CONFIG.KILL_GROWTH_RATIO));
    winner.eliminations += 1;
    winner.score += CONFIG.KILL_SCORE;
    winner.justAte = true;
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

  _endGame(victory) {
    this.state = 'gameover';
    if (this.rafId) cancelAnimationFrame(this.rafId);
    const player = this.playerSnake;
    this._updateHud(victory ? 'Victory!' : 'Eliminated');
    if (this.onGameOver) {
      this.onGameOver({
        victory,
        score: player.score,
        length: player.length,
        eliminations: player.eliminations,
      });
    }
  }

  _updateHud(status) {
    const player = this.playerSnake;
    if (!player) return;
    let boostState = 'ready';
    let boostSeconds = 0;
    if (player.boostTicksLeft > 0) {
      boostState = 'active';
      boostSeconds = player.boostTicksLeft * CONFIG.TICK_MS / 1000;
    } else if (player.boostCooldownLeft > 0) {
      boostState = 'cooldown';
      boostSeconds = player.boostCooldownLeft * CONFIG.TICK_MS / 1000;
    }
    this.hud.update({
      score: player.score,
      length: player.length,
      eliminations: player.eliminations,
      remaining: this.snakes.filter((s) => s.alive).length,
      status,
      boostState,
      boostSeconds,
    });
  }

  // --- spawning ---------------------------------------------------------

  _spawnSnakes() {
    const count = 1 + CONFIG.AI_COUNT;
    // Size the zone grid for count+1 so there's always at least one unused
    // zone of slack - without it, a low AI_COUNT packs every zone with no
    // buffer between spawns, undermining the "isolate the player" pass below.
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
    const usedZones = zones.slice(0, count);

    // Give the player whichever of the randomly-chosen zones has the most
    // breathing room from every other occupied zone, so the match never
    // opens with AI spawned right on top of them.
    const centerOf = (z) => ({ x: Math.floor((z.x0 + z.x1) / 2), y: Math.floor((z.y0 + z.y1) / 2) });
    let playerZoneIdx = 0;
    let bestMinDist = -1;
    for (let i = 0; i < usedZones.length; i++) {
      const ci = centerOf(usedZones[i]);
      let minDist = Infinity;
      for (let j = 0; j < usedZones.length; j++) {
        if (i === j) continue;
        const cj = centerOf(usedZones[j]);
        minDist = Math.min(minDist, Math.abs(ci.x - cj.x) + Math.abs(ci.y - cj.y));
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        playerZoneIdx = i;
      }
    }
    [usedZones[0], usedZones[playerZoneIdx]] = [usedZones[playerZoneIdx], usedZones[0]];

    // AI snakes each get one of the other skins for the match, shuffled so
    // the lineup varies run to run - the player's current skin is excluded
    // so nobody is a visual duplicate of the player.
    const aiSkinPool = SKINS.filter((s) => s.id !== this.playerSkin.id);
    shuffle(aiSkinPool);

    const dirNames = Object.keys(CONFIG.DIRECTIONS);
    const snakes = [];
    for (let i = 0; i < count; i++) {
      const zone = usedZones[i];
      const isPlayer = i === 0;
      const length = isPlayer ? CONFIG.PLAYER_INITIAL_LENGTH : CONFIG.INITIAL_SNAKE_LENGTH;
      const dirName = dirNames[Math.floor(Math.random() * dirNames.length)];
      const dir = CONFIG.DIRECTIONS[dirName];
      const margin = CONFIG.SPAWN_MARGIN + length;

      const cx = clamp(
        Math.floor((zone.x0 + zone.x1) / 2),
        margin,
        CONFIG.GRID_COLS - 1 - margin
      );
      const cy = clamp(
        Math.floor((zone.y0 + zone.y1) / 2),
        margin,
        CONFIG.GRID_ROWS - 1 - margin
      );

      const cells = [];
      for (let seg = 0; seg < length; seg++) {
        cells.push({ x: cx - dir.x * seg, y: cy - dir.y * seg });
      }

      snakes.push(new Snake({
        isPlayer,
        cells,
        direction: dir,
        skin: isPlayer ? this.playerSkin : aiSkinPool[(i - 1) % aiSkinPool.length],
        profile: isPlayer ? null : AI_PROFILES[(i - 1) % AI_PROFILES.length],
      }));
    }
    return snakes;
  }

  // --- particles ----------------------------------------------------------

  // A small, cheap upward puff so eating food reads as a rewarding moment,
  // not just a HUD number ticking up.
  _spawnEatParticles(cell) {
    const cx = cell.x * CONFIG.CELL_SIZE + CONFIG.CELL_SIZE / 2;
    const cy = cell.y * CONFIG.CELL_SIZE + CONFIG.CELL_SIZE / 2;
    for (let i = 0; i < 6; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const speed = 40 + Math.random() * 40;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 250 + Math.random() * 120,
        color: '#ffd23f',
      });
    }
  }

  _spawnDeathParticles(cell, color) {
    const cx = cell.x * CONFIG.CELL_SIZE + CONFIG.CELL_SIZE / 2;
    const cy = cell.y * CONFIG.CELL_SIZE + CONFIG.CELL_SIZE / 2;
    for (let i = 0; i < 18; i++) {
      const angle = (Math.PI * 2 * i) / 18 + Math.random() * 0.3;
      const speed = 60 + Math.random() * 90;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 450 + Math.random() * 200,
        color,
      });
    }
  }

  // The signature moment for any kill (player or AI, either side of the
  // combat rule): a bigger burst than a normal death, a bright shockwave
  // ring in the killer's own color (so it reads as "this snake did it"),
  // and a floating callout - a kill should feel unmistakably different from
  // an ordinary elimination.
  _spawnKillEffect(cell, killerColor, victimColor) {
    const cx = cell.x * CONFIG.CELL_SIZE + CONFIG.CELL_SIZE / 2;
    const cy = cell.y * CONFIG.CELL_SIZE + CONFIG.CELL_SIZE / 2;
    for (let i = 0; i < 26; i++) {
      const angle = (Math.PI * 2 * i) / 26 + Math.random() * 0.25;
      const speed = 90 + Math.random() * 140;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 500 + Math.random() * 250,
        color: victimColor,
      });
    }
    this.particles.push({
      type: 'ring',
      x: cx,
      y: cy,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 420,
      color: killerColor,
    });
    this.particles.push({
      type: 'text',
      text: 'ELIMINATED',
      x: cx,
      y: cy - 10,
      vx: 0,
      vy: -26,
      life: 0,
      maxLife: 850,
      color: '#ffffff',
    });
  }

  _stepParticles(dt) {
    if (!this.particles.length) return;
    const dtS = dt / 1000;
    this.particles = this.particles.filter((p) => {
      p.life += dt;
      p.x += p.vx * dtS;
      p.y += p.vy * dtS;
      p.vx *= 0.92;
      p.vy *= 0.92;
      return p.life < p.maxLife;
    });
  }

  // --- rendering ------------------------------------------------------

  render() {
    const ctx = this.ctx;
    const w = CONFIG.GRID_COLS * CONFIG.CELL_SIZE;
    const h = CONFIG.GRID_ROWS * CONFIG.CELL_SIZE;

    ctx.clearRect(0, 0, w, h);
    this._renderBackground(ctx, w, h);
    this.food.render(ctx, CONFIG.CELL_SIZE);
    for (const snake of this.snakes) {
      if (snake.alive) this._renderSnake(ctx, snake);
    }
    this._renderParticles(ctx);
  }

  _renderBackground(ctx, w, h) {
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1;
    const cs = CONFIG.CELL_SIZE;
    ctx.beginPath();
    for (let x = 0; x <= CONFIG.GRID_COLS; x++) {
      ctx.moveTo(x * cs + 0.5, 0);
      ctx.lineTo(x * cs + 0.5, h);
    }
    for (let y = 0; y <= CONFIG.GRID_ROWS; y++) {
      ctx.moveTo(0, y * cs + 0.5);
      ctx.lineTo(w, y * cs + 0.5);
    }
    ctx.stroke();

    const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.7);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }

  _renderSnake(ctx, snake) {
    const cs = CONFIG.CELL_SIZE;
    const n = snake.body.length;
    for (let i = n - 1; i >= 0; i--) {
      const seg = snake.body[i];
      const t = 1 - i / Math.max(1, n - 1); // 1 at head, 0 at tail
      const isHead = i === 0;
      const size = cs * (isHead ? 0.94 : 0.72 + 0.2 * t);
      const x = seg.x * cs + cs / 2;
      const y = seg.y * cs + cs / 2;
      const alpha = isHead ? 1 : 0.55 + 0.45 * t;

      paintSnakeSegment(ctx, snake.skin, x, y, size, i, isHead, snake.justAte, alpha);

      if (isHead) {
        this._renderEyes(ctx, snake, x, y, size);
      }
    }

    if (snake.isPlayer) {
      this._renderPlayerMarker(ctx, snake);
    } else {
      this._renderAIIntentMarker(ctx, snake);
    }
  }

  // Lets the player read an AI's intent at a glance: a pulsing red outline
  // means it's actively hunting the player specifically (the one case that
  // demands a reaction), amber means it's fleeing from something. Foraging
  // AI get no marker at all, so the signal stays meaningful instead of noisy.
  _renderAIIntentMarker(ctx, snake) {
    const state = getAIDisplayState(snake);
    if (!state) return;
    let color = null;
    if (state.mode === 'attack' && state.targetingPlayer) color = '#ff4d4d';
    else if (state.mode === 'flee') color = '#ffcf4d';
    if (!color) return;

    const cs = CONFIG.CELL_SIZE;
    const head = snake.body[0];
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4 + 0.4 * pulse;
    ctx.lineWidth = 2;
    roundedSquare(ctx, head.x * cs + 1, head.y * cs + 1, cs - 2, cs - 2, cs * 0.35);
    ctx.stroke();
    ctx.restore();
  }

  // Pulsing outline + a floating "YOU" tag, so the player's snake is never
  // ambiguous even in a crowd of similarly-sized AI snakes. Boosting swaps
  // the outline to a fast-pulsing bright cyan so the speed-up is unmistakable.
  _renderPlayerMarker(ctx, snake) {
    const cs = CONFIG.CELL_SIZE;
    const head = snake.body[0];
    const boosting = snake.boostTicksLeft > 0;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / (boosting ? 80 : 220));

    ctx.save();
    ctx.strokeStyle = boosting ? `rgba(120,230,255,${0.6 + 0.4 * pulse})` : `rgba(255,255,255,${0.45 + 0.35 * pulse})`;
    ctx.lineWidth = boosting ? 3 : 2;
    ctx.shadowColor = boosting ? '#78e6ff' : snake.color;
    ctx.shadowBlur = boosting ? 12 + 8 * pulse : 6 + 6 * pulse;
    roundedSquare(ctx, head.x * cs + 1, head.y * cs + 1, cs - 2, cs - 2, cs * 0.35);
    ctx.stroke();
    ctx.restore();

    const cx = head.x * cs + cs / 2;
    const aboveHead = head.y * cs - 8;
    const labelBelow = aboveHead < 12;
    const labelY = labelBelow ? head.y * cs + cs + 14 : aboveHead;

    ctx.save();
    ctx.font = 'bold 11px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    const textWidth = ctx.measureText('YOU').width;
    const padX = 6;
    const pillW = textWidth + padX * 2;
    const pillH = 16;
    ctx.fillStyle = 'rgba(10,13,18,0.85)';
    ctx.strokeStyle = snake.color;
    ctx.lineWidth = 1.5;
    roundedSquare(ctx, cx - pillW / 2, labelY - pillH / 2, pillW, pillH, pillH / 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText('YOU', cx, labelY + 1);
    ctx.restore();
  }

  _renderEyes(ctx, snake, cx, cy, size) {
    const dir = snake.direction;
    const offset = size * 0.22;
    const perpX = -dir.y * offset;
    const perpY = dir.x * offset;
    const fwdX = dir.x * offset;
    const fwdY = dir.y * offset;
    const skin = snake.skin;

    for (const sign of [-1, 1]) {
      const ex = cx + fwdX + perpX * sign;
      const ey = cy + fwdY + perpY * sign;
      if (skin.accent2) {
        ctx.fillStyle = skin.accent2;
        ctx.beginPath();
        ctx.arc(ex, ey, size * 0.13, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#0d1117';
      ctx.beginPath();
      ctx.arc(ex, ey, size * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _renderParticles(ctx) {
    for (const p of this.particles) {
      const t = p.life / p.maxLife;
      ctx.globalAlpha = Math.max(0, 1 - t);
      if (p.type === 'ring') {
        const radius = 4 + t * 28;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1, 3 * (1 - t));
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.type === 'text') {
        ctx.fillStyle = p.color;
        ctx.font = 'bold 13px Segoe UI, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(p.text, p.x, p.y);
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
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
