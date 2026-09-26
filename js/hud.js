import { POWERUP_STYLE } from './powerups/render.js';

export class Hud {
  constructor(elements) {
    this.el = elements; // { score, length, eliminations, remaining, status, boostBtn, effects }
    this.chips = new Map(); // power-up type -> { node, text }: chips are created once and only their text changes
  }

  update({ score, length, eliminations, remaining, status, boostState, boostSeconds, effects }) {
    if (score !== undefined) this.el.score.textContent = score;
    if (length !== undefined) this.el.length.textContent = length;
    if (eliminations !== undefined) this.el.eliminations.textContent = eliminations;
    if (remaining !== undefined) this.el.remaining.textContent = remaining;
    if (status !== undefined) this.el.status.textContent = status;
    if (boostState !== undefined) this._updateBoost(boostState, boostSeconds);
    if (effects !== undefined) this._updateEffects(effects);
  }

  // effects: [{ type, seconds }] - the active power-ups, e.g. "⚡ SPEED 3.2s". Shield is a one-hit item,
  // so it shows no countdown. DOM is touched only when a chip's text actually changes.
  _updateEffects(effects) {
    const root = this.el.effects;
    if (!root) return;
    const active = new Set(effects.map((e) => e.type));
    for (const [type, chip] of this.chips) {
      if (!active.has(type)) {
        chip.node.remove();
        this.chips.delete(type);
      }
    }
    for (const e of effects) {
      const style = POWERUP_STYLE[e.type];
      let chip = this.chips.get(e.type);
      if (!chip) {
        const node = document.createElement('span');
        node.className = 'fx-chip';
        node.dataset.type = e.type;
        const icon = document.createElement('span');
        icon.className = 'fx-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = style.icon;
        const label = document.createElement('span');
        label.className = 'fx-label';
        label.textContent = style.label;
        const time = document.createElement('span');
        time.className = 'fx-time';
        node.append(icon, label, time);
        root.appendChild(node);
        chip = { node, time, last: null };
        this.chips.set(e.type, chip);
      }
      const text = e.type === 'shield' ? '' : `${e.seconds.toFixed(1)}s`;
      if (chip.last !== text) {
        chip.last = text;
        chip.time.textContent = text;
      }
    }
  }

  _updateBoost(state, seconds) {
    const btn = this.el.boostBtn;
    if (!btn) return;
    btn.classList.toggle('boosting', state === 'active');
    btn.classList.toggle('cooldown', state === 'cooldown');
    btn.disabled = state === 'cooldown';
    if (state === 'active') {
      btn.textContent = `⚡ Boosting ${seconds.toFixed(1)}s`;
    } else if (state === 'cooldown') {
      btn.textContent = `Cooldown ${seconds.toFixed(1)}s`;
    } else {
      btn.textContent = '⚡ Speed Boost';
    }
  }
}
