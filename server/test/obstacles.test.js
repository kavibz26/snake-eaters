import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, sleep, FAST, PROTOCOL_VERSION } from './helpers.js';
import { CONFIG } from '../../js/config.js';
import { MatchSim } from '../match.js';
import { buildMap } from '../../js/maps/maps.js';
import { FoodManager } from '../../js/food.js';
import { PowerUpManager, magnetPull } from '../../js/powerups/manager.js';
import { POWERUPS } from '../../js/powerups/config.js';
import { collectSpecial } from '../../js/powerups/effects.js';
import { LocalPredictor, predictorState } from '../../js/net/predict.js';
import { SnapTracker } from '../../js/net/snapcodec.js';
import { Snake } from '../../js/snake.js';
import { buildOccupancyMap } from '../../js/collision.js';

globalThis.window ??= { devicePixelRatio: 1 };
const { Game } = await import('../../js/game.js');
const { decideAIDirection, terrainSteps } = await import('../../js/ai.js');

const DIR = CONFIG.DIRECTIONS;
const blocks = buildMap('blocks');
const ENTRIES = [{ id: 'a', name: 'A', skinId: 'classic' }, { id: 'b', name: 'B', skinId: 'inferno' }];
const wire = (o) => JSON.parse(JSON.stringify(o));
const realRandom = Math.random;
const withRandom = (v, fn) => { Math.random = () => v; try { return fn(); } finally { Math.random = realRandom; } };

// Blocks facts used below: the central cluster is x 37..46, y 26..33; the left wall is x 6..8, y 25..34.
function quiet(mapId = 'blocks') {
  const sim = new MatchSim(ENTRIES, { mapId });
  sim.food.items.clear();
  sim.food.target = 0;
  sim.specials.clear();
  sim.specials.cooldown = 1e9;
  put(sim, 'b', { x: 5, y: 5 }, 'right', 5);
  sim.setFrozen('b', true);
  put(sim, 'a', { x: 30, y: 30 }, 'right', 7);
  sim._commitBaseline();
  return sim;
}
function put(sim, id, head, dirName, length = 7) {
  const s = sim.byId.get(id);
  const d = DIR[dirName];
  s.body = Array.from({ length }, (_, i) => ({ x: head.x - d.x * i, y: head.y - d.y * i }));
  s.direction = s.pendingDirection = d;
  s.inputBuffer = [];
  s.growPending = 0;
  return s;
}
const tickN = (sim, n) => { for (let i = 0; i < n; i++) sim.tick(); };

// ==================================================================================================
// COLLISION
// ==================================================================================================

test('an obstacle is lethal on contact, exactly like a wall', () => {
  const sim = quiet();
  const a = put(sim, 'a', { x: 36, y: 30 }, 'right'); // next cell 37,30 is the central cluster
  sim.tick();
  assert.equal(a.alive, false, 'died on the obstacle');
  assert.ok(sim.events.some((e) => e.e === 'death' && e.id === 'a'));
});

test('wall vs obstacle: both are the same fatal, unattributed death (no killer, same event)', () => {
  const wall = quiet('classic');
  put(wall, 'a', { x: CONFIG.GRID_COLS - 1, y: 30 }, 'right');
  wall.tick();
  const obstacle = quiet();
  put(obstacle, 'a', { x: 36, y: 30 }, 'right');
  obstacle.tick();
  const dw = wall.events.find((e) => e.e === 'death');
  const dob = obstacle.events.find((e) => e.e === 'death');
  assert.equal(dw.cause, dob.cause);
  assert.equal(wall.byId.get('a').alive, obstacle.byId.get('a').alive);
  assert.equal(obstacle.events.filter((e) => e.e === 'kill').length, 0, 'nobody is credited with a kill');
});

test('size does not matter: even a huge snake cannot pass through (or "eat") an obstacle', () => {
  const sim = quiet();
  const a = put(sim, 'a', { x: 36, y: 30 }, 'right', 40);
  sim.tick();
  assert.equal(a.alive, false);
});

test('obstacles do not affect open ground: a snake driving beside a cluster is fine', () => {
  const sim = quiet();
  const a = put(sim, 'a', { x: 30, y: 24 }, 'right'); // y 24 passes just above the central cluster (26..33)
  tickN(sim, 25);
  assert.equal(a.alive, true);
});

test('the Speed / Boost extra step also stops at an obstacle', () => {
  const sim = quiet();
  const a = put(sim, 'a', { x: 35, y: 30 }, 'right'); // boost step 36, normal step 37 (obstacle)
  a.activateBoost(CONFIG.BOOST_DURATION_TICKS);
  sim.tick();
  assert.equal(a.alive, false);
  const sim2 = quiet();
  const b = put(sim2, 'a', { x: 36, y: 30 }, 'right'); // the extra step itself hits
  collectSpecial(b, 'speed');
  b.speedTicksLeft = 5;
  sim2.tickCount = 1; // next tick is even: extra step
  sim2.tick();
  assert.equal(b.alive, false);
});

test('Shield vs obstacle: absorbs the hit once, holds the snake in place, then the next hit is fatal', () => {
  const sim = quiet();
  const a = put(sim, 'a', { x: 36, y: 30 }, 'right');
  collectSpecial(a, 'shield');
  sim.tick();
  assert.equal(a.alive, true);
  assert.equal(`${a.head.x},${a.head.y}`, '36,30', 'held in front of the obstacle');
  assert.equal(a.shieldTicksLeft, 0, 'consumed');
  assert.equal(sim.events.filter((e) => e.e === 'shield').length, 1);
  sim.tick(); // recovery window
  assert.equal(a.alive, true);
  sim.tick(); // no shield, no window
  assert.equal(a.alive, false);
});

test('Shield vs obstacle: the recovery window lets the player steer away', () => {
  const sim = quiet();
  const a = put(sim, 'a', { x: 36, y: 30 }, 'right');
  collectSpecial(a, 'shield');
  sim.tick();
  sim.applyInput('a', 1, { dir: 'up' });
  tickN(sim, 4);
  assert.equal(a.alive, true);
  assert.ok(a.head.y < 30, 'turned away and moved on');
});

test('an obstacle and a body collision in the same tick are still resolved by the ordinary rules', () => {
  const sim = quiet();
  sim.setFrozen('b', false);
  const a = put(sim, 'a', { x: 20, y: 30 }, 'right', 9);
  const b = put(sim, 'b', { x: 22, y: 30 }, 'left', 7); // head-on into the same cell; a is bigger
  sim.tick();
  assert.equal(a.alive, true);
  assert.equal(b.alive, false);
});

// ==================================================================================================
// FOOD AND POWER-UP SPAWNING AROUND OBSTACLES
// ==================================================================================================

test('food never spawns inside an obstacle (initial food, replenishing and spawn-food)', () => {
  for (const id of ['blocks', 'arena']) {
    const map = buildMap(id);
    for (let run = 0; run < 15; run++) {
      const sim = new MatchSim(ENTRIES, { mapId: id });
      for (const f of sim.food.all()) assert.ok(!map.obstacles.has(`${f.x},${f.y}`), `${id}: initial food on open ground`);
      sim.food.items.clear();
      sim.food.target = 400; // demand a lot: forces many placement attempts
      for (let i = 0; i < 300; i++) sim.food.replenish((x, y) => sim._isCellBlocked(x, y), 20);
      assert.ok(sim.food.count > 250, 'plenty of food was placed');
      for (const f of sim.food.all()) assert.ok(!map.obstacles.has(`${f.x},${f.y}`), `${id}: replenished food on open ground`);
    }
  }
});

test('single-player food is also kept off obstacles', () => {
  const game = new Game({ width: 0, height: 0, getContext: () => ({ scale() {} }) }, { update() {} });
  game.setMap('arena');
  game.init();
  game.food.target = 300;
  for (let i = 0; i < 200; i++) game.food.replenish((x, y) => game._isCellBlocked(x, y), 20);
  for (const f of game.food.all()) assert.ok(!game.obstacles.has(`${f.x},${f.y}`));
});

test('power-ups never spawn inside an obstacle, and never in a spot that is boxed in', () => {
  for (const id of ['blocks', 'arena']) {
    const map = buildMap(id);
    const cfg = { ...POWERUPS, spawn: { ...POWERUPS.spawn, startCooldownTicks: 0, cooldownTicks: 0, chancePerTick: 1, maxActive: 99 } };
    const pm = new PowerUpManager({ rng: (() => { let t = 5; return () => { t = (Math.imul(t, 1664525) + 1013904223) >>> 0; return t / 4294967296; }; })(), config: cfg });
    const sim = new MatchSim(ENTRIES, { mapId: id });
    let n = 0;
    for (let t = 1; t <= 800; t++) {
      const { spawned } = pm.update({ tick: t, snakes: sim.snakes, isBlocked: (x, y) => sim._isCellBlocked(x, y) || pm.has(x, y) });
      if (!spawned) continue;
      n++;
      pm.take(spawned.x, spawned.y);
      assert.ok(!map.obstacles.has(`${spawned.x},${spawned.y}`), `${id}: not inside an obstacle`);
      let open = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!map.obstacles.has(`${spawned.x + dx},${spawned.y + dy}`)) open++;
      assert.ok(open >= 2, `${id}: at least two open neighbours (not trapped against an obstacle)`);
    }
    assert.ok(n > 300);
  }
});

test('the server\'s own spawner respects obstacles too (a long match on Blocks)', () => {
  const sim = new MatchSim(ENTRIES, { mapId: 'blocks', rng: (() => { let t = 9; return () => { t = (Math.imul(t, 1664525) + 1013904223) >>> 0; return t / 4294967296; }; })() });
  sim.specials.cfg.spawn.startCooldownTicks = 0;
  sim.specials.cooldown = 0;
  const saved = { ...sim.specials.cfg.spawn };
  sim.specials.cfg = { ...sim.specials.cfg, spawn: { ...saved, cooldownTicks: 1, chancePerTick: 1 } };
  sim.setFrozen('a', true);
  sim.setFrozen('b', true);
  for (let t = 0; t < 400; t++) {
    sim.tick();
    for (const it of sim.specials.all()) assert.ok(!blocks.obstacles.has(`${it.x},${it.y}`));
    for (const it of [...sim.specials.all()]) sim.specials.take(it.x, it.y);
  }
});

// ==================================================================================================
// MAGNET
// ==================================================================================================

test('magnet never pulls food through or into an obstacle', () => {
  const food = new FoodManager(CONFIG.GRID_COLS, CONFIG.GRID_ROWS);
  food.items.clear();
  food.items.set('5,30', { x: 5, y: 30 }); // behind the left wall (x 6..8), 6 cells from the head
  const isBlocked = (x, y) => blocks.obstacles.has(`${x},${y}`) || food.has(x, y);
  const head = { head: { x: 11, y: 30 }, magnetTicksLeft: 99 };
  for (let i = 0; i < 20; i++) magnetPull({ snakes: [head], food, isBlocked, collect: () => assert.fail('collected through a wall') });
  assert.ok(food.has(5, 30), 'the food stayed put behind the wall');
  for (const f of food.all()) assert.ok(!blocks.obstacles.has(`${f.x},${f.y}`));
});

test('magnet still works beside obstacles: food on the open side is pulled in and collected', () => {
  const food = new FoodManager(CONFIG.GRID_COLS, CONFIG.GRID_ROWS);
  food.items.clear();
  food.items.set('13,26', { x: 13, y: 26 });
  const isBlocked = (x, y) => blocks.obstacles.has(`${x},${y}`) || food.has(x, y);
  let got = 0;
  for (let i = 0; i < 12; i++) magnetPull({ snakes: [{ head: { x: 11, y: 30 }, magnetTicksLeft: 99 }], food, isBlocked, collect: () => { got++; } });
  assert.equal(got, 1);
  assert.equal(food.count, 0);
});

test('food pulled by a magnet in a real match never ends up on an obstacle', () => {
  const sim = quiet();
  const a = put(sim, 'a', { x: 30, y: 30 }, 'up', 7);
  collectSpecial(a, 'magnet');
  for (let i = 0; i < 40; i++) { const x = 30 + (i % 10), y = 20 + Math.floor(i / 10) * 3; if (!blocks.obstacles.has(`${x},${y}`)) sim.food.items.set(`${x},${y}`, { x, y }); }
  for (let t = 0; t < 30; t++) {
    sim.tick();
    for (const f of sim.food.all()) assert.ok(!blocks.obstacles.has(`${f.x},${f.y}`), `tick ${t}`);
    if (!a.alive) break;
  }
});

// ==================================================================================================
// AI
// ==================================================================================================

function aiSnake(head, dirName, profile = 'forager') {
  const d = DIR[dirName];
  return new Snake({ isPlayer: false, cells: Array.from({ length: 7 }, (_, i) => ({ x: head.x - d.x * i, y: head.y - d.y * i })), direction: d, skin: { ui: '#fff' }, profile });
}
function aiWorld(ai, { food = [], items = [], terrain = blocks.obstacles }) {
  const occ = buildOccupancyMap([ai]);
  for (const k of terrain) occ.set(k, { isObstacle: true });
  const fm = new FoodManager(CONFIG.GRID_COLS, CONFIG.GRID_ROWS);
  fm.items.clear();
  for (const [x, y] of food) fm.items.set(`${x},${y}`, { x, y });
  const sp = new PowerUpManager({ rng: () => 0.99 });
  for (const [x, y, type = 'speed'] of items) sp.items.set(`${x},${y}`, { x, y, type, born: 1 });
  return { snakes: [ai], foodManager: fm, occupancyMap: occ, specials: sp, terrain, matchTicks: 10, playerPressure: { count: 0, cap: 1 } };
}
const nameOf = (d) => Object.entries(DIR).find(([, v]) => v.x === d.x && v.y === d.y)[0];

test('AI reachability: walking distance around an obstacle is measured, and a detour that is too long counts as unreachable', () => {
  const terrain = blocks.obstacles;
  assert.equal(terrainSteps({ x: 20, y: 40 }, { x: 25, y: 40 }, terrain, 10), 5, 'open ground: the straight-line distance');
  // across the central cluster (x 37..46, y 26..33): go around it
  const around = terrainSteps({ x: 35, y: 30 }, { x: 48, y: 30 }, terrain, 40);
  assert.ok(around > 13 + CONFIG.AI_MAX_DETOUR, `a long way round (${around} steps for 13 cells)`);
  assert.equal(terrainSteps({ x: 35, y: 30 }, { x: 48, y: 30 }, terrain, 13 + CONFIG.AI_MAX_DETOUR), Infinity);
  assert.equal(terrainSteps({ x: 20, y: 40 }, { x: 20, y: 40 }, terrain, 5), 0);
});

test('AI does not fixate on food that is just across an obstacle, but still goes for food it can walk to', () => {
  const ai = aiSnake({ x: 35, y: 30 }, 'up');
  const across = withRandom(0.5, () => nameOf(decideAIDirection(ai, aiWorld(ai, { food: [[48, 30]] }))));
  assert.notEqual(across, 'right', 'not pulled toward food on the far side of the cluster');
  const reachable = aiSnake({ x: 35, y: 40 }, 'up');
  const near = withRandom(0.5, () => nameOf(decideAIDirection(reachable, aiWorld(reachable, { food: [[42, 40]] }))));
  assert.equal(near, 'right', 'food on open ground 7 cells away is still targeted');
});

test('AI does not target a power-up it cannot reasonably reach because of obstacles', () => {
  const ai = aiSnake({ x: 35, y: 30 }, 'up');
  const across = withRandom(0, () => nameOf(decideAIDirection(ai, aiWorld(ai, { items: [[48, 30]] }))));
  assert.notEqual(across, 'right');
  const ai2 = aiSnake({ x: 35, y: 40 }, 'up');
  const near = withRandom(0, () => nameOf(decideAIDirection(ai2, aiWorld(ai2, { items: [[42, 40]] }))));
  assert.equal(near, 'right', 'a reachable item is still chased');
});

test('AI treats obstacles as solid for movement: it never steers into the cell in front of a cluster', () => {
  const ai = aiSnake({ x: 36, y: 30 }, 'right'); // the next cell (37,30) is an obstacle
  for (let i = 0; i < 40; i++) {
    const d = decideAIDirection(ai, aiWorld(ai, {}));
    assert.notEqual(nameOf(d), 'right', 'turns away instead of driving into the cluster');
  }
});

test('AI on obstacle maps: it stays imperfect but survives about as well as on Classic (no mass suicides)', () => {
  const run = (mapId, games = 25) => {
    let alive = 0;
    let obstacleDeaths = 0;
    for (let g = 0; g < games; g++) {
      const game = new Game({ width: 0, height: 0, getContext: () => ({ scale() {} }) }, { update() {} });
      game.setMap(mapId);
      game.init();
      game._endGame = () => {}; // keep simulating even if the idle player dies
      for (let t = 0; t < 180; t++) {
        const before = game.snakes.filter((s) => !s.isPlayer && s.alive).map((s) => ({ s, next: s.nextHead() }));
        game.tick();
        for (const { s, next } of before) if (!s.alive && game.obstacles.has(`${next.x},${next.y}`)) obstacleDeaths++;
      }
      alive += game.snakes.filter((s) => !s.isPlayer && s.alive).length;
    }
    return { alive: alive / games, obstacleDeaths: obstacleDeaths / games };
  };
  const classic = run('classic');
  for (const id of ['blocks', 'arena']) {
    const r = run(id);
    assert.ok(r.obstacleDeaths < 0.6, `${id}: AI deaths on obstacles per game ${r.obstacleDeaths.toFixed(2)}`);
    assert.ok(r.alive >= classic.alive - 0.8, `${id}: ${r.alive.toFixed(2)} AI alive vs ${classic.alive.toFixed(2)} on Classic`);
  }
});

test('single player: the player dies on an obstacle with the same rule, and a shield saves them once', () => {
  const game = new Game({ width: 0, height: 0, getContext: () => ({ scale() {} }) }, { update() {} });
  game.setMap('blocks');
  game.init();
  const p = game.playerSnake;
  const setup = () => {
    game.init();
    const pl = game.playerSnake;
    game.snakes = [pl, game.snakes.find((s) => !s.isPlayer)];
    game.snakes[1].body = Array.from({ length: 6 }, (_, i) => ({ x: 70 + i, y: 3 }));
    game.food.items.clear();
    game.food.target = 0;
    game.specials.clear();
    game.specials.cooldown = 1e9;
    pl.body = Array.from({ length: 7 }, (_, i) => ({ x: 36 - i, y: 30 }));
    pl.direction = pl.pendingDirection = DIR.right;
    pl.inputBuffer = [];
    return pl;
  };
  const a = setup();
  game.tick();
  assert.equal(a.alive, false);
  assert.equal(game.state, 'gameover');
  const b = setup();
  collectSpecial(b, 'shield');
  game.tick();
  assert.equal(b.alive, true, 'shield absorbed the obstacle hit');
  assert.equal(game.state, 'playing');
  assert.equal(b.head.x, 36);
  void p;
});

// ==================================================================================================
// PREDICTION
// ==================================================================================================

function predictFrom(snap, tracker, ticksAhead, obstacles) {
  const me = snap.snakes.find((s) => s.id === 'a');
  const pred = new LocalPredictor();
  pred.setObstacles(obstacles);
  pred.active = true;
  pred.baseTick = snap.tick;
  pred.base = predictorState(snap, me, tracker.bodies.get('a'));
  pred.food = tracker.food;
  pred.rebuild(0);
  for (let i = 1; i <= ticksAhead; i++) pred._step(snap.tick + i);
  return pred;
}

test('prediction treats obstacles as solid: the local snake holds still in front of one instead of drawing through it', () => {
  const sim = quiet();
  put(sim, 'a', { x: 36, y: 30 }, 'right');
  const snap = wire(sim.snapshot({ full: true }));
  const tr = new SnapTracker();
  tr.apply(snap);
  const solid = predictFrom(snap, tr, 3, blocks.obstacles);
  assert.deepEqual({ x: solid.curCells[0].x, y: solid.curCells[0].y }, { x: 36, y: 30 }, 'stays at the obstacle edge');
  const open = predictFrom(snap, tr, 3, new Set());
  assert.equal(open.curCells[0].x, 39, 'without the map it would drive straight through (the bug this prevents)');
});

test('prediction along a route that winds around obstacles matches the server head on every tick', () => {
  const sim = quiet();
  put(sim, 'a', { x: 30, y: 24 }, 'right');
  const a = sim.byId.get('a');
  const plan = { 18: 'down', 30: 'left' }; // no collisions: along the top of the central cluster (y 24), down its right side (x 48), back along its bottom (y 36)
  const tracker = new SnapTracker();
  tracker.apply(wire(sim.snapshot({ full: true })));
  let compared = 0;
  for (let t = 1; t <= 38; t++) {
    if (plan[t]) sim.applyInput('a', t, { dir: plan[t] });
    const snap = wire(sim.snapshot({ full: true }));
    const tr = new SnapTracker();
    tr.apply(snap);
    const pred = predictFrom(snap, tr, 1, blocks.obstacles);
    sim.tick();
    if (!a.alive) break;
    assert.deepEqual({ x: pred.curCells[0].x, y: pred.curCells[0].y }, { x: a.head.x, y: a.head.y }, `tick ${sim.tickCount}`);
    compared++;
  }
  assert.ok(compared >= 36, `compared ${compared} ticks`);
});

test('prediction next to a Shield block on an obstacle already matches the server (held head, then the turn)', () => {
  const sim = quiet();
  const a = put(sim, 'a', { x: 36, y: 30 }, 'right');
  collectSpecial(a, 'shield');
  for (let t = 0; t < 2; t++) {
    const snap = wire(sim.snapshot({ full: true }));
    const tr = new SnapTracker();
    tr.apply(snap);
    const pred = predictFrom(snap, tr, 1, blocks.obstacles);
    sim.tick();
    assert.deepEqual({ x: pred.curCells[0].x, y: pred.curCells[0].y }, { x: a.head.x, y: a.head.y });
  }
});

// ==================================================================================================
// MULTIPLAYER: same map for everyone, restored on reconnect
// ==================================================================================================

const h = harness(FAST);
h.hooks();

test('every lobby has one configured map, listed to the browser and shown in the waiting room', async () => {
  const c = await h.connect('Browser');
  const list = await c.browse();
  assert.deepEqual(list.lobbies.map((l) => l.map), ['classic', 'classic', 'blocks', 'blocks', 'arena', 'arena']);
  assert.equal(list.lobbies.length, 6, 'still exactly six public lobbies');
  const host = await h.enter('Alice', { lobby: 'lobby-3' });
  assert.equal(host.joined.lobby.map, 'blocks');
});

test('multiplayer: both clients in a Blocks match receive the same map, and it is the server map', async () => {
  const host = await h.enter('Alice', { lobby: 'lobby-3' });
  const guest = await h.enter('Bob', { lobby: 'lobby-3', skin: 'inferno' });
  const [a, b] = await Promise.all([host.waitFor('match'), guest.waitFor('match')]);
  assert.equal(a.map, 'blocks');
  assert.equal(b.map, 'blocks');
  assert.equal(a.mh, b.mh);
  const sim = h.lobby('lobby-3').match;
  assert.equal(sim.mapId, 'blocks');
  assert.equal(sim.obstacles, buildMap('blocks').obstacles);
});

test('match messages carry the map (id + fingerprint) that the client rebuilds identically', async () => {
  const host = await h.enter('Alice', { lobby: 'lobby-5' });
  const guest = await h.enter('Bob', { lobby: 'lobby-5', skin: 'inferno' });
  const [a, b] = await Promise.all([host.waitFor('match'), guest.waitFor('match')]);
  for (const m of [a, b]) {
    assert.equal(m.map, 'arena');
    assert.equal(m.mh, buildMap('arena').hash, 'the client can verify it builds the same layout');
  }
  assert.equal(h.lobby('lobby-5').match.map.hash, a.mh);
});

test('Classic lobbies announce Classic (no obstacles)', async () => {
  const host = await h.enter('Alice', { lobby: 'lobby-1' });
  await h.enter('Bob', { lobby: 'lobby-1', skin: 'inferno' });
  const m = await host.waitFor('match');
  assert.equal(m.map, 'classic');
  assert.equal(m.mh, buildMap('classic').hash);
  assert.equal(h.lobby('lobby-1').match.obstacles.size, 0);
});

test('reconnect restores the same map, and the server still enforces it afterwards', async () => {
  const { host, guest, hostId } = await h.startedMatch({ lobby: 'lobby-3' });
  await host.waitFor('snap', (m) => m.tick >= 1);
  const sim = h.lobby('lobby-3').match;
  const { token } = host.joined.you;
  host.ws.terminate();
  await guest.waitFor('lobby', (m) => m.lobby.players.some((p) => p.id === hostId && !p.connected));
  const back = await h.connect('Alice again');
  back.send({ t: 'rejoin', v: PROTOCOL_VERSION, lobby: 'lobby-3', id: hostId, token });
  const resumed = await back.waitFor('match');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.map, 'blocks', 'same map after the reconnect');
  assert.equal(resumed.mh, buildMap('blocks').hash);
  assert.equal(h.lobby('lobby-3').count, 2, 'no duplicate player');
  await guest.waitFor('snap', (m) => m.snakes.find((s) => s.id === hostId).fz === 0);
  // put the rejoined snake in front of a cluster: the server (not the client) decides it dies
  const s = sim.byId.get(hostId);
  const d = DIR.right;
  s.body = Array.from({ length: 7 }, (_, i) => ({ x: 36 - d.x * i, y: 30 }));
  s.direction = s.pendingDirection = d;
  s.inputBuffer = [];
  const snap = await back.waitFor('snap', (m) => m.snakes.find((x) => x.id === hostId).a === 0, 3000);
  assert.equal(snap.snakes.find((x) => x.id === hostId).a, 0, 'died on the obstacle, decided by the server');
});

test('a client cannot change the map: forged map / obstacle messages are ignored', async () => {
  const { host } = await h.startedMatch({ lobby: 'lobby-3' });
  await host.waitFor('snap', (m) => m.tick >= 1);
  for (const forged of [{ t: 'map', id: 'classic' }, { t: 'input', seq: 1, dir: 'up', map: 'classic', obstacles: [] }, { t: 'join', v: PROTOCOL_VERSION, lobby: 'lobby-1', name: 'X', skin: 'classic', map: 'arena' }]) host.send(forged);
  await sleep(300);
  const sim = h.lobby('lobby-3').match;
  assert.equal(sim.mapId, 'blocks');
  assert.equal(sim.obstacles.size, buildMap('blocks').cells.length);
});
