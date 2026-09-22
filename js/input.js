import { CONFIG } from './config.js';

const KEY_DIRECTIONS = {
  KeyW: CONFIG.DIRECTIONS.up,
  ArrowUp: CONFIG.DIRECTIONS.up,
  KeyS: CONFIG.DIRECTIONS.down,
  ArrowDown: CONFIG.DIRECTIONS.down,
  KeyA: CONFIG.DIRECTIONS.left,
  ArrowLeft: CONFIG.DIRECTIONS.left,
  KeyD: CONFIG.DIRECTIONS.right,
  ArrowRight: CONFIG.DIRECTIONS.right,
};

// Fallback keyed on e.key (not e.code): some input sources - virtual
// keyboards, certain automation/assistive tools - fire keydown events
// without a populated `code`, only `key`.
const KEY_DIRECTIONS_BY_KEY = {
  w: CONFIG.DIRECTIONS.up,
  W: CONFIG.DIRECTIONS.up,
  ArrowUp: CONFIG.DIRECTIONS.up,
  s: CONFIG.DIRECTIONS.down,
  S: CONFIG.DIRECTIONS.down,
  ArrowDown: CONFIG.DIRECTIONS.down,
  a: CONFIG.DIRECTIONS.left,
  A: CONFIG.DIRECTIONS.left,
  ArrowLeft: CONFIG.DIRECTIONS.left,
  d: CONFIG.DIRECTIONS.right,
  D: CONFIG.DIRECTIONS.right,
  ArrowRight: CONFIG.DIRECTIONS.right,
};

const SWIPE_MIN_DISTANCE = 24;

export class InputManager {
  constructor({ canvas, dpad }) {
    this.canvas = canvas;
    this.dpad = dpad;
    this.onDirection = null;
    this.onPauseToggle = null;
    this.onRestart = null;
    this.onBoost = null;
    this.touchStart = null;

    this._handleKeydown = this._handleKeydown.bind(this);
    this._handleTouchStart = this._handleTouchStart.bind(this);
    this._handleTouchMove = this._handleTouchMove.bind(this);
    this._handleTouchEnd = this._handleTouchEnd.bind(this);

    window.addEventListener('keydown', this._handleKeydown);
    if (canvas) {
      canvas.addEventListener('touchstart', this._handleTouchStart, { passive: true });
      // Not passive: a swipe-to-turn gesture must never scroll/bounce the
      // page - CSS touch-action:none on the canvas already covers modern
      // browsers, this is the JS-level belt-and-suspenders backup.
      canvas.addEventListener('touchmove', this._handleTouchMove, { passive: false });
      canvas.addEventListener('touchend', this._handleTouchEnd, { passive: true });
    }
    if (dpad) {
      dpad.querySelectorAll('[data-dir]').forEach((btn) => {
        btn.addEventListener('touchstart', (e) => {
          e.preventDefault();
          this._emitDirection(btn.dataset.dir);
        }, { passive: false });
        btn.addEventListener('click', () => this._emitDirection(btn.dataset.dir));
      });
    }
  }

  _emitDirection(name) {
    const dir = CONFIG.DIRECTIONS[name];
    if (dir && this.onDirection) this.onDirection(dir);
  }

  _handleKeydown(e) {
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (this.onPauseToggle) this.onPauseToggle();
      return;
    }
    if (e.code === 'KeyR' || e.key === 'r' || e.key === 'R') {
      if (this.onRestart) this.onRestart();
      return;
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.key === 'Shift') {
      if (this.onBoost) this.onBoost();
      return;
    }
    const dir = KEY_DIRECTIONS[e.code] || KEY_DIRECTIONS_BY_KEY[e.key];
    if (dir) {
      e.preventDefault();
      if (this.onDirection) this.onDirection(dir);
    }
  }

  _handleTouchStart(e) {
    const t = e.changedTouches[0];
    this.touchStart = { x: t.clientX, y: t.clientY };
  }

  _handleTouchMove(e) {
    if (this.touchStart) e.preventDefault();
  }

  _handleTouchEnd(e) {
    if (!this.touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - this.touchStart.x;
    const dy = t.clientY - this.touchStart.y;
    this.touchStart = null;
    if (Math.abs(dx) < SWIPE_MIN_DISTANCE && Math.abs(dy) < SWIPE_MIN_DISTANCE) return;
    const dir = Math.abs(dx) > Math.abs(dy)
      ? (dx > 0 ? CONFIG.DIRECTIONS.right : CONFIG.DIRECTIONS.left)
      : (dy > 0 ? CONFIG.DIRECTIONS.down : CONFIG.DIRECTIONS.up);
    if (this.onDirection) this.onDirection(dir);
  }

  destroy() {
    window.removeEventListener('keydown', this._handleKeydown);
    if (this.canvas) {
      this.canvas.removeEventListener('touchstart', this._handleTouchStart);
      this.canvas.removeEventListener('touchmove', this._handleTouchMove);
      this.canvas.removeEventListener('touchend', this._handleTouchEnd);
    }
  }
}
