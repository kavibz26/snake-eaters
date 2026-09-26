import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../js/config.js';

// Single-player AI and power-ups: AI may head for a nearby item, sometimes ignores one, never chases an
// impossible cell, puts survival first, and follows exactly the same pickup / effect rules as the player.
globalThis.window ??= { devicePixelRatio: 1 };
const { Game } = await import('../../js/game.js');
const { Snake } = await import('../../js/snake.js');
const { decideAIDirection } = await import('../../js/ai.js');
const { buildOccupancyMap } = await import('../../js/collision.js');
const { FoodManager } = await import('../../js/food.js');
const { PowerUpManager } = await import('../../js/powerups/manager.js');
const { POWERUPS } = await import('../../js/powerups/config.js');
const { collectSpecial } = await import('../../js/powerups/effects.js');

const DIR = CONFIG.DIRECTIONS;
const SKIN = { ui: '#fff' };
const realRandom = Math.random;
const withRandom = (value, fn) => { Math.random = () => value; try { return fn(); } finally { Math.random = realRandom; } };
const name = (d) => Object.entries(DIR).find(([, v]) => v.x === d.x && v.y === d.y)[0];

function aiSnake(head, dirName, profile = 'forager', length = 7) {
  const d = DIR[dirName];
  return new Snake({ isPlayer: false, cells: Array.from({ length }, (_, i) => ({ x: head.x - d.x * i, y: head.y - d.y * i })), direction: d, skin: SKIN, profile });
}
function world(snakes, items = []) {
  const specials = new PowerUpManager({ rng: () => 0.99 });
  for (const [x, y, type = 'speed'] of items) specials.items.set(`${x},${y}`, { x, y, type, born: 1 });
  const food = new FoodManager(CONFIG.GRID_COLS, CONFIG.GRID_ROWS);
  food.items.clear();
  return { snakes, foodManager: food, occupancyMap: buildOccupancyMap(snakes), specials, matchTicks: 0, playerPressure: { count: 0, cap: 1 } };
}

test('AI can target an available power-up: an interested AI turns toward a nearby item', () => {
  for (const profile of ['forager', 'hunter', 'cautious']) {
    const ai = aiSnake({ x: 20, y: 30 }, 'up', profile);
    const dir = withRandom(0, () => decideAIDirection(ai, world([ai], [[26, 30]])));
    assert.equal(name(dir), 'right', `${profile} heads for an item 6 cells to its right`);
    const ai2 = aiSnake({ x: 20, y: 30 }, 'up', profile);
    const left = withRandom(0, () => decideAIDirection(ai2, world([ai2], [[14, 30]])));
    assert.equal(name(left), 'left', `${profile} heads for an item on its left`);
  }
});

test('AI can ignore an item, and an ignored item is not re-rolled every tick', () => {
  const ai = aiSnake({ x: 20, y: 30 }, 'up');
  const w = world([ai], [[26, 30]]);
  const first = withRandom(0.99, () => decideAIDirection(ai, w)); // roll fails: not interested
  assert.equal(name(first), 'up', 'carried straight on');
  for (let i = 0; i < 5; i++) {
    const again = withRandom(0, () => decideAIDirection(ai, w)); // a lucky roll now must not matter: it was judged once
    assert.equal(name(again), 'up');
  }
});

test('AI interest is probabilistic and per profile: it sometimes ignores, never always chases, never becomes perfect', () => {
  const N = 1500;
  // Ties between open directions are broken by the AI's own jitter, so "turned toward the item" also happens by
  // chance without any interest. Measure that baseline (no item) and back the real interest out of it.
  const turnRate = (profile, withItem) => {
    let right = 0;
    for (let i = 0; i < N; i++) {
      const ai = aiSnake({ x: 20, y: 30 }, 'up', profile);
      if (name(decideAIDirection(ai, world([ai], withItem ? [[26, 30]] : []))) === 'right') right++;
    }
    return right / N;
  };
  const interestOf = (profile) => {
    const base = turnRate(profile, false);
    return (turnRate(profile, true) - base) / (1 - base);
  };
  const forager = interestOf('forager');
  const hunter = interestOf('hunter');
  assert.ok(Math.abs(forager - POWERUPS.ai.interest.forager) < 0.12, `forager interest ~${forager.toFixed(2)} (configured ${POWERUPS.ai.interest.forager})`);
  assert.ok(Math.abs(hunter - POWERUPS.ai.interest.hunter) < 0.12, `hunter interest ~${hunter.toFixed(2)} (configured ${POWERUPS.ai.interest.hunter})`);
  assert.ok(forager < 0.9, 'never a perfect item-grabber: it ignores some items');
  assert.ok(forager > hunter, 'profiles differ (tunable in POWERUPS.ai.interest)');
});

test('AI does not target impossible or unreachable cells', () => {
  // an item completely walled in by another snake's body
  const wall = aiSnake({ x: 0, y: 0 }, 'right', 'forager', 1);
  const ring = [[25, 29], [27, 29], [26, 28], [26, 30]];
  wall.body = ring.map(([x, y]) => ({ x, y }));
  const ai = aiSnake({ x: 20, y: 30 }, 'up');
  const enclosed = withRandom(0, () => decideAIDirection(ai, world([ai, wall], [[26, 29]])));
  assert.equal(name(enclosed), 'up', 'an enclosed item is not chased');
  // an item lying on a snake's body
  const ai2 = aiSnake({ x: 20, y: 30 }, 'up');
  const other = aiSnake({ x: 28, y: 30 }, 'right', 'forager', 9);
  const onBody = withRandom(0, () => decideAIDirection(ai2, world([ai2, other], [[24, 30]])));
  assert.equal(name(onBody), 'up', 'an item on top of a snake is not chased');
  // out of the AI's view
  const ai3 = aiSnake({ x: 20, y: 30 }, 'up');
  const far = withRandom(0, () => decideAIDirection(ai3, world([ai3], [[20 + POWERUPS.ai.viewRange + 2, 30]])));
  assert.equal(name(far), 'up', 'items beyond the view range are ignored');
  // off the board entirely
  const ai4 = aiSnake({ x: 20, y: 30 }, 'up');
  const off = withRandom(0, () => decideAIDirection(ai4, world([ai4], [[-3, 30], [200, 4]])));
  assert.equal(name(off), 'up');
});

test('survival comes first: with a bigger snake in view the AI ignores items', () => {
  const ai = aiSnake({ x: 20, y: 30 }, 'up', 'forager', 6);
  const big = aiSnake({ x: 24, y: 30 }, 'left', 'hunter', 14); // bigger, close, coming at us
  const w = world([ai, big], [[14, 30]]);
  const dir = withRandom(0, () => decideAIDirection(ai, w));
  assert.notEqual(name(dir), 'left', 'not walking toward the item past a hunter');
  assert.equal(ai.constructor, Snake);
});

test('AI decisions stay cheap: items add a one-time check per item, not work every tick', () => {
  class CountingMap extends Map {
    constructor(...a) { super(...a); this.lookups = 0; }
    has(k) { this.lookups++; return super.has(k); }
  }
  const cost = (items, decisions) => {
    const ai = aiSnake({ x: 40, y: 30 }, 'up');
    const w = world([ai], items);
    const occ = new CountingMap(w.occupancyMap);
    w.occupancyMap = occ;
    for (let i = 0; i < decisions; i++) decideAIDirection(ai, w);
    return occ.lookups;
  };
  const items = [[44, 30], [36, 28], [40, 40]];
  const perTickBaseline = cost([], 1);
  const many = cost(items, 200);
  const baseline = cost([], 200);
  // Deterministic accounting (no wall-clock): after the first look at each item the verdict is remembered.
  assert.ok(many - baseline <= 3 * 60 + 200 * 3, `extra occupancy lookups over 200 decisions: ${many - baseline} (baseline ${perTickBaseline}/decision)`);
  assert.ok((cost(items, 400) - cost([], 400)) - (many - baseline) < 400, 'doubling the ticks does not double the extra cost');
});

// ---- the normal game rules apply to AI --------------------------------------------------------------------

function makeGame() {
  const canvas = { width: 0, height: 0, getContext: () => ({ scale() {} }) };
  const game = new Game(canvas, { update() {} });
  game.init();
  const player = game.playerSnake;
  const ai = game.snakes.find((s) => !s.isPlayer);
  game.snakes = [player, ai];
  player.body = Array.from({ length: 7 }, (_, i) => ({ x: 70 - i, y: 50 }));
  player.direction = player.pendingDirection = DIR.right;
  ai.body = Array.from({ length: 7 }, (_, i) => ({ x: 20 - i, y: 30 }));
  ai.direction = ai.pendingDirection = DIR.right;
  ai.profile = 'forager';
  game.food.items.clear();
  game.food.target = 0;
  game.specials.clear();
  game.specials.cooldown = 1e9;
  const events = [];
  game.onPlayerEvent = (k) => events.push(k);
  return { game, player, ai, events };
}

test('an AI that reaches a power-up gets the normal effect, exactly once, and the item is gone', () => {
  for (const type of ['speed', 'magnet', 'shield']) {
    const { game, player, ai, events } = makeGame();
    game.specials.items.set('21,30', { x: 21, y: 30, type, born: 1 });
    withRandom(0, () => game.tick());
    assert.equal(game.specials.count, 0, `${type}: item removed`);
    assert.equal(ai.powerupsCollected, 1);
    const timer = { speed: ai.speedTicksLeft, magnet: ai.magnetTicksLeft, shield: ai.shieldTicksLeft }[type];
    assert.ok(timer > 0 && timer <= POWERUPS[type].durationTicks, `${type}: the normal timer is running (${timer})`);
    assert.equal(player.powerupsCollected, 0, 'the player got nothing');
    assert.deepEqual(events, [], 'XP feedback is for the player only');
  }
});

test('an AI that eats Mega Food gets the same score and growth as the player would', () => {
  const { game, ai } = makeGame();
  game.specials.items.set('21,30', { x: 21, y: 30, type: 'mega', born: 1 });
  const len = ai.length;
  withRandom(0, () => game.tick());
  assert.equal(ai.score, POWERUPS.mega.score);
  assert.equal(ai.megaCollected, 1);
  assert.equal(ai.foodEaten, 0);
  for (let i = 0; i < POWERUPS.mega.grow + 1; i++) withRandom(0, () => game.tick());
  assert.ok(ai.length >= len + POWERUPS.mega.grow);
});

test('a Speed power-up gives an AI the same extra step (1.5 cells/tick) as the player, and it expires', () => {
  const { game, ai } = makeGame();
  collectSpecial(ai, 'speed');
  let moves = 0;
  const commit = ai.commitMove.bind(ai);
  ai.commitMove = (h) => { moves++; commit(h); };
  for (let i = 0; i < 10; i++) withRandom(0.5, () => game.tick());
  assert.equal(moves, 15, '10 ticks: 10 normal + 5 extra steps');
  for (let i = 0; i < POWERUPS.speed.durationTicks; i++) withRandom(0.5, () => game.tick());
  assert.equal(ai.speedTicksLeft, 0);
});

test('an AI Magnet pulls food with the normal rule, and an AI shield absorbs one hit like the player\'s', () => {
  const { game, ai } = makeGame();
  collectSpecial(ai, 'magnet');
  game.food.items.set('25,33', { x: 25, y: 33 });
  const score0 = ai.score;
  for (let i = 0; i < 8; i++) withRandom(0.5, () => game.tick());
  assert.equal(ai.score, score0 + CONFIG.FOOD_SCORE, 'the food was pulled in and eaten');
  const b = makeGame();
  collectSpecial(b.ai, 'shield');
  assert.equal(b.game._absorb(b.ai), true, 'the shield absorbs the first lethal hit');
  assert.equal(b.ai.shieldTicksLeft, 0);
  assert.equal(b.game._absorb(b.ai), true, 'recovery window');
  b.ai.shieldGraceLeft = 0;
  assert.equal(b.game._absorb(b.ai), false, 'then nothing: same one-hit rule');
});

test('no duplicate pickup: an item reached by the player and an AI in the same tick is collected once', () => {
  const { game, player, ai } = makeGame();
  player.body = Array.from({ length: 7 }, (_, i) => ({ x: 24 + i, y: 30 })); // head 24,30 heading left
  player.direction = player.pendingDirection = DIR.left;
  ai.body = Array.from({ length: 7 }, (_, i) => ({ x: 21 - i, y: 30 })); // head 21,30 heading right
  ai.direction = ai.pendingDirection = DIR.right;
  game.specials.items.set('22,30', { x: 22, y: 30, type: 'mega', born: 1 });
  player.pendingDirection = DIR.left;
  withRandom(0, () => game.tick());
  assert.equal(game.specials.count, 0);
  assert.equal(player.megaCollected + ai.megaCollected, 1, 'exactly one collector');
  assert.equal(player.score + ai.score >= POWERUPS.mega.score && player.score + ai.score < 2 * POWERUPS.mega.score, true, 'paid once');
});

test('AI power-up behaviour is configurable in one place', () => {
  const ai = POWERUPS.ai;
  for (const k of ['viewRange', 'interest', 'weight', 'minSpaceAtTarget', 'ignoreWhenThreatened']) assert.ok(k in ai, k);
  const saved = ai.interest.forager;
  ai.interest.forager = 0; // "never interested"
  try {
    const snake = aiSnake({ x: 20, y: 30 }, 'up');
    for (let i = 0; i < 50; i++) assert.equal(name(withRandom(0.0001, () => decideAIDirection(snake, world([snake], [[26, 30]])))), 'up');
  } finally { ai.interest.forager = saved; }
});
