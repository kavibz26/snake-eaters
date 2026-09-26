// Canvas drawing for special items and the effects around a snake's head. Client only; the state it
// draws comes from the simulation (single player) or the server's snapshots (multiplayer).
// Each item has its own SHAPE as well as colour - lightning bolt, horseshoe magnet, shield, gem - so
// it is recognisable at a glance and does not rely on colour alone. Animation is a cheap pulse driven
// by the frame timestamp; nothing here allocates per item beyond one gradient.
import { POWERUPS } from './config.js';

export const POWERUP_STYLE = {
  speed: { color: '#ffe14d', glow: '#78e6ff', icon: '⚡', label: 'SPEED' },
  magnet: { color: '#ff6b6b', glow: '#6ba8ff', icon: '🧲', label: 'MAGNET' },
  shield: { color: '#5db3ff', glow: '#ffffff', icon: '🛡️', label: 'SHIELD' },
  mega: { color: '#ff5ad9', glow: '#ffe14d', icon: '💎', label: 'MEGA' },
};

function bolt(ctx, s) {
  ctx.beginPath();
  ctx.moveTo(0.18 * s, -1 * s);
  ctx.lineTo(-0.6 * s, 0.12 * s);
  ctx.lineTo(-0.06 * s, 0.12 * s);
  ctx.lineTo(-0.22 * s, 1 * s);
  ctx.lineTo(0.6 * s, -0.18 * s);
  ctx.lineTo(0.06 * s, -0.18 * s);
  ctx.closePath();
  ctx.fillStyle = POWERUP_STYLE.speed.color;
  ctx.fill();
}

function horseshoe(ctx, s) {
  const r = 0.52 * s;
  ctx.lineCap = 'butt';
  ctx.lineWidth = 0.36 * s;
  ctx.strokeStyle = POWERUP_STYLE.magnet.color;
  ctx.beginPath();
  ctx.arc(0, 0.05 * s, r, Math.PI, Math.PI * 1.5);
  ctx.lineTo(0, -0.47 * s);
  ctx.stroke();
  ctx.strokeStyle = POWERUP_STYLE.magnet.glow;
  ctx.beginPath();
  ctx.arc(0, 0.05 * s, r, Math.PI * 1.5, Math.PI * 2);
  ctx.stroke();
  // legs
  ctx.strokeStyle = POWERUP_STYLE.magnet.color;
  ctx.beginPath();
  ctx.moveTo(-r, 0.05 * s);
  ctx.lineTo(-r, 0.72 * s);
  ctx.stroke();
  ctx.strokeStyle = POWERUP_STYLE.magnet.glow;
  ctx.beginPath();
  ctx.moveTo(r, 0.05 * s);
  ctx.lineTo(r, 0.72 * s);
  ctx.stroke();
  // white pole tips
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-r - 0.18 * s, 0.72 * s, 0.36 * s, 0.24 * s);
  ctx.fillRect(r - 0.18 * s, 0.72 * s, 0.36 * s, 0.24 * s);
}

function shieldShape(ctx, s) {
  ctx.beginPath();
  ctx.moveTo(0, -1 * s);
  ctx.bezierCurveTo(0.9 * s, -0.75 * s, 0.9 * s, -0.1 * s, 0.78 * s, 0.22 * s);
  ctx.quadraticCurveTo(0.52 * s, 0.8 * s, 0, 1.05 * s);
  ctx.quadraticCurveTo(-0.52 * s, 0.8 * s, -0.78 * s, 0.22 * s);
  ctx.bezierCurveTo(-0.9 * s, -0.1 * s, -0.9 * s, -0.75 * s, 0, -1 * s);
  ctx.closePath();
  ctx.fillStyle = '#2f6fd6';
  ctx.fill();
  ctx.lineWidth = 0.14 * s;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  // highlight
  ctx.beginPath();
  ctx.moveTo(0, -0.62 * s);
  ctx.lineTo(0, 0.7 * s);
  ctx.moveTo(-0.5 * s, -0.05 * s);
  ctx.lineTo(0.5 * s, -0.05 * s);
  ctx.lineWidth = 0.1 * s;
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.stroke();
}

function gem(ctx, s, t) {
  ctx.beginPath();
  ctx.moveTo(0, -1 * s);
  ctx.lineTo(0.82 * s, -0.2 * s);
  ctx.lineTo(0, 1 * s);
  ctx.lineTo(-0.82 * s, -0.2 * s);
  ctx.closePath();
  const g = ctx.createLinearGradient(-s, -s, s, s);
  g.addColorStop(0, '#ff9cec');
  g.addColorStop(1, '#b81fa0');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 0.1 * s;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  // facets
  ctx.beginPath();
  ctx.moveTo(-0.82 * s, -0.2 * s);
  ctx.lineTo(0.82 * s, -0.2 * s);
  ctx.moveTo(-0.3 * s, -0.2 * s);
  ctx.lineTo(0, -1 * s);
  ctx.lineTo(0.3 * s, -0.2 * s);
  ctx.moveTo(-0.3 * s, -0.2 * s);
  ctx.lineTo(0, 1 * s);
  ctx.lineTo(0.3 * s, -0.2 * s);
  ctx.lineWidth = 0.06 * s;
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.stroke();
  // sparkle
  const a = 0.5 + 0.5 * Math.sin(t / 180);
  ctx.fillStyle = `rgba(255,255,255,${0.4 + 0.6 * a})`;
  ctx.fillRect(0.55 * s, -0.95 * s, 0.14 * s, 0.14 * s);
}

// item: { x, y, type }.  cs: cell size in canvas px.  t: performance.now() (drives the pulse)
export function drawSpecialItem(ctx, item, cs, t) {
  const style = POWERUP_STYLE[item.type];
  if (!style) return;
  const cx = (item.x + 0.5) * cs;
  const cy = (item.y + 0.5) * cs;
  const pulse = 0.5 + 0.5 * Math.sin(t / 260 + item.x * 0.7 + item.y * 0.3);
  // Items are large on purpose (about 3 cells across): the board is scaled down to ~0.3-0.5x on phones,
  // and a special item must still be recognisable at a glance there.
  const r = cs * (1.35 + 0.14 * pulse) * (item.type === 'mega' ? 1.1 : 1);
  ctx.save();
  ctx.translate(cx, cy);
  const halo = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 1.9);
  halo.addColorStop(0, `${style.color}${item.type === 'mega' ? 'aa' : '80'}`);
  halo.addColorStop(1, `${style.color}00`);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = '#0b1016';
  ctx.fill();
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = style.color;
  ctx.stroke();
  const s = r * 0.62;
  if (item.type === 'speed') bolt(ctx, s);
  else if (item.type === 'magnet') horseshoe(ctx, s);
  else if (item.type === 'shield') shieldShape(ctx, s);
  else gem(ctx, s * 1.05, t);
  ctx.restore();
}

// Effects around one snake. `snake` needs body[0], direction and the three timers.
export function drawSnakeEffects(ctx, snake, cs, t) {
  const head = snake.body && snake.body[0];
  if (!head) return;
  const cx = (head.x + 0.5) * cs;
  const cy = (head.y + 0.5) * cs;
  if (snake.magnetTicksLeft > 0) {
    const R = POWERUPS.magnet.radius * cs;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,107,107,0.28)';
    ctx.setLineDash([5, 6]);
    ctx.lineDashOffset = -t / 60;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    const spin = t / 500;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,107,107,0.9)';
    ctx.beginPath();
    ctx.arc(0, 0, cs * 1.9, spin, spin + Math.PI * 0.8);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(107,168,255,0.9)';
    ctx.beginPath();
    ctx.arc(0, 0, cs * 1.9, spin + Math.PI, spin + Math.PI * 1.8);
    ctx.stroke();
    ctx.restore();
  }
  if (snake.speedTicksLeft > 0) {
    const d = snake.direction || { x: 1, y: 0 };
    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    for (let i = -1; i <= 1; i++) {
      const len = cs * (1.8 + 1.4 * (0.5 + 0.5 * Math.sin(t / 70 + i * 2)));
      const ox = -d.y * i * cs * 0.5;
      const oy = d.x * i * cs * 0.5;
      ctx.strokeStyle = i === 0 ? 'rgba(255,225,77,0.95)' : 'rgba(120,230,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(ox - d.x * cs * 0.6, oy - d.y * cs * 0.6);
      ctx.lineTo(ox - d.x * (cs * 0.6 + len), oy - d.y * (cs * 0.6 + len));
      ctx.stroke();
    }
    ctx.restore();
  }
  if (snake.shieldTicksLeft > 0) {
    const ending = snake.shieldTicksLeft <= 13; // last ~2s: blink so the player sees it run out
    if (!ending || Math.floor(t / 120) % 2 === 0) {
      ctx.save();
      ctx.translate(cx, cy);
      const r = cs * (1.55 + 0.08 * Math.sin(t / 150));
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(93,179,255,0.16)';
      ctx.fill();
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = 'rgba(160,215,255,0.95)';
      ctx.shadowColor = '#5db3ff';
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.restore();
    }
  }
}

// Compact status entries for the HUD: [{ type, icon, label, seconds | null }] for the active effects.
// (Shield has no countdown worth reading: it is a one-hit item, so it shows the remaining time only
// as a hint next to the label.)
export function activeEffectsForHud(snake, tickMs) {
  const out = [];
  if (snake.speedTicksLeft > 0) out.push({ type: 'speed', seconds: (snake.speedTicksLeft * tickMs) / 1000 });
  if (snake.magnetTicksLeft > 0) out.push({ type: 'magnet', seconds: (snake.magnetTicksLeft * tickMs) / 1000 });
  if (snake.shieldTicksLeft > 0) out.push({ type: 'shield', seconds: (snake.shieldTicksLeft * tickMs) / 1000 });
  return out;
}
