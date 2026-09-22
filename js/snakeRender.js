// Shared canvas-drawing primitives for snake skins. Used by both the live
// game renderer (game.js, real gameplay) and the skin-picker preview
// canvases (main.js, the start-screen cards) so a skin looks pixel-identical
// in both places and pattern logic never gets duplicated.
//
// Every mark is deterministic (keyed off segment index only, never
// Math.random()) so nothing flickers frame to frame in the live game.

export function roundedSquare(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function lighten(hex, amount) {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const lr = Math.round(r + (255 - r) * amount);
  const lg = Math.round(g + (255 - g) * amount);
  const lb = Math.round(b + (255 - b) * amount);
  return `rgb(${lr},${lg},${lb})`;
}

// --- signature per-skin markings -----------------------------------------
// Each takes the segment's center (x,y) and size, and paints within roughly
// a [-size/2, size/2] box. Called with fillStyle/strokeStyle free to set.

function markDiamond(ctx, x, y, size, skin) {
  const s = size * 0.32;
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s, y);
  ctx.lineTo(x, y + s);
  ctx.lineTo(x - s, y);
  ctx.closePath();
  ctx.fillStyle = skin.accent;
  ctx.fill();
  ctx.strokeStyle = skin.accent2;
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.stroke();
}

function markCrack(ctx, x, y, size, skin) {
  const s = size * 0.36;
  ctx.strokeStyle = skin.accent;
  ctx.lineWidth = Math.max(1.2, size * 0.09);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x - s, y - s * 0.6);
  ctx.lineTo(x - s * 0.2, y);
  ctx.lineTo(x + s * 0.3, y - s * 0.5);
  ctx.lineTo(x + s, y + s * 0.5);
  ctx.stroke();
}

function markCrystal(ctx, x, y, size, skin) {
  const s = size * 0.3;
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s * 0.78, y + s * 0.6);
  ctx.lineTo(x - s * 0.78, y + s * 0.6);
  ctx.closePath();
  ctx.fillStyle = skin.accent;
  ctx.fill();
  ctx.strokeStyle = skin.accent2;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function markToxic(ctx, x, y, size, skin) {
  ctx.fillStyle = skin.accent;
  const r = size * 0.1;
  const spots = [
    [0, -size * 0.22],
    [size * 0.2, size * 0.14],
    [-size * 0.2, size * 0.14],
  ];
  for (const [dx, dy] of spots) {
    ctx.beginPath();
    ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function markStars(ctx, x, y, size, skin) {
  const stars = [
    [-size * 0.22, -size * 0.18, size * 0.05],
    [size * 0.2, size * 0.05, size * 0.045],
    [0, size * 0.24, size * 0.04],
  ];
  ctx.fillStyle = skin.accent2;
  for (const [dx, dy, r] of stars) {
    ctx.beginPath();
    ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function markMetallic(ctx, x, y, size, skin) {
  ctx.strokeStyle = skin.accent2;
  ctx.lineWidth = Math.max(1, size * 0.09);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - size * 0.3, y - size * 0.28);
  ctx.lineTo(x + size * 0.3, y + size * 0.1);
  ctx.stroke();
  ctx.fillStyle = skin.accent;
  ctx.beginPath();
  ctx.arc(x, y + size * 0.24, size * 0.06, 0, Math.PI * 2);
  ctx.fill();
}

function markShadow(ctx, x, y, size, skin) {
  ctx.globalAlpha *= 0.65;
  ctx.fillStyle = skin.accent;
  ctx.beginPath();
  ctx.ellipse(x, y, size * 0.3, size * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha /= 0.65;
  ctx.strokeStyle = skin.accent2;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, size * 0.34, Math.PI * 0.15, Math.PI * 0.95);
  ctx.stroke();
}

function markCamo(ctx, x, y, size, skin) {
  ctx.fillStyle = skin.accent;
  ctx.beginPath();
  ctx.ellipse(x - size * 0.15, y - size * 0.08, size * 0.22, size * 0.14, 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = skin.accent2;
  ctx.beginPath();
  ctx.ellipse(x + size * 0.16, y + size * 0.12, size * 0.18, size * 0.12, -0.35, 0, Math.PI * 2);
  ctx.fill();
}

const PATTERN_MARKS = {
  diamond: markDiamond,
  crack: markCrack,
  crystal: markCrystal,
  toxic: markToxic,
  stars: markStars,
  metallic: markMetallic,
  shadow: markShadow,
  camo: markCamo,
};

// Faint scale-row hint drawn on every body segment, regardless of skin, so
// every skin reads as "scaled snake skin" rather than a flat-shaded blob.
function drawScaleTexture(ctx, x, y, size, skin, index) {
  ctx.strokeStyle = skin.baseShade;
  ctx.globalAlpha *= 0.5;
  ctx.lineWidth = Math.max(1, size * 0.06);
  const flip = index % 2 === 0;
  ctx.beginPath();
  ctx.arc(x - size * 0.16, y, size * 0.18, flip ? 0.2 : Math.PI + 0.2, flip ? Math.PI - 0.2 : Math.PI * 2 - 0.2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + size * 0.16, y, size * 0.18, flip ? Math.PI + 0.2 : 0.2, flip ? Math.PI * 2 - 0.2 : Math.PI - 0.2);
  ctx.stroke();
}

// Paints one body segment (or the head) of a snake with its full skin: base
// fill, scale texture, and - on the head and every Nth body segment - the
// skin's signature marking (with an optional glow). This is the single
// source of truth for "what a skin looks like" that both live gameplay and
// the skin-picker previews call into.
export function paintSnakeSegment(ctx, skin, x, y, size, index, isHead, justAte, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;

  ctx.fillStyle = isHead ? lighten(skin.base, justAte ? 0.5 : 0.2) : skin.base;
  roundedSquare(ctx, x - size / 2, y - size / 2, size, size, size * 0.32);
  ctx.fill();

  if (!isHead) {
    drawScaleTexture(ctx, x, y, size, skin, index);
  }

  const period = skin.patternPeriod || 3;
  if (isHead || index % period === period - 1) {
    ctx.save();
    if (skin.glow) {
      ctx.shadowColor = skin.accent2 || skin.accent;
      ctx.shadowBlur = skin.glow;
    }
    const markFn = PATTERN_MARKS[skin.pattern];
    if (markFn) markFn(ctx, x, y, size, skin);
    ctx.restore();
  }

  ctx.restore();
}

// Renders a small curved-body preview of a skin onto a picker card's canvas.
export function renderSkinPreview(canvas, skin) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = '#0a0d12';
  roundedSquare(ctx, 0, 0, w, h, 8);
  ctx.fill();

  const segCount = 7;
  const cx = w / 2;
  const cy = h / 2;
  const size = Math.min(w, h) * 0.42;
  const spacing = size * 0.6;

  for (let i = segCount - 1; i >= 0; i--) {
    const pos = segCount - 1 - i; // 0 at tail, segCount-1 at head
    const t = 1 - i / (segCount - 1);
    const isHead = i === 0;
    const segSize = size * (isHead ? 1 : 0.62 + 0.3 * t);
    const x = cx + (pos - (segCount - 1) / 2) * spacing;
    const y = cy + Math.sin(pos * 0.9) * size * 0.2;
    const alpha = isHead ? 1 : 0.6 + 0.4 * t;

    paintSnakeSegment(ctx, skin, x, y, segSize, i, isHead, false, alpha);

    if (isHead) {
      const eyeOffset = segSize * 0.2;
      ctx.fillStyle = skin.accent2 || '#0d1117';
      ctx.beginPath();
      ctx.arc(x + eyeOffset, y - eyeOffset, segSize * 0.11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0d1117';
      ctx.beginPath();
      ctx.arc(x + eyeOffset, y - eyeOffset, segSize * 0.065, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
