import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../js/config.js';
import { FoodManager } from '../../js/food.js';
import { Snake } from '../../js/snake.js';
import { MatchSim } from '../match.js';
import { PowerUpManager, magnetPull } from '../../js/powerups/manager.js';
import { POWERUPS, POWERUP_TYPES } from '../../js/powerups/config.js';
import { collectSpecial, takesExtraStep, absorbLethal, initEffects, clearEffects } from '../../js/powerups/effects.js';
import { SnapTracker, DIR_VECS } from '../../js/net/snapcodec.js';
import { LocalPredictor, predictorState } from '../../js/net/predict.js';
import { computeMatchRewards, foodFromMultiplayerScore, megaXP, powerupXP } from '../../js/profile/rewards.js';
import { fromMultiplayer, fromSinglePlayer } from '../../js/profile/results.js';
import { Profile } from '../../js/profile/profile.js';
import { REWARDS } from '../../js/profile/config.js';

// --- helpers -------------------------------------------------------------------------------------------
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const ENTRIES = [
  { id: 'a', name: 'A', skinId: 'classic' },
  { id: 'b', name: 'B', skinId: 'inferno' },
];

// A quiet arena: no food, no spawner, snake b frozen in a corner so it is just a solid obstacle.
function arena() {
  const sim = new MatchSim(ENTRIES, { rng: mulberry32(1) });
  sim.food.items.clear();
  sim.food.target = 0;
  sim.specials.clear();
  sim.specials.cooldown = 1e9;
  stage(sim, 'b', { x: 5, y: 5 }, 'right', 5);
  sim.setFrozen('b', true);
  stage(sim, 'a', { x: 20, y: 30 }, 'right', 7);
  sim._commitBaseline();
  return sim;
}
function stage(sim, id, head, dirName, length = 7) {
  const s = sim.byId.get(id);
  const dir = CONFIG.DIRECTIONS[dirName];
  s.body = Array.from({ length }, (_, i) => ({ x: head.x - dir.x * i, y: head.y - dir.y * i }));
  s.direction = s.pendingDirection = dir;
  s.inputBuffer = [];
  s.growPending = 0;
  return s;
}
const headOf = (s) => `${s.head.x},${s.head.y}`;
const tickN = (sim, n) => { for (let i = 0; i < n; i++) sim.tick(); };
const cellsMoved = (before, after) => Math.abs(after.x - before.x) + Math.abs(after.y - before.y);

// ==================================================================================================
// CONFIG
// ==================================================================================================

test('exactly four power-ups exist, and every balance number lives in one config object', () => {
  assert.deepEqual(POWERUP_TYPES, ['speed', 'magnet', 'shield', 'mega']);
  assert.equal(POWERUPS.speed.durationTicks, Math.round(5000 / CONFIG.TICK_MS));
  assert.equal(POWERUPS.magnet.durationTicks, Math.round(7000 / CONFIG.TICK_MS));
  assert.equal(POWERUPS.shield.durationTicks, Math.round(8000 / CONFIG.TICK_MS));
  assert.ok(POWERUPS.mega.score > CONFIG.FOOD_SCORE * 2, 'mega food is worth substantially more than normal food');
  assert.ok(POWERUPS.spawn.maxActive >= 1 && POWERUPS.spawn.maxActive <= 4);
});

// ==================================================================================================
// SPAWNING
// ==================================================================================================

function pmContext(snakes = [], food = new Set()) {
  const bodies = new Set();
  for (const s of snakes) for (const c of s.body) bodies.add(`${c.x},${c.y}`);
  return { snakes, isBlocked: (x, y) => bodies.has(`${x},${y}`) || food.has(`${x},${y}`) };
}

test('spawning: nothing during the start cooldown, then spawns can happen; a spawn starts a new cooldown', () => {
  const m = new PowerUpManager({ rng: () => 0 }); // always "lucky"
  const ctx = (tick) => ({ tick, ...pmContext() });
  for (let t = 1; t <= POWERUPS.spawn.startCooldownTicks; t++) assert.equal(m.update(ctx(t)).spawned, null, `tick ${t} is inside the start cooldown`);
  const first = m.update(ctx(POWERUPS.spawn.startCooldownTicks + 1)).spawned;
  assert.ok(first, 'first item once the cooldown is over');
  m.take(first.x, first.y);
  for (let t = 1; t <= POWERUPS.spawn.cooldownTicks; t++) assert.equal(m.update(ctx(1000 + t)).spawned, null, 'cooldown between spawns');
  assert.ok(m.update(ctx(2000)).spawned);
});

test('spawning: the probability gate holds (an unlucky roll never spawns)', () => {
  const m = new PowerUpManager({ rng: () => 0.9 }); // >= chancePerTick
  m.cooldown = 0;
  for (let t = 1; t < 2000; t++) assert.equal(m.update({ tick: t, ...pmContext() }).spawned, null);
});

test('spawning: never more than maxActive items, and unclaimed items expire', () => {
  const m = new PowerUpManager({ rng: mulberry32(3), config: { ...POWERUPS, spawn: { ...POWERUPS.spawn, startCooldownTicks: 0, cooldownTicks: 0, chancePerTick: 1 } } });
  let peak = 0;
  for (let t = 1; t <= 400; t++) {
    m.update({ tick: t, ...pmContext() });
    peak = Math.max(peak, m.count);
    assert.ok(m.count <= POWERUPS.spawn.maxActive, `cap at tick ${t}`);
  }
  assert.equal(peak, POWERUPS.spawn.maxActive, 'the cap is actually reached');
  // stop spawning: everything disappears after its lifetime
  const dead = new PowerUpManager({ rng: () => 0.99 });
  dead.items.set('10,10', { x: 10, y: 10, type: 'speed', born: 100 });
  dead.update({ tick: 100 + POWERUPS.spawn.lifetimeTicks - 1, ...pmContext() });
  assert.equal(dead.count, 1);
  const r = dead.update({ tick: 100 + POWERUPS.spawn.lifetimeTicks, ...pmContext() });
  assert.equal(dead.count, 0);
  assert.equal(r.expired.length, 1);
});

test('spawning: every spawned cell is valid (inside the margin, free, away from snakes, reachable)', () => {
  const cfg = { ...POWERUPS, spawn: { ...POWERUPS.spawn, startCooldownTicks: 0, cooldownTicks: 0, chancePerTick: 1, maxActive: 99 } };
  const m = new PowerUpManager({ rng: mulberry32(11), config: cfg });
  const snakeA = new Snake({ isPlayer: true, cells: Array.from({ length: 12 }, (_, i) => ({ x: 30 - i, y: 30 })), direction: CONFIG.DIRECTIONS.right, skin: { ui: '#fff' } });
  const snakeB = new Snake({ isPlayer: true, cells: Array.from({ length: 9 }, (_, i) => ({ x: 60, y: 10 + i })), direction: CONFIG.DIRECTIONS.down, skin: { ui: '#fff' } });
  const food = new Set(['40,40', '41,40', '42,40']);
  const ctx = pmContext([snakeA, snakeB], food);
  const margin = POWERUPS.spawn.edgeMargin;
  let n = 0;
  for (let t = 1; t <= 600; t++) {
    const { spawned } = m.update({ tick: t, ...ctx });
    if (!spawned) continue;
    n++;
    m.take(spawned.x, spawned.y);
    assert.ok(spawned.x >= margin && spawned.x < CONFIG.GRID_COLS - margin && spawned.y >= margin && spawned.y < CONFIG.GRID_ROWS - margin, 'inside the board with a margin');
    assert.ok(!ctx.isBlocked(spawned.x, spawned.y), 'not on a snake or on food');
    for (const s of [snakeA, snakeB]) for (const c of s.body) assert.ok(Math.abs(c.x - spawned.x) + Math.abs(c.y - spawned.y) >= POWERUPS.spawn.minSnakeDistance, 'minimum distance from every snake segment');
    let open = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!ctx.isBlocked(spawned.x + dx, spawned.y + dy)) open++;
    assert.ok(open >= 2, 'reachable (at least two open neighbours)');
    assert.ok(POWERUP_TYPES.includes(spawned.type));
  }
  assert.ok(n > 300, `enough samples (${n})`);
});

test('spawning: a completely blocked board simply skips the spawn (no crash, no item)', () => {
  const m = new PowerUpManager({ rng: () => 0, config: { ...POWERUPS, spawn: { ...POWERUPS.spawn, startCooldownTicks: 0 } } });
  assert.equal(m.update({ tick: 1, snakes: [], isBlocked: () => true }).spawned, null);
});

test('spawning is rare enough that normal food stays the main thing: ~a handful per 5-minute match, all four types appear', () => {
  const ticks = Math.round((5 * 60 * 1000) / CONFIG.TICK_MS);
  const counts = {};
  let spawns = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const m = new PowerUpManager({ rng: mulberry32(seed) });
    for (let t = 1; t <= ticks; t++) {
      const { spawned } = m.update({ tick: t, ...pmContext() });
      if (spawned) { spawns++; counts[spawned.type] = (counts[spawned.type] || 0) + 1; m.take(spawned.x, spawned.y); }
    }
  }
  const perMatch = spawns / 20;
  assert.ok(perMatch >= 8 && perMatch <= 25, `${perMatch.toFixed(1)} items per 5-minute match if everything is collected`);
  for (const t of POWERUP_TYPES) assert.ok(counts[t] > 0, `${t} spawns`);
  const foodPerMatch = Math.floor((CONFIG.GRID_COLS * CONFIG.GRID_ROWS) / CONFIG.FOOD_TARGET_DIVISOR);
  assert.ok(perMatch < foodPerMatch, 'far fewer special items than the food standing on the board');
});

// ==================================================================================================
// SPEED
// ==================================================================================================

test('speed: picking it up sets the timer; the snake then covers 1.5 cells per tick on average', () => {
  const sim = arena();
  const a = sim.byId.get('a');
  collectSpecial(a, 'speed');
  assert.equal(a.speedTicksLeft, POWERUPS.speed.durationTicks);
  const start = { x: a.head.x, y: a.head.y };
  tickN(sim, 10);
  assert.equal(cellsMoved(start, a.head), 15, '10 ticks: 10 normal steps + 5 extra steps (every 2nd tick)');
  assert.equal(a.speedTicksLeft, POWERUPS.speed.durationTicks - 10);
});

test('speed: it expires by itself and normal speed resumes; base speed is never altered', () => {
  const sim = arena();
  const a = sim.byId.get('a');
  stage(sim, 'a', { x: 5, y: 40 }, 'right', 7);
  collectSpecial(a, 'speed');
  tickN(sim, POWERUPS.speed.durationTicks);
  assert.equal(a.speedTicksLeft, 0);
  const at = { x: a.head.x, y: a.head.y };
  tickN(sim, 6);
  assert.equal(cellsMoved(at, a.head), 6, 'one cell per tick again');
  assert.equal(takesExtraStep(a, 2), false);
  assert.equal(takesExtraStep(a, 3), false);
});

test('speed: re-picking it while active REFRESHES the timer (never stacks, never speeds up further)', () => {
  const sim = arena();
  const a = sim.byId.get('a');
  stage(sim, 'a', { x: 5, y: 40 }, 'right', 7);
  collectSpecial(a, 'speed');
  tickN(sim, 12);
  const left = a.speedTicksLeft;
  assert.ok(left < POWERUPS.speed.durationTicks);
  collectSpecial(a, 'speed');
  assert.equal(a.speedTicksLeft, POWERUPS.speed.durationTicks, 'reset to the full duration, not duration + remainder');
  const before = { x: a.head.x, y: a.head.y };
  tickN(sim, 10);
  assert.equal(cellsMoved(before, a.head), 15, 'still 1.5 cells/tick, not more');
  assert.equal(a.powerupsCollected, 2);
});

test('speed + Boost: at most ONE extra step per tick, so the combination is capped at 2 cells/tick', () => {
  const sim = arena();
  const a = sim.byId.get('a');
  stage(sim, 'a', { x: 5, y: 40 }, 'right', 7);
  collectSpecial(a, 'speed');
  a.activateBoost(CONFIG.BOOST_DURATION_TICKS);
  let prev = { x: a.head.x, y: a.head.y };
  for (let i = 0; i < CONFIG.BOOST_DURATION_TICKS; i++) {
    sim.tick();
    assert.equal(cellsMoved(prev, a.head), 2, `tick ${i + 1}: exactly 2 cells (boost step + normal step), never 3`);
    prev = { x: a.head.x, y: a.head.y };
  }
  assert.equal(a.boostTicksLeft, 0, 'boost ended and started its cooldown');
  assert.ok(a.boostCooldownLeft > 0);
  assert.ok(a.speedTicksLeft > 0, 'the speed power-up kept counting down underneath the boost');
  const at = { x: a.head.x, y: a.head.y };
  tickN(sim, 4);
  assert.equal(cellsMoved(at, a.head), 6, 'after the boost: back to the 1.5x speed power-up');
  for (let tk = 1; tk < 50; tk++) {
    const s = { boostTicksLeft: 5, speedTicksLeft: 5 };
    assert.equal(takesExtraStep(s, tk), true);
  }
});

test('the client predictor mirrors the Speed rule exactly (same head cell as the server on every tick)', () => {
  const sim = arena();
  const a = sim.byId.get('a');
  stage(sim, 'a', { x: 5, y: 40 }, 'right', 7);
  collectSpecial(a, 'speed');
  const tracker = new SnapTracker();
  tracker.apply(sim.snapshot({ full: true }));
  for (let k = 0; k < 30; k++) {
    const snap = JSON.parse(JSON.stringify(sim.snapshot({ full: true })));
    const me = snap.snakes.find((s) => s.id === 'a');
    tracker.apply(snap);
    const pred = new LocalPredictor();
    pred.active = true;
    pred.baseTick = snap.tick;
    pred.base = predictorState(snap, me, tracker.bodies.get('a'));
    pred.food = tracker.food;
    pred.rebuild(0);
    pred._step(snap.tick + 1);
    sim.tick();
    assert.deepEqual({ x: pred.curCells[0].x, y: pred.curCells[0].y }, { x: a.head.x, y: a.head.y }, `tick ${sim.tickCount}`);
  }
});

// ==================================================================================================
// MAGNET
// ==================================================================================================

function fakeSnake(x, y, magnet = 10) {
  return { head: { x, y }, magnetTicksLeft: magnet };
}
function foodWith(cells) {
  const f = new FoodManager(CONFIG.GRID_COLS, CONFIG.GRID_ROWS);
  f.items.clear();
  for (const [x, y] of cells) f.items.set(`${x},${y}`, { x, y });
  return f;
}

test('magnet: food inside the radius moves one cell toward the head per tick; food outside is untouched', () => {
  const r = POWERUPS.magnet.radius;
  const food = foodWith([[30 + 4, 30 + 2], [30 + r + 3, 30]]);
  const collected = [];
  magnetPull({ snakes: [fakeSnake(30, 30)], food, isBlocked: () => false, collect: (s, f) => collected.push(f) });
  assert.ok(food.has(33, 32) || food.has(34, 31), 'moved one cell closer along one axis (was 4,2 away)');
  assert.ok(food.has(30 + r + 3, 30), 'the food beyond the radius did not move');
  assert.equal(collected.length, 0);
});

test('magnet: food keeps coming and is collected when it reaches the head; every step is bounded', () => {
  const food = foodWith([[35, 30]]);
  const collected = [];
  let steps = 0;
  while (food.count && steps < 20) {
    magnetPull({ snakes: [fakeSnake(30, 30)], food, isBlocked: () => false, collect: (s, f) => collected.push(f) });
    steps++;
  }
  assert.equal(collected.length, 1);
  assert.equal(steps, 5, 'five cells away: four moves, then collected when adjacent');
  assert.equal(food.count, 0);
});

test('magnet: food never moves onto a blocked cell (snake body / other food); it tries the other axis', () => {
  const food = foodWith([[34, 32]]);
  // moving along x first would land on 33,32 - blocked - so it uses y
  magnetPull({ snakes: [fakeSnake(30, 30)], food, isBlocked: (x, y) => x === 33 && y === 32, collect: () => {} });
  assert.ok(food.has(34, 31));
  const stuck = foodWith([[34, 31]]);
  magnetPull({ snakes: [fakeSnake(30, 30)], food: stuck, isBlocked: () => true, collect: () => {} });
  assert.ok(stuck.has(34, 31), 'fully blocked: it just stays');
});

test('magnet: only active magnets pull, and the work is bounded (one pass over the food)', () => {
  const food = foodWith([[33, 30]]);
  magnetPull({ snakes: [fakeSnake(30, 30, 0)], food, isBlocked: () => false, collect: () => assert.fail('an expired magnet must not pull') });
  assert.ok(food.has(33, 30));
  const big = foodWith(Array.from({ length: 400 }, (_, i) => [i % 84, Math.floor(i / 84) + 10]));
  let calls = 0;
  const t0 = performance.now();
  magnetPull({ snakes: [fakeSnake(40, 12)], food: big, isBlocked: () => { calls++; return false; }, collect: () => {} });
  assert.ok(performance.now() - t0 < 50, 'a full pass over hundreds of food items is instant');
  assert.ok(calls <= 400, 'at most one blocked-check per food item');
});

test('magnet in the simulation: food follows a moving snake and is collected as score, then the effect expires on time', () => {
  const sim = arena();
  const a = sim.byId.get('a');
  stage(sim, 'a', { x: 20, y: 30 }, 'right', 7);
  sim.food.items.set('26,32', { x: 26, y: 32 });
  collectSpecial(a, 'magnet');
  assert.equal(a.magnetTicksLeft, POWERUPS.magnet.durationTicks);
  const score0 = a.score;
  tickN(sim, 8);
  assert.equal(sim.food.count, 0, 'the food was pulled in and eaten');
  assert.equal(a.score, score0 + CONFIG.FOOD_SCORE);
  assert.equal(a.foodEaten, 1);
  assert.ok(a.magnetTicksLeft < POWERUPS.magnet.durationTicks);
  // expiry: after the duration nothing is attracted any more
  stage(sim, 'a', { x: 5, y: 45 }, 'right', 7);
  tickN(sim, POWERUPS.magnet.durationTicks);
  assert.equal(a.magnetTicksLeft, 0);
  sim.food.items.set('12,49', { x: 12, y: 49 });
  const head = { x: a.head.x, y: a.head.y };
  tickN(sim, 3);
  assert.ok(sim.food.has(12, 49), 'no attraction after the magnet expired');
  void head;
});

test('magnet never attracts power-up items, only ordinary food', () => {
  const sim = arena();
  const a = sim.byId.get('a');
  sim.specials.items.set('25,33', { x: 25, y: 33, type: 'speed', born: 0 });
  collectSpecial(a, 'magnet');
  tickN(sim, 3);
  assert.ok(sim.specials.has(25, 33), 'the item stayed where it was');
});

// ==================================================================================================
// SHIELD
// ==================================================================================================

function shieldedAtWall() {
  const sim = arena();
  const a = stage(sim, 'a', { x: CONFIG.GRID_COLS - 1, y: 30 }, 'right', 7); // next step leaves the board
  collectSpecial(a, 'shield');
  return { sim, a };
}

test('shield: absorbs a wall hit - the snake survives in place, the shield is consumed, an event is emitted', () => {
  const { sim, a } = shieldedAtWall();
  const before = headOf(a);
  sim.tick();
  assert.equal(a.alive, true);
  assert.equal(headOf(a), before, 'held in place instead of leaving the board');
  assert.equal(a.shieldTicksLeft, 0, 'consumed');
  assert.equal(sim.events.filter((e) => e.e === 'shield' && e.id === 'a').length, 1);
});

test('shield: ONE hit only - after the short recovery window the next collision is fatal', () => {
  const { sim, a } = shieldedAtWall();
  sim.tick(); // absorbed (consumed)
  sim.tick(); // recovery window: still held, nothing consumed
  assert.equal(a.alive, true);
  assert.equal(sim.events.filter((e) => e.e === 'shield').length, 0, 'no second "consumed" event in the recovery window');
  sim.tick(); // window over, no shield: dies
  assert.equal(a.alive, false);
  assert.ok(POWERUPS.shield.graceTicks === 2);
});

test('shield: the recovery window lets the player steer away and carry on', () => {
  const { sim, a } = shieldedAtWall();
  sim.tick();
  assert.equal(sim.applyInput('a', 1, { dir: 'up' }), true);
  sim.tick();
  assert.equal(a.alive, true);
  assert.equal(a.head.y, 29, 'turned up and moved away from the wall');
  tickN(sim, 5);
  assert.equal(a.alive, true);
});

test('shield: without one, the very same collision kills (control)', () => {
  const sim = arena();
  const a = stage(sim, 'a', { x: CONFIG.GRID_COLS - 1, y: 30 }, 'right', 7);
  sim.tick();
  assert.equal(a.alive, false);
});

test('shield: absorbs hitting your own body', () => {
  const sim = arena();
  const a = sim.byId.get('a');
  a.body = [{ x: 30, y: 30 }, { x: 30, y: 31 }, { x: 31, y: 31 }, { x: 31, y: 30 }, { x: 31, y: 29 }, { x: 31, y: 28 }];
  a.direction = a.pendingDirection = CONFIG.DIRECTIONS.right; // next cell 31,30 is its own body
  collectSpecial(a, 'shield');
  sim.tick();
  assert.equal(a.alive, true);
  assert.equal(a.shieldTicksLeft, 0);
  assert.equal(headOf(a), '30,30');
});

test('shield: absorbs running into a bigger snake (the mover is held back)', () => {
  const sim = arena();
  const a = stage(sim, 'a', { x: 20, y: 30 }, 'right', 7);
  const b = sim.byId.get('b');
  b.body = Array.from({ length: 12 }, (_, i) => ({ x: 21, y: 25 + i })); // a wall of body across a's path, bigger than a
  collectSpecial(a, 'shield');
  sim.tick();
  assert.equal(a.alive, true);
  assert.equal(headOf(a), '20,30');
  assert.equal(a.shieldTicksLeft, 0);
});

test('shield: absorbs being eaten by a bigger snake - the attacker is held back, nobody dies, no kill is credited', () => {
  const sim = arena();
  const big = stage(sim, 'a', { x: 20, y: 30 }, 'right', 9);
  const b = sim.byId.get('b');
  b.body = Array.from({ length: 7 }, (_, i) => ({ x: 21, y: 28 + i })); // crosses a's path, smaller
  collectSpecial(b, 'shield');
  const kills0 = big.eliminations;
  sim.tick();
  assert.equal(b.alive, true, 'the shielded snake was not eaten');
  assert.equal(big.alive, true);
  assert.equal(big.eliminations, kills0, 'no kill credited');
  assert.equal(headOf(big), '20,30', 'the attacker did not pass through');
  assert.equal(b.shieldTicksLeft, 0);
});

test('shield: absorbs losing a head-to-head; the winner takes the cell and gets no kill', () => {
  const sim = arena();
  sim.setFrozen('b', false);
  const a = stage(sim, 'a', { x: 20, y: 30 }, 'right', 9);
  const b = stage(sim, 'b', { x: 22, y: 30 }, 'left', 7); // both step into 21,30; a is bigger
  collectSpecial(b, 'shield');
  sim.tick();
  assert.equal(b.alive, true);
  assert.equal(headOf(b), '22,30', 'the loser was held back');
  assert.equal(headOf(a), '21,30', 'the winner moved into the cell');
  assert.equal(a.eliminations, 0);
});

test('shield: a fatal Boost step is absorbed too (one hit total for the whole tick)', () => {
  const sim = arena();
  const a = stage(sim, 'a', { x: CONFIG.GRID_COLS - 1, y: 30 }, 'right', 7);
  a.activateBoost(CONFIG.BOOST_DURATION_TICKS);
  collectSpecial(a, 'shield');
  sim.tick();
  assert.equal(a.alive, true, 'boost step and normal step both hit the wall, one shield covers the tick');
  assert.equal(sim.events.filter((e) => e.e === 'shield').length, 1);
});

test('shield: it expires after its duration if unused, then collisions are normal again', () => {
  const sim = arena();
  const a = stage(sim, 'a', { x: 5, y: 45 }, 'right', 7);
  collectSpecial(a, 'shield');
  tickN(sim, POWERUPS.shield.durationTicks);
  assert.equal(a.shieldTicksLeft, 0);
  a.body = Array.from({ length: 7 }, (_, i) => ({ x: CONFIG.GRID_COLS - 1 - i, y: 45 }));
  sim.tick();
  assert.equal(a.alive, false);
});

test('shield: re-picking it while active refreshes the same single hit (no stacked protection)', () => {
  const { sim, a } = shieldedAtWall();
  collectSpecial(a, 'shield');
  collectSpecial(a, 'shield');
  sim.tick(); // absorbed
  tickN(sim, 2); // recovery window
  sim.tick();
  assert.equal(a.alive, false, 'only ever one absorbed hit');
});

test('absorbLethal: the state machine is consumed -> grace -> nothing', () => {
  const s = {};
  initEffects(s);
  assert.equal(absorbLethal(s), false);
  s.shieldTicksLeft = 5;
  assert.equal(absorbLethal(s), 'consumed');
  assert.equal(s.shieldTicksLeft, 0);
  assert.equal(absorbLethal(s), 'grace');
  s.shieldGraceLeft = 0;
  assert.equal(absorbLethal(s), false);
  clearEffects(s);
  assert.equal(s.speedTicksLeft + s.magnetTicksLeft + s.shieldTicksLeft + s.shieldGraceLeft, 0);
});

// ==================================================================================================
// MEGA FOOD
// ==================================================================================================

test('mega food: score and growth are the configured values; it is not counted as normal food', () => {
  const sim = arena();
  const a = stage(sim, 'a', { x: 20, y: 30 }, 'right', 7);
  sim.specials.items.set('21,30', { x: 21, y: 30, type: 'mega', born: 0 });
  const len0 = a.length;
  sim.tick();
  assert.equal(a.score, POWERUPS.mega.score);
  assert.equal(a.megaCollected, 1);
  assert.equal(a.foodEaten, 0, 'normal-food counter untouched');
  assert.equal(a.powerupsCollected, 0, 'mega is its own statistic');
  assert.equal(sim.specials.count, 0, 'the item is gone');
  tickN(sim, POWERUPS.mega.grow + 1);
  assert.equal(a.length, len0 + POWERUPS.mega.grow);
  assert.equal(sim.events.length >= 0, true);
});

test('mega food: emits exactly one pickup event, and two snakes cannot both collect the same item', () => {
  const sim = arena();
  sim.setFrozen('b', false);
  const a = stage(sim, 'a', { x: 20, y: 30 }, 'right', 7);
  const b = stage(sim, 'b', { x: 22, y: 30 }, 'left', 7);
  sim.specials.items.set('21,30', { x: 21, y: 30, type: 'mega', born: 0 });
  sim.tick();
  const pickups = sim.events.filter((e) => e.e === 'pu');
  assert.equal(pickups.length, 1, 'one item, one pickup event');
  assert.equal(a.megaCollected + b.megaCollected, 1);
  assert.equal(a.score + b.score, POWERUPS.mega.score, 'paid exactly once');
});

test('mega food XP: modest, capped, once-only through the result; food XP is not inflated by mega score', () => {
  const x = REWARDS.single;
  const r = computeMatchRewards({ mode: 'single', score: 50, food: 0, mega: 1, powerups: 0, kills: 0, playSeconds: 30 }, 0);
  assert.equal(r.items.find((i) => i.id === 'mega').xp, x.megaEach);
  assert.equal(megaXP('single', 1000), x.megaCap, 'capped');
  assert.equal(powerupXP('multiplayer', 1000), REWARDS.multiplayer.powerupCap);
  assert.ok(x.megaEach < x.victory / 2 && x.powerupEach <= x.megaEach, 'modest');
  assert.equal(foodFromMultiplayerScore(50, 0, 1), 0, 'a mega pickup is not "food eaten"');
  assert.equal(foodFromMultiplayerScore(80, 0, 1), 3);
  const p = new Profile({ storage: { getItem: () => null, setItem() {} }, now: () => 1, schedule: () => 1, cancel: () => {} });
  const over = { winnerId: 'p1', results: [{ id: 'p1', rank: 1, score: 130, length: 12, kills: 0, mega: 2, powerups: 3, survived: true }, { id: 'p2', rank: 2, score: 0, length: 5, kills: 0, mega: 0, powerups: 0, survived: false }] };
  const first = p.applyMatchResult(fromMultiplayer(over, 'p1', 'k1', 60));
  assert.ok(first);
  assert.equal(first.rewards.items.find((i) => i.id === 'mega').count, 2);
  assert.equal(first.rewards.items.find((i) => i.id === 'powerups').count, 3);
  const xp = p.xp;
  assert.equal(p.applyMatchResult(fromMultiplayer(over, 'p1', 'k1', 60)), null, 'a repeated result pays nothing');
  assert.equal(p.xp, xp);
  assert.equal(p.stats.megaFoodCollected, 2);
  assert.equal(p.stats.powerupsCollected, 3);
  assert.equal(fromSinglePlayer({ victory: false, score: 1, length: 1, eliminations: 0, foodEaten: 0, powerups: 4, mega: 1, ticks: 100 }, 'k').powerups, 4);
});

// ==================================================================================================
// EFFECTS LIFECYCLE
// ==================================================================================================

test('effects are per snake, reset with a new match, and the snapshot only carries active timers', () => {
  const sim = arena();
  const a = sim.byId.get('a');
  assert.equal(sim.snapshot({ full: true }).snakes.find((s) => s.id === 'a').e, undefined, 'nothing active: no field');
  collectSpecial(a, 'speed');
  collectSpecial(a, 'shield');
  const e = sim.snapshot({ full: true }).snakes.find((s) => s.id === 'a').e;
  assert.deepEqual(e, [POWERUPS.speed.durationTicks, 0, POWERUPS.shield.durationTicks]);
  assert.equal(sim.snapshot({ full: true }).snakes.find((s) => s.id === 'b').e, undefined, 'other snakes are unaffected');
  const fresh = new MatchSim(ENTRIES);
  for (const s of fresh.snakes) assert.equal(s.speedTicksLeft + s.magnetTicksLeft + s.shieldTicksLeft + s.powerupsCollected + s.megaCollected, 0);
});

test('a dead snake keeps no effects in the snapshot and the results carry the pickup counters', () => {
  const sim = arena();
  const a = sim.byId.get('a');
  collectSpecial(a, 'magnet');
  a.powerupsCollected = 2;
  a.megaCollected = 1;
  sim.forfeit('a');
  const snap = sim.snapshot({ full: true }).snakes.find((s) => s.id === 'a');
  assert.equal(snap.e, undefined);
  const row = sim.results().find((r) => r.id === 'a');
  assert.equal(row.powerups, 2);
  assert.equal(row.mega, 1);
});
