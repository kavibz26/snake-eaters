export class Hud {
  constructor(elements) {
    this.el = elements; // { score, length, eliminations, remaining, status, boostBtn, attackBtn }
  }

  update({ score, length, eliminations, remaining, status, boostState, boostSeconds, attackState, attackSeconds }) {
    if (score !== undefined) this.el.score.textContent = score;
    if (length !== undefined) this.el.length.textContent = length;
    if (eliminations !== undefined) this.el.eliminations.textContent = eliminations;
    if (remaining !== undefined) this.el.remaining.textContent = remaining;
    if (status !== undefined) this.el.status.textContent = status;
    if (boostState !== undefined) this._updateBoost(boostState, boostSeconds);
    if (attackState !== undefined) this._updateAttack(attackState, attackSeconds);
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

  _updateAttack(state, seconds) {
    const btn = this.el.attackBtn;
    if (!btn) return;
    btn.classList.toggle('ready', state === 'ready');
    btn.classList.toggle('cooldown', state === 'cooldown');
    btn.disabled = state === 'cooldown';
    if (state === 'cooldown') {
      btn.textContent = `Cooldown ${seconds.toFixed(1)}s`;
    } else {
      btn.textContent = '⚔ Attack';
    }
  }
}
