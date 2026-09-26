import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../js/config.js';

// Single-player Game with a stub canvas/HUD, driven tick by tick (no rAF loop, no rendering).
globalThis.window ??= { devicePixelRatio: 1 };
const { Game } = await import('../../js/game.js');
const { Snake } = await import('../../js/snake.js');
const { POWERUPS } = await import('../../js/powerups/config.js');
const { collectSpecial } = await import('../../js/powerups/effects.js');

function makeGame() {
  const canvas = { width: 0, height: 0, getContext: () => ({ scale() {} }) };
  const hudCalls = [];
  const hud = { update: (u) => hudCalls.push(u) };
  const game = new Game(canvas, hud);
  game.init();
  const player = game.playerSnake;
  // A quiet world: the player alone in the open, one huge AI far away that just sits at the edge.
  const ai = game.snakes.find((s) => !s.isPlayer);
  game.snakes = [player, ai];
  ai.body = Array.from({ length: 30 }, (_, i) => ({ x: 70 + (i % 10), y: 3 + Math.floor(i / 10) }));
  ai.direction = ai.pendingDirection = CONFIG.DIRECTIONS.right;
  game.food.items.clear();
  game.food.target = 0;
  game.specials.clear();
  game.specials.cooldown = 1e9;
  const put = (head, dirName, length = 7) => {
    const dir = CONFIG.DIRECTIONS[dirName];
    player.body = Array.from({ length }, (_, i) => ({ x: head.x - dir.x * i, y: head.y - dir.y * i }));
    player.direction = player.pendingDirection = dir;
    player.inputBuffer = [];
    player.growPending = 0;
  };
  put({ x: 20, y: 30 }, 'right');
  const tick = (n = 1) => { for (let i = 0; i < n && game.state === 'playing'; i++) game.tick(); };
  return { game, player, ai, put, tick, hudCalls };
}

test('single player: spawner + pickup - a Mega Food on the path gives score, growth, a counter and a feedback event', () => {
  const { game, player, tick } = makeGame();
  const events = [];
  game.onPlayerEvent = (k) => events.push(k);
  game.specials.items.set('21,30', { x: 21, y: 30, type: 'mega', born: 0 });
  const len = player.length;
  tick(1);
  assert.equal(player.score, POWERUPS.mega.score);
  assert.equal(player.megaCollected, 1);
  assert.equal(player.foodEaten, 0);
  assert.deepEqual(events, ['mega']);
  tick(POWERUPS.mega.grow + 1);
  assert.equal(player.length, len + POWERUPS.mega.grow);
});

test('single player: every effect activates on pickup, shows in the HUD payload, and expires on time', () => {
  const { game, player, tick, put, hudCalls } = makeGame();
  const kinds = [];
  game.onPlayerEvent = (k) => kinds.push(k);
  for (const type of ['speed', 'magnet', 'shield']) {
    put({ x: 5, y: 30 }, 'right');
    game.specials.items.set('6,30', { x: 6, y: 30, type, born: 0 });
    tick(1);
  }
  assert.deepEqual(kinds, ['powerup', 'powerup', 'powerup']);
  assert.equal(player.powerupsCollected, 3);
  assert.ok(player.speedTicksLeft > 0 && player.magnetTicksLeft > 0 && player.shieldTicksLeft > 0);
  const last = hudCalls[hudCalls.length - 1];
  assert.deepEqual(last.effects.map((e) => e.type), ['speed', 'magnet', 'shield'], 'the compact status HUD gets the active effects');
  put({ x: 5, y: 45 }, 'right');
  tick(POWERUPS.shield.durationTicks + 2);
  assert.ok(game.state === 'playing' || game.state === 'gameover');
  assert.equal(player.speedTicksLeft, 0);
  assert.equal(player.magnetTicksLeft, 0);
  assert.equal(player.shieldTicksLeft, 0);
});

test('single player: a shield saves the player from a wall exactly once; the next hit ends the run', () => {
  const { game, player, put, tick } = makeGame();
  put({ x: CONFIG.GRID_COLS - 1, y: 30 }, 'right');
  collectSpecial(player, 'shield');
  tick(1);
  assert.equal(game.state, 'playing', 'the run continues');
  assert.equal(player.alive, true);
  assert.equal(player.head.x, CONFIG.GRID_COLS - 1);
  assert.equal(player.shieldTicksLeft, 0);
  tick(3); // recovery window (2 ticks), then the wall is fatal
  assert.equal(game.state, 'gameover');
  assert.equal(player.alive, false);
});

test('single player: Speed moves 1.5 cells per tick and Speed+Boost is capped at 2', () => {
  const { player, put, tick } = makeGame();
  collectSpecial(player, 'speed');
  const x0 = player.head.x;
  tick(10);
  assert.equal(player.head.x - x0, 15);
  put({ x: 5, y: 40 }, 'right');
  collectSpecial(player, 'speed');
  player.activateBoost(CONFIG.BOOST_DURATION_TICKS);
  let prev = player.head.x;
  for (let i = 0; i < 8; i++) {
    tick(1);
    assert.equal(player.head.x - prev, 2, 'never more than 2 cells in a tick');
    prev = player.head.x;
  }
});

test('single player: game over reports the pickup counters, and a restart clears every effect and item', () => {
  const { game, player, tick, put } = makeGame();
  collectSpecial(player, 'speed');
  collectSpecial(player, 'magnet');
  collectSpecial(player, 'shield');
  game.specials.items.set('30,30', { x: 30, y: 30, type: 'speed', born: 0 });
  player.megaCollected = 2;
  let over = null;
  game.onGameOver = (r) => { over = r; };
  put({ x: CONFIG.GRID_COLS - 1, y: 30 }, 'right');
  player.shieldTicksLeft = 0; // let the wall end this run
  tick(5);
  assert.ok(over, 'game over fired');
  assert.equal(over.powerups, 3);
  assert.equal(over.mega, 2);
  game.init(); // what "Play Again" does
  const p2 = game.playerSnake;
  assert.equal(p2.speedTicksLeft + p2.magnetTicksLeft + p2.shieldTicksLeft + p2.shieldGraceLeft, 0, 'no effect survives a restart');
  assert.equal(p2.powerupsCollected + p2.megaCollected, 0);
  assert.equal(game.specials.count, 0, 'the board starts without special items');
});

test('single player: the spawner runs on the fixed tick and never puts an item on a snake', () => {
  const { game, tick } = makeGame();
  game.specials.cooldown = 0;
  game.specials.rng = () => 0; // always lucky
  tick(60);
  assert.ok(game.specials.count >= 1 && game.specials.count <= POWERUPS.spawn.maxActive);
  for (const item of game.specials.all()) {
    for (const s of game.snakes) for (const c of s.body) assert.ok(!(c.x === item.x && c.y === item.y), 'not inside a snake');
  }
  void Snake;
});
