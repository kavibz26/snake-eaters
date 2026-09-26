// Draws a map's obstacles. Client only. The obstacle layer is rendered ONCE per (map, pixel ratio) into an
// offscreen canvas and then blitted with a single drawImage per frame, so obstacles cost almost nothing
// while playing. Style: steel-blue blocks with a bevel, a hatched face and a bright outline around each
// cluster - clearly different from the dark board, the grid, food, snakes and power-ups.
import { CONFIG } from '../config.js';

const layers = new Map();

function buildLayer(map, cs, dpr) {
  const w = CONFIG.GRID_COLS * cs;
  const h = CONFIG.GRID_ROWS * cs;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const has = (x, y) => map.obstacles.has(`${x},${y}`);

  for (const { x, y } of map.cells) {
    const px = x * cs;
    const py = y * cs;
    g.fillStyle = '#354660';
    g.fillRect(px, py, cs, cs);
    // bevel: light top/left edge, dark bottom/right edge
    g.fillStyle = 'rgba(255,255,255,0.13)';
    g.fillRect(px, py, cs, 2);
    g.fillRect(px, py, 2, cs);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(px, py + cs - 2, cs, 2);
    g.fillRect(px + cs - 2, py, 2, cs);
  }
  // hatch texture across the faces (kept subtle so it never fights the snakes)
  g.strokeStyle = 'rgba(190,210,235,0.09)';
  g.lineWidth = 1;
  g.beginPath();
  for (const { x, y } of map.cells) {
    const px = x * cs;
    const py = y * cs;
    g.moveTo(px + 2, py + cs - 3);
    g.lineTo(px + cs - 3, py + 2);
  }
  g.stroke();
  // outline where an obstacle meets open ground
  g.strokeStyle = '#a9c0e0';
  g.lineWidth = 2;
  g.lineCap = 'square';
  g.beginPath();
  for (const { x, y } of map.cells) {
    const px = x * cs;
    const py = y * cs;
    if (!has(x, y - 1)) { g.moveTo(px, py + 1); g.lineTo(px + cs, py + 1); }
    if (!has(x, y + 1)) { g.moveTo(px, py + cs - 1); g.lineTo(px + cs, py + cs - 1); }
    if (!has(x - 1, y)) { g.moveTo(px + 1, py); g.lineTo(px + 1, py + cs); }
    if (!has(x + 1, y)) { g.moveTo(px + cs - 1, py); g.lineTo(px + cs - 1, py + cs); }
  }
  g.stroke();
  // small map watermark in the top-left corner (the rim is always free of obstacles)
  g.font = '700 13px "Segoe UI", sans-serif';
  g.textBaseline = 'top';
  g.fillStyle = 'rgba(169,192,224,0.75)';
  g.fillText(map.name.toUpperCase(), 7, 4);
  return canvas;
}

// ctx is the game's 2D context (already scaled by the pixel ratio); w/h are logical board pixels.
export function drawObstacles(ctx, map, cs, dpr, w, h) {
  if (!map || map.cells.length === 0) return;
  const key = `${map.id}@${cs}@${dpr}`;
  let layer = layers.get(key);
  if (!layer) {
    layer = buildLayer(map, cs, dpr);
    layers.set(key, layer);
  }
  ctx.drawImage(layer, 0, 0, w, h);
}
