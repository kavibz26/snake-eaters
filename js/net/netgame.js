// Client-side view of an authoritative multiplayer match. It extends Game only
// to reuse the existing renderers (snake skins, eyes, background, food,
// particles, HUD) so multiplayer looks exactly like single-player. It runs NO
// simulation: every position, size, kill and death comes from server
// snapshots, and the only thing it sends back is direction/boost intent.
import { Game } from '../game.js';
import { CONFIG, cellKey } from '../config.js';
import { getSkinById } from '../skins.js';
import { FoodManager } from '../food.js';
import { roundedSquare } from '../snakeRender.js';

const EMPTY_BODY = [];

export class NetGame extends Game {
  constructor(canvas, hud) {
    super(canvas, hud);
    this.net = null;
    this.food = new FoodManager(CONFIG.GRID_COLS, CONFIG.GRID_ROWS); // render-only mirror of the server's food
    this.views = new Map(); // player id -> render view of that snake
    this.myId = null;
    this.state = 'idle'; // idle | countdown | playing | spectating | over
    this.startsAt = 0;
    this.active = false;
    this.connectionText = null; // e.g. "Reconnecting..." (set by the UI layer)
    this.onBanner = null; // (text | null) => void, drives the overlay in the arena
    this.onPauseRequest = null; // pause button => "leave match?" prompt
    this._lastBanner = undefined;
    this._netLoop = this._netLoop.bind(this);
    this.snakes = [];
  }

  attach(net) {
    this.net = net;
  }

  get me() {
    return this.views.get(this.myId) || null;
  }

  // --- lifecycle -------------------------------------------------------------------

  // Called with the server's 'match' message (fresh start, or a resume after a reconnect).
  beginMatch(msg) {
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
    this.food.items = new Map();
    this.startsAt = performance.now() + (msg.startsInMs || 0);
    this.state = msg.startsInMs > 0 ? 'countdown' : 'playing';
    this._applyState(msg.snap, true);
    if (this.state === 'playing' && this.me && !this.me.alive) this.state = 'spectating';
    this._updateHud();
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
    this._setBanner(null);
  }

  // Match finished: stop driving the arena (the UI switches to the results screen).
  finish() {
    this.state = 'over';
    this.active = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this._setBanner(null);
  }

  setConnectionText(text) {
    this.connectionText = text;
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

  // --- input (intent only) ------------------------------------------------------------

  _canAct() {
    const me = this.me;
    return this.state === 'playing' && me && me.alive && this.net && this.net.status === 'connected';
  }

  setPlayerDirection(dir) {
    if (!this._canAct()) return;
    for (const [name, vec] of Object.entries(CONFIG.DIRECTIONS)) {
      if (vec.x === dir.x && vec.y === dir.y) {
        this.net.sendDir(name);
        return;
      }
    }
  }

  activateBoost() {
    if (!this._canAct()) return false;
    const me = this.me;
    if (me.boostTicksLeft > 0 || me.boostCooldownLeft > 0) return false;
    this.net.sendBoost();
    return true;
  }

  // The pause button in multiplayer means "leave?" - the match can't pause for everyone.
  togglePause() {
    if (this.onPauseRequest) this.onPauseRequest();
  }

  // --- applying authoritative snapshots ----------------------------------------------------

  applySnapshot(snap) {
    if (!this.views.size) return;
    if (this.state === 'countdown' && snap.tick >= 1) this.state = 'playing';
    this._applyState(snap, false);
    this._handleEvents(snap.ev || []);
    this._updateHud();
  }

  _applyState(snap, immediate) {
    const now = performance.now();
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

      const to = [];
      for (let i = 0; i < s.c.length; i += 2) to.push({ x: s.c[i], y: s.c[i + 1] });
      if (!v.alive) {
        v.body = v.from = v.to = EMPTY_BODY;
        if (wasAlive && v.id === this.myId && this.state !== 'idle') this.state = 'spectating';
        continue;
      }
      // Glide from wherever the snake is currently DRAWN to the new authoritative
      // cells (no pop, and never a client-side guess about where it "should" be).
      v.from = immediate || !v.body.length ? to : v.body.map((p) => ({ x: p.x, y: p.y }));
      v.to = to;
      v.arrival = now;
      if (immediate || !v.body.length) v.body = to.map((p) => ({ x: p.x, y: p.y }));
    }

    const items = new Map();
    for (let i = 0; i < snap.f.length; i += 2) items.set(cellKey(snap.f[i], snap.f[i + 1]), { x: snap.f[i], y: snap.f[i + 1] });
    this.food.items = items;
    this._alive = snap.snakes.filter((s) => s.a === 1).length;
    if (immediate) this._updateHud();
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
      }
    }
  }

  _updateHud() {
    const me = this.me;
    if (!me) return;
    let boostState = 'ready';
    let boostSeconds = 0;
    if (me.boostTicksLeft > 0) {
      boostState = 'active';
      boostSeconds = (me.boostTicksLeft * CONFIG.TICK_MS) / 1000;
    } else if (me.boostCooldownLeft > 0) {
      boostState = 'cooldown';
      boostSeconds = (me.boostCooldownLeft * CONFIG.TICK_MS) / 1000;
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
    });
  }

  // --- banner (countdown / spectating / connection) ---------------------------------------------

  _updateBanner(now) {
    let text = null;
    if (this.connectionText) text = this.connectionText;
    else if (this.state === 'countdown') {
      const secs = Math.ceil((this.startsAt - now) / 1000);
      text = secs > 0 ? `Get ready... ${secs}` : 'GO!';
    } else if (this.state === 'spectating') text = 'You were eliminated - watching the rest of the match';
    this._setBanner(text);
  }

  _setBanner(text) {
    if (text === this._lastBanner) return;
    this._lastBanner = text;
    if (this.onBanner) this.onBanner(text);
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
    const drawn = [];
    for (const v of this.views.values()) {
      if (!v.alive || !v.to.length) continue;
      this._interpolate(v, now);
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
