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

function swipeDirection(dx, dy) {
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE && Math.abs(dy) < SWIPE_MIN_DISTANCE) return null;
  return Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? CONFIG.DIRECTIONS.right : CONFIG.DIRECTIONS.left)
    : (dy > 0 ? CONFIG.DIRECTIONS.down : CONFIG.DIRECTIONS.up);
}

function findTouch(list, id) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].identifier === id) return list[i];
  }
  return null;
}

export class InputManager {
  // swipeArea: the element that listens for swipes (defaults to the canvas).
  // Passing the canvas's wrapper makes the whole board region - including
  // the letterbox around the canvas - a valid swipe surface.
  constructor({ canvas, dpad, swipeArea }) {
    this.canvas = canvas;
    this.swipeArea = swipeArea || canvas;
    this.dpad = dpad;
    this.onDirection = null;
    this.onPauseToggle = null;
    this.onRestart = null;
    this.onBoost = null;
    this.swipe = null; // { id, x, y } for the one finger currently driving a swipe

    this._handleKeydown = this._handleKeydown.bind(this);
    this._handleTouchStart = this._handleTouchStart.bind(this);
    this._handleTouchMove = this._handleTouchMove.bind(this);
    this._handleTouchEnd = this._handleTouchEnd.bind(this);

    window.addEventListener('keydown', this._handleKeydown);
    const area = this.swipeArea;
    if (area) {
      area.addEventListener('touchstart', this._handleTouchStart, { passive: true });
      // Not passive: a swipe-to-turn gesture must never scroll/bounce the
      // page - CSS touch-action:none on the board already covers modern
      // browsers, this is the JS-level belt-and-suspenders backup.
      area.addEventListener('touchmove', this._handleTouchMove, { passive: false });
      area.addEventListener('touchend', this._handleTouchEnd, { passive: true });
      area.addEventListener('touchcancel', this._handleTouchCancel = () => { this.swipe = null; }, { passive: true });
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
    // Typing in a text field (multiplayer nickname / room code) must never be hijacked as game input.
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
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

  // Only the first finger down drives a swipe; extra fingers are ignored so
  // a second touch can never hijack or reset the gesture in progress.
  _handleTouchStart(e) {
    if (this.swipe) return;
    const t = e.changedTouches[0];
    this.swipe = { id: t.identifier, x: t.clientX, y: t.clientY };
  }

  // Fires the turn the moment the finger travels far enough, instead of
  // waiting for release, then re-anchors at the current point - so one
  // continuous gesture can chain turns (right, then down) without lifting.
  // The game itself still rejects reversals (see Snake.queueDirection).
  _handleTouchMove(e) {
    const s = this.swipe;
    if (!s) return;
    e.preventDefault();
    const t = findTouch(e.changedTouches, s.id);
    if (!t) return;
    const dir = swipeDirection(t.clientX - s.x, t.clientY - s.y);
    if (!dir) return;
    s.x = t.clientX;
    s.y = t.clientY;
    if (this.onDirection) this.onDirection(dir);
  }

  // Fallback for browsers that coalesce/skip the final touchmove: any
  // travel left unspent when the finger lifts still counts as a swipe.
  _handleTouchEnd(e) {
    const s = this.swipe;
    if (!s) return;
    const t = findTouch(e.changedTouches, s.id);
    if (!t) return;
    this.swipe = null;
    const dir = swipeDirection(t.clientX - s.x, t.clientY - s.y);
    if (dir && this.onDirection) this.onDirection(dir);
  }

  destroy() {
    window.removeEventListener('keydown', this._handleKeydown);
    const area = this.swipeArea;
    if (area) {
      area.removeEventListener('touchstart', this._handleTouchStart);
      area.removeEventListener('touchmove', this._handleTouchMove);
      area.removeEventListener('touchend', this._handleTouchEnd);
      area.removeEventListener('touchcancel', this._handleTouchCancel);
    }
  }
}
