// Client-side view of an authoritative multiplayer match. It extends Game only
// to reuse the existing renderers (snake skins, eyes, background, food,
// particles, HUD) so multiplayer looks exactly like single-player.
//
// Two rendering paths, on purpose:
//   * REMOTE snakes: interpolated between server snapshots (a slight, smooth delay).
//   * LOCAL snake:   drawn from LocalPredictor (js/net/predict.js) so turns and
//                    boost respond instantly. It is visual prediction only - every
//                    position, size, kill, death and score still comes from the
//                    server, and the prediction is rebuilt from each snapshot.
import { Game } from '../game.js';
import { CONFIG } from '../config.js';
import { drawSpecialItem, activeEffectsForHud } from '../powerups/render.js';
import { getSkinById } from '../skins.js';
import { FoodManager } from '../food.js';
import { roundedSquare } from '../snakeRender.js';
import { LocalPredictor, predictorState } from './predict.js';
import { SnapTracker, DIR_NAMES, DIR_VECS, dirIndex } from './snapcodec.js';

const EMPTY_BODY = [];
const OFFSET_TAU_MS = 65; // how fast a visual correction fades out
const SNAP_THRESHOLD_CELLS = 3; // bigger disagreements are real desyncs: show the truth immediately
const SYNC_COOLDOWN_MS = 750;
const GO_FLASH_MS = 700; // how long "GO!" stays up after the countdown ends (purely visual)

export class NetGame extends Game {
  constructor(canvas, hud) {
    super(canvas, hud);
    this.net = null;
    this.food = new FoodManager(CONFIG.GRID_COLS, CONFIG.GRID_ROWS); // render-only mirror of the server's food
    this.tracker = new SnapTracker(); // authoritative state rebuilt from delta snapshots
    this.predictor = new LocalPredictor(CONFIG.TICK_MS);
    this.predictionEnabled = true; // switchable so the latency fix can be A/B measured
    this.seq = 0; // monotonically increasing input sequence number
    this.offset = null; // decaying visual correction for the local snake
    this.offsetT = 0;
    this.views = new Map(); // player id -> render view of that snake
    this.myId = null;
    this.state = 'idle'; // idle | countdown | playing | spectating | over
    this.startsAt = 0;
    this.active = false;
    this.connectionText = null; // e.g. "Reconnecting..." (set by the UI layer)
    this.onBanner = null; // (text | null) => void, drives the overlay in the arena
    this.onPauseRequest = null; // pause button => "leave match?" prompt
    this.onBoard = null; // (rows) => void, live leaderboard (order computed by the server)
    this.onPlayerEvent = null; // ('food' | 'kill') => void, for the provisional XP feedback (real XP comes from the final result)
    this._feedTick = -1; // last tick whose events fed onPlayerEvent: a repeated snapshot must not repeat feedback
    this._lastBanner = undefined;
    this._showGo = false; // true only for a fresh match start (not when resuming after a reconnect)
    this._lastSync = 0;
    this._alive = 0;
    this._netLoop = this._netLoop.bind(this);
    this.snakes = [];
  }

  attach(net) {
    this.net = net;
    net.on('latency', ({ sample }) => this.predictor.noteRtt(sample));
  }

  get me() {
    return this.views.get(this.myId) || null;
  }

  // --- lifecycle -------------------------------------------------------------------

  // Called with the server's 'match' message (fresh start, or a resume after a reconnect).
  beginMatch(msg) {
    this.setMap(msg.map); // the server's configured map: the same deterministic layout it simulates
    this.predictor.setObstacles(this.obstacles);
    this.mapMismatch = Boolean(msg.mh) && this.map.hash !== msg.mh; // stale client: layout differs from the server's
    this.myId = msg.you;
    this.views = new Map();
    for (const p of msg.players) {
      const skin = getSkinById(p.skinId);
      this.views.set(p.id, {
        id: p.id,
        name: p.name,
        skin,
        color: skin.ui,
        isPlayer: p.id === msg.you, // the base renderer draws our pulsing ring for us
        alive: true,
        body: EMPTY_BODY,
        from: EMPTY_BODY,
        to: EMPTY_BODY,
        arrival: 0,
        direction: { x: 1, y: 0 },
        score: 0,
        kills: 0,
        justAte: false,
        frozen: false,
        boostTicksLeft: 0,
        boostCooldownLeft: 0,
      });
    }
    this.snakes = [...this.views.values()];
    this.particles = [];
    if (!msg.resumed) {
      this.seq = 0; // new match: the server restarts acks at 0
      this._feedTick = -1;
    }
    this.tracker.reset();
    this.food.items = this.tracker.food;
    this.predictor.reset();
    this.offset = null;
    this.startsAt = performance.now() + (msg.startsInMs || 0);
    this._showGo = msg.startsInMs > 0;
    this.state = msg.startsInMs > 0 ? 'countdown' : 'playing';
    this.tracker.apply(msg.snap);
    this._applyViews(msg.snap, performance.now());
    this._alive = msg.snap.snakes.filter((s) => s.a === 1).length;
    if (this.state === 'playing' && this.me && !this.me.alive) this.state = 'spectating';
    this._updateHud();
    this._publishBoard(msg.snap);
    this._lastBanner = undefined;
    this.start();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.lastTs = performance.now();
    this.rafId = requestAnimationFrame(this._netLoop);
  }

  stop() {
    this.active = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.state = 'idle';
    this.views = new Map();
    this.snakes = [];
    this.connectionText = null;
    this.predictor.reset();
    this.tracker.reset();
    this._setBanner(null);
  }

  // Match finished: stop driving the arena (the UI switches to the results screen).
  finish() {
    this.state = 'over';
    this.active = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.predictor.reset();
    this._setBanner(null);
  }

  setConnectionText(text) {
    this.connectionText = text;
  }

  // The socket dropped: anything still in flight never reached the server.
  connectionLost() {
    this.predictor.dropInFlightInputs();
  }

  _netLoop(ts) {
    let dt = ts - this.lastTs;
    this.lastTs = ts;
    if (dt > 250) dt = 250;
    this._stepParticles(dt);
    this._updateBanner(ts);
    this.render();
    if (this.active) this.rafId = requestAnimationFrame(this._netLoop);
  }

  // --- input (intent only) -----------------------------------------------------------------

  _canAct() {
    if (this.state === 'countdown' && performance.now() >= this.startsAt) this.state = 'playing';
    const me = this.me;
    return this.state === 'playing' && me && me.alive && this.net && this.net.status === 'connected';
  }

  // One entry point for keyboard, D-pad and swipe (they all arrive here via
  // InputManager -> onDirection). The intent goes out immediately, and the
  // local snake reacts in the same call.
  setPlayerDirection(dir) {
    if (!this._canAct()) return;
    const idx = dirIndex(dir);
    if (idx < 0) return;
    const now = performance.now();
    if (this._predicting()) {
      this.predictor.displayCells(now); // bring the prediction up to "now" before consulting it
      if (!this._directionWouldChange(dir)) return; // no-op turn (held key / repeated swipe)
    }
    const seq = ++this.seq;
    this.net.sendInput({ seq, dir: DIR_NAMES[idx] });
    this._predictInput('dir', DIR_VECS[idx], seq, now);
  }

  activateBoost() {
    if (!this._canAct()) return false;
    const me = this.me;
    const predicting = this._predicting();
    if (predicting) this.predictor.displayCells(performance.now());
    if (predicting ? !this.predictor.canBoost() : (me.boostTicksLeft > 0 || me.boostCooldownLeft > 0)) return false;
    const seq = ++this.seq;
    this.net.sendInput({ seq, boost: true });
    this._predictInput('boost', null, seq, performance.now());
    this._updateHud();
    return true;
  }

  // The pause button in multiplayer means "leave?" - the match can't pause for everyone.
  togglePause() {
    if (this.onPauseRequest) this.onPauseRequest();
  }

  _predicting() {
    return this.predictionEnabled && this.predictor.active && this.predictor.phi !== null;
  }

  // Same rule Snake.queueDirection uses: a turn equal to, or opposite of, the most
  // recently queued heading changes nothing, so don't spend a message on it.
  _directionWouldChange(dir) {
    const s = this.predictor.sim;
    if (!s) return true;
    const recent = s.inputBuffer.length ? s.inputBuffer[s.inputBuffer.length - 1] : s.pendingDirection;
    if (dir.x === recent.x && dir.y === recent.y) return false;
    if (dir.x === -recent.x && dir.y === -recent.y) return false;
    return true;
  }

  _predictInput(kind, dir, seq, now) {
    if (!this._predicting()) return;
    const before = this._localDisplay(now);
    this.predictor.addInput(kind, dir, seq, now);
    this._reconcile(before, now);
  }

  // --- applying authoritative snapshots ------------------------------------------------------

  applySnapshot(snap, recvAt) {
    if (!this.views.size) return;
    const now = typeof recvAt === 'number' ? recvAt : performance.now();
    if (this.state === 'countdown' && snap.tick >= 1) this.state = 'playing';
    this.tracker.apply(snap);
    if (this.tracker.needsSync && this.net && now - this._lastSync > SYNC_COOLDOWN_MS) {
      this._lastSync = now;
      this.net.requestSync(); // a delta didn't fit our state: ask for the full picture
    }
    this._applyViews(snap, now);
    this._alive = snap.snakes.filter((s) => s.a === 1).length;
    this._handleEvents(snap.ev || []);
    if (this.onPlayerEvent && snap.tick > this._feedTick) {
      this._feedTick = snap.tick;
      for (const ev of snap.ev || []) {
        if (ev.e === 'eat' && ev.id === this.myId) this.onPlayerEvent('food');
        else if (ev.e === 'kill' && ev.killer === this.myId) this.onPlayerEvent('kill');
        else if (ev.e === 'pu' && ev.id === this.myId) this.onPlayerEvent(ev.k === 'mega' ? 'mega' : 'powerup');
      }
    }
    this._updateHud();
    this._publishBoard(snap);
  }

  _applyViews(snap, now) {
    const isTick = !snap.full;
    for (const s of snap.snakes) {
      const v = this.views.get(s.id);
      if (!v) continue;
      const wasAlive = v.alive;
      v.alive = s.a === 1;
      v.direction = { x: s.d[0], y: s.d[1] };
      v.score = s.sc;
      v.kills = s.k;
      v.justAte = s.ate === 1;
      v.boostTicksLeft = s.b[0];
      v.boostCooldownLeft = s.b[1];
      v.frozen = s.fz === 1;
      const fx = s.e; // authoritative power-up timers [speed, magnet, shield], absent when none is active
      v.speedTicksLeft = fx ? fx[0] : 0;
      v.magnetTicksLeft = fx ? fx[1] : 0;
      v.shieldTicksLeft = fx ? fx[2] : 0;

      const flat = this.tracker.bodies.get(s.id);
      if (!v.alive || !flat) {
        v.body = v.from = v.to = EMPTY_BODY;
        if (s.id === this.myId) this.predictor.onSnapshot({ alive: false, cells: [] }, this.tracker.food, now);
        if (wasAlive && !v.alive && v.id === this.myId && this.state !== 'idle') this.state = 'spectating';
        continue;
      }
      const to = [];
      for (let i = 0; i < flat.length; i += 2) to.push({ x: flat[i], y: flat[i + 1] });

      if (s.id === this.myId && this.predictionEnabled) {
        const before = this._localDisplay(now);
        if (isTick) this.predictor.noteSnapshot(snap.tick, now);
        this.predictor.onSnapshot(predictorState(snap, s, flat), this.tracker.food, now);
        this._reconcile(before, now);
        v.to = to; // authoritative body (HUD length etc.)
        continue;
      }

      // Remote snake (or prediction switched off): glide from wherever it is drawn now
      // to the new authoritative cells.
      v.from = !v.body.length || snap.full ? to : v.body.map((p) => ({ x: p.x, y: p.y }));
      v.to = to;
      v.arrival = now;
      if (!v.body.length || snap.full) v.body = to.map((p) => ({ x: p.x, y: p.y }));
    }
  }

  _handleEvents(events) {
    for (const ev of events) {
      if (ev.e === 'eat') {
        if (ev.id === this.myId) this._spawnEatParticles({ x: ev.x, y: ev.y });
      } else if (ev.e === 'kill') {
        const killer = this.views.get(ev.killer);
        const victim = this.views.get(ev.victim);
        this._spawnKillEffect({ x: ev.x, y: ev.y }, killer ? killer.color : '#ffffff', victim ? victim.color : '#ffffff');
      } else if (ev.e === 'death') {
        const v = this.views.get(ev.id);
        this._spawnDeathParticles({ x: ev.x, y: ev.y }, v ? v.color : '#ffffff');
      } else if (ev.e === 'pu') {
        this._spawnPickupEffect({ x: ev.x, y: ev.y }, ev.k);
      } else if (ev.e === 'shield') {
        this._spawnShieldBlock({ x: ev.x, y: ev.y });
      }
    }
  }

  // The live leaderboard order is computed by the SERVER (`lb` = indices into
  // `snakes`, sorted by its deterministic score ranking); the client only labels it.
  _publishBoard(snap) {
    if (!this.onBoard || !snap.lb) return;
    const rows = snap.lb.map((idx, pos) => {
      const s = snap.snakes[idx];
      const v = this.views.get(s.id);
      return { id: s.id, name: v ? v.name : '?', color: v ? v.color : '#fff', score: s.sc, alive: s.a === 1, isMe: s.id === this.myId, rank: pos + 1 };
    });
    this.onBoard(rows);
  }

  _updateHud() {
    const me = this.me;
    if (!me) return;
    let ticksLeft = me.boostTicksLeft;
    let cooldown = me.boostCooldownLeft;
    if (this._predicting()) {
      const pb = this.predictor.predictedBoost(); // reflects a boost pressed a moment ago
      if (pb) { ticksLeft = pb.ticksLeft; cooldown = pb.cooldown; }
    }
    let boostState = 'ready';
    let boostSeconds = 0;
    if (ticksLeft > 0) {
      boostState = 'active';
      boostSeconds = (ticksLeft * CONFIG.TICK_MS) / 1000;
    } else if (cooldown > 0) {
      boostState = 'cooldown';
      boostSeconds = (cooldown * CONFIG.TICK_MS) / 1000;
    }
    let status = 'Playing';
    if (this.state === 'countdown') status = 'Get ready';
    else if (!me.alive) status = 'Spectating';
    this.hud.update({
      score: me.score,
      length: me.alive ? me.to.length : 0,
      eliminations: me.kills,
      remaining: this._alive ?? 0,
      status,
      boostState,
      boostSeconds,
      effects: me.alive ? activeEffectsForHud(me, CONFIG.TICK_MS) : [],
    });
  }

  // --- banner (countdown / spectating / connection) ---------------------------------------------

  _updateBanner(now) {
    let text = null;
    if (this.connectionText) text = this.connectionText;
    else if (this._showGo && now < this.startsAt + GO_FLASH_MS) {
      // Purely presentational: the server decides when the match really starts; input is
      // accepted as soon as it does (see _canAct), not when this banner disappears.
      const remaining = this.startsAt - now;
      text = remaining > 0 ? String(Math.ceil(remaining / 1000)) : 'GO!';
    } else if (this.state === 'spectating') text = 'You were eliminated - watching the rest of the match';
    this._setBanner(text);
  }

  _setBanner(text) {
    if (text === this._lastBanner) return;
    this._lastBanner = text;
    if (this.onBanner) this.onBanner(text);
  }

  // --- local snake: prediction + decaying visual correction -----------------------------------------

  // What the local snake looks like at `now` (predicted position + any fading correction).
  _localDisplay(now) {
    const cells = this.predictor.active ? this.predictor.displayCells(now) : null;
    if (!cells) return null;
    if (this.offset) {
      const k = Math.exp(-(now - this.offsetT) / OFFSET_TAU_MS);
      if (k < 0.01) this.offset = null;
      else {
        const off = this.offset;
        for (let i = 0; i < cells.length; i++) {
          const o = off[i] || off[off.length - 1];
          if (o) { cells[i].x += o.x * k; cells[i].y += o.y * k; }
        }
      }
    }
    return cells;
  }

  // The prediction was just rebuilt (new snapshot, or a new input). Keep the picture
  // continuous: whatever was on screen minus what the new prediction says becomes a
  // small offset that fades away. A big disagreement is not smoothed - it snaps.
  _reconcile(before, now) {
    this.offset = null;
    if (!before) return;
    const raw = this.predictor.displayCells(now);
    if (!raw) return;
    const off = new Array(raw.length);
    let max = 0;
    for (let i = 0; i < raw.length; i++) {
      const b = before[i] || before[before.length - 1];
      const dx = b.x - raw[i].x;
      const dy = b.y - raw[i].y;
      off[i] = { x: dx, y: dy };
      max = Math.max(max, Math.abs(dx), Math.abs(dy));
    }
    if (max > SNAP_THRESHOLD_CELLS || max < 0.002) return;
    this.offset = off;
    this.offsetT = now;
  }

  // Cells to draw for a snake at `now`. Also what the latency tests sample.
  _bodyFor(v, now) {
    if (v.id === this.myId && this.predictionEnabled && this.predictor.active) {
      const cells = this._localDisplay(now); // also advances the predictor to `now`
      if (cells && cells.length) {
        const dir = this.predictor.sim && this.predictor.sim.direction;
        if (dir) v.direction = dir;
        return cells;
      }
    }
    this._interpolate(v, now);
    return v.body;
  }

  // --- rendering -----------------------------------------------------------------------------------

  render() {
    const ctx = this.ctx;
    const w = CONFIG.GRID_COLS * CONFIG.CELL_SIZE;
    const h = CONFIG.GRID_ROWS * CONFIG.CELL_SIZE;
    ctx.clearRect(0, 0, w, h);
    this._renderBackground(ctx, w, h);
    this.food.render(ctx, CONFIG.CELL_SIZE);

    const now = performance.now();
    for (const item of this.tracker.specials.values()) drawSpecialItem(ctx, item, CONFIG.CELL_SIZE, now); // server-owned items
    const drawn = [];
    for (const v of this.views.values()) {
      if (!v.alive || !v.to.length) continue;
      v.body = this._bodyFor(v, now);
      if (!v.body.length) continue;
      this._renderSnake(ctx, v);
      drawn.push(v);
    }
    for (const v of drawn) this._renderNameTag(ctx, v, w);
    this._renderParticles(ctx);
  }

  // Linear glide from the previously drawn cells to the newest authoritative ones
  // over one tick. Purely cosmetic; never fed back into any game state.
  _interpolate(v, now) {
    const a = Math.min(1, Math.max(0, (now - v.arrival) / CONFIG.TICK_MS));
    const { from, to } = v;
    const body = v.body.length === to.length ? v.body : (v.body = to.map((p) => ({ x: p.x, y: p.y })));
    const lastFrom = from[from.length - 1];
    for (let i = 0; i < to.length; i++) {
      const f = from[i] || lastFrom || to[i];
      body[i].x = f.x + (to[i].x - f.x) * a;
      body[i].y = f.y + (to[i].y - f.y) * a;
    }
  }

  _renderNameTag(ctx, v, canvasW) {
    const cs = CONFIG.CELL_SIZE;
    const head = v.body[0];
    const isMe = v.id === this.myId;
    const label = (isMe ? `${v.name} (YOU)` : v.name) + (v.frozen ? ' - reconnecting' : '');

    // The board is drawn in a fixed logical resolution and CSS-scaled to fit the
    // screen, so on a phone (~0.3x) an 11px tag would be ~3px tall. Scale tags up
    // by the inverse of the display scale so they stay readable (~8.5px on screen).
    const displayScale = (this.canvas.clientWidth || canvasW) / canvasW;
    const k = Math.min(2.6, Math.max(1, 8.5 / (11 * displayScale)));

    ctx.save();
    ctx.font = `bold ${11 * k}px Segoe UI, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pillW = ctx.measureText(label).width + 12 * k;
    const pillH = 16 * k;
    const cx = Math.min(canvasW - pillW / 2 - 2, Math.max(pillW / 2 + 2, head.x * cs + cs / 2));
    const above = head.y * cs - 6 - 3 * k;
    const y = above < pillH * 0.75 ? head.y * cs + cs + 4 + 9 * k : above;

    ctx.globalAlpha = v.frozen ? 0.6 : 1;
    ctx.fillStyle = 'rgba(10,13,18,0.85)';
    ctx.strokeStyle = v.color;
    ctx.lineWidth = isMe ? 2 : 1.5;
    roundedSquare(ctx, cx - pillW / 2, y - pillH / 2, pillW, pillH, pillH / 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, cx, y + 1);
    ctx.restore();
  }

  // The base class would also draw a "YOU" pill here; multiplayer draws a name tag
  // for every player instead, so only the pulsing ring is kept.
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
  }
}
