import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../js/config.js';
import { MAPS, MAP_IDS, DEFAULT_MAP_ID, buildMap, getMapDef, isKnownMap } from '../../js/maps/maps.js';
import { spawnFits, findSpawn } from '../../js/maps/spawn.js';
import { hitsTerrain } from '../../js/collision.js';
import { MatchSim } from '../match.js';

globalThis.window ??= { devicePixelRatio: 1 };
const { Game } = await import('../../js/game.js');

const W = CONFIG.GRID_COLS;
const H = CONFIG.GRID_ROWS;

test('three maps exist, Classic is the default and has no obstacles', () => {
  assert.deepEqual(MAP_IDS, ['classic', 'blocks', 'arena']);
  assert.equal(DEFAULT_MAP_ID, 'classic');
  assert.equal(buildMap('classic').cells.length, 0);
  assert.ok(buildMap('blocks').cells.length > 100);
  assert.ok(buildMap('arena').cells.length > 100);
  for (const id of MAP_IDS) assert.ok(MAPS[id].name && MAPS[id].blurb, `${id} has a name and description`);
});

test('unknown / hostile map ids fall back to Classic instead of throwing', () => {
  for (const bad of [undefined, null, '', 'nope', 42, {}, '__proto__', 'constructor', 'toString']) {
    assert.equal(isKnownMap(bad), false, String(bad));
    assert.equal(getMapDef(bad).id, 'classic');
    assert.equal(buildMap(bad).id, 'classic');
  }
});

test('map generation is deterministic: the same id always yields the same cells and fingerprint', () => {
  for (const id of MAP_IDS) {
    const a = buildMap(id);
    const b = buildMap(id);
    assert.equal(a, b, 'built once and shared');
    assert.deepEqual([...a.obstacles].sort(), [...b.obstacles].sort());
    assert.equal(a.cells.length, a.obstacles.size);
    assert.match(a.hash, /^[0-9a-f]{8}$/);
  }
  // Pinned fingerprints: if a layout is edited on purpose, update these together with the change - they are what
  // keeps an old client from silently disagreeing with the server about where the obstacles are.
  assert.equal(buildMap('classic').hash, '811c9dc5');
  assert.equal(buildMap('blocks').hash, 'a207b7f5');
  assert.equal(buildMap('arena').hash, '51fcd369');
  const hashes = new Set(MAP_IDS.map((id) => buildMap(id).hash));
  assert.equal(hashes.size, MAP_IDS.length, 'different maps have different fingerprints');
});

test('the server and the client build the very same obstacles (one shared module, no randomness anywhere)', () => {
  for (const id of MAP_IDS) {
    const sim = new MatchSim([{ id: 'a', name: 'A', skinId: 'classic' }, { id: 'b', name: 'B', skinId: 'inferno' }], { mapId: id });
    assert.equal(sim.map.hash, buildMap(id).hash);
    assert.equal(sim.obstacles, buildMap(id).obstacles);
    const game = new Game({ width: 0, height: 0, getContext: () => ({ scale() {} }) }, { update() {} });
    game.setMap(id);
    assert.equal(game.map.hash, sim.map.hash, `${id}: single player and the server agree`);
  }
});

test('every map keeps a free rim, stays inside the board, and leaves no enclosed pocket', () => {
  for (const id of MAP_IDS) {
    const m = buildMap(id);
    for (const { x, y } of m.cells) {
      assert.ok(x >= 3 && y >= 3 && x < W - 3 && y < H - 3, `${id}: obstacle at ${x},${y} is inside the board with a free rim`);
    }
    const free = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !m.obstacles.has(`${x},${y}`);
    let start = null;
    let total = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (free(x, y)) { total++; start = start || [x, y]; }
    const seen = new Set([start.join(',')]);
    const stack = [start];
    while (stack.length) {
      const [x, y] = stack.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (free(nx, ny) && !seen.has(`${nx},${ny}`)) { seen.add(`${nx},${ny}`); stack.push([nx, ny]); }
      }
    }
    assert.equal(seen.size, total, `${id}: all ${total} open cells are connected (nothing is walled in)`);
    const density = m.cells.length / (W * H);
    assert.ok(density < 0.12, `${id}: obstacles cover ${(density * 100).toFixed(1)}% of the board - plenty of room left`);
  }
});

test('Blocks is made of rectangular clusters; Arena is symmetric on both axes with open lanes', () => {
  const blocks = buildMap('blocks');
  assert.ok(MAPS.blocks.rects.length >= 5, 'several clusters');
  // every obstacle cell belongs to a declared rectangle
  for (const { x, y } of blocks.cells) assert.ok(MAPS.blocks.rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h));
  const arena = buildMap('arena');
  for (const { x, y } of arena.cells) {
    assert.ok(arena.obstacles.has(`${W - 1 - x},${y}`), `mirror in x of ${x},${y}`);
    assert.ok(arena.obstacles.has(`${x},${H - 1 - y}`), `mirror in y of ${x},${y}`);
  }
  // an open lane through the middle in both directions
  let laneRow = false;
  for (let y = 0; y < H; y++) {
    let clear = true;
    for (let x = 0; x < W; x++) if (arena.obstacles.has(`${x},${y}`)) clear = false;
    if (clear) laneRow = true;
  }
  let laneCol = false;
  for (let x = 0; x < W; x++) {
    let clear = true;
    for (let y = 0; y < H; y++) if (arena.obstacles.has(`${x},${y}`)) clear = false;
    if (clear) laneCol = true;
  }
  assert.ok(laneRow && laneCol, 'fully open lanes run across the arena both ways');
});

test('hitsTerrain: the board edge and every obstacle cell are solid, open ground is not', () => {
  const m = buildMap('blocks');
  assert.equal(hitsTerrain(m.obstacles, -1, 5), true);
  assert.equal(hitsTerrain(m.obstacles, 5, H), true);
  assert.equal(hitsTerrain(m.obstacles, 37, 26), true, 'a Blocks obstacle cell');
  assert.equal(hitsTerrain(m.obstacles, 36, 26), false);
  assert.equal(hitsTerrain(null, 10, 10), false, 'no map: just the edge');
  assert.equal(hitsTerrain(buildMap('classic').obstacles, 10, 10), false);
  for (const c of m.cells) assert.equal(hitsTerrain(m.obstacles, c.x, c.y), true);
});

test('spawning: every snake starts on open ground with clear road ahead, on every map, for every player count', () => {
  for (const id of MAP_IDS) {
    const m = buildMap(id);
    for (let n = 2; n <= 6; n++) {
      for (let run = 0; run < 40; run++) {
        const entries = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, skinId: ['classic', 'inferno', 'frost', 'toxic', 'cosmic', 'golden'][i] }));
        const sim = new MatchSim(entries, { mapId: id });
        const used = new Set();
        for (const s of sim.snakes) {
          for (const c of s.body) {
            assert.ok(!hitsTerrain(m.obstacles, c.x, c.y), `${id}: a spawned body cell is not on an obstacle`);
            const k = `${c.x},${c.y}`;
            assert.ok(!used.has(k), `${id}: two snakes share a cell`);
            used.add(k);
          }
          if (m.cells.length) assert.ok(spawnFits(m.obstacles, s.head.x, s.head.y, s.length, s.direction), `${id}: spawn has clearance and a free run ahead`);
        }
      }
    }
  }
});

test('single-player spawns are valid on every map too (player and the five AI)', () => {
  for (const id of MAP_IDS) {
    const m = buildMap(id);
    for (let run = 0; run < 40; run++) {
      const game = new Game({ width: 0, height: 0, getContext: () => ({ scale() {} }) }, { update() {} });
      game.setMap(id);
      game.init();
      const used = new Set();
      assert.equal(game.snakes.length, 1 + CONFIG.AI_COUNT);
      for (const s of game.snakes) {
        for (const c of s.body) {
          assert.ok(!hitsTerrain(m.obstacles, c.x, c.y), `${id}: spawn on open ground`);
          assert.ok(!used.has(`${c.x},${c.y}`), 'no overlapping spawns');
          used.add(`${c.x},${c.y}`);
        }
      }
      assert.equal(game.state, 'playing');
    }
  }
});

test('findSpawn moves a spawn off an obstacle and never returns an unfit spot', () => {
  const m = buildMap('blocks');
  const inside = { x: 42, y: 30 }; // the middle of the central cluster
  assert.equal(spawnFits(m.obstacles, inside.x, inside.y, 7, CONFIG.DIRECTIONS.right), false);
  const spot = findSpawn(m.obstacles, inside.x, inside.y, 7, CONFIG.DIRECTIONS.right, 20);
  assert.ok(spot, 'a nearby open spot was found');
  assert.ok(spawnFits(m.obstacles, spot.cx, spot.cy, 7, spot.dir));
  assert.equal(findSpawn(m.obstacles, inside.x, inside.y, 7, CONFIG.DIRECTIONS.right, 0), null, 'radius 0 cannot help from inside a cluster');
  // Classic: the requested spot is used as is
  const c = findSpawn(buildMap('classic').obstacles, 42, 30, 7, CONFIG.DIRECTIONS.up);
  assert.deepEqual([c.cx, c.cy, c.dir], [42, 30, CONFIG.DIRECTIONS.up]);
});

test('Classic behaves exactly as before: no obstacles, default map, nothing extra to draw or check', () => {
  const sim = new MatchSim([{ id: 'a', name: 'A', skinId: 'classic' }, { id: 'b', name: 'B', skinId: 'inferno' }]);
  assert.equal(sim.mapId, 'classic');
  assert.equal(sim.obstacles.size, 0);
  const game = new Game({ width: 0, height: 0, getContext: () => ({ scale() {} }) }, { update() {} });
  assert.equal(game.mapId, 'classic');
  assert.equal(game.obstacles.size, 0);
  game.setMap('not-a-map');
  assert.equal(game.mapId, 'classic');
});
