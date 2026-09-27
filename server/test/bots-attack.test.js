import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, cellKey } from '../../js/config.js';
import { Snake } from '../../js/snake.js';
import { decideAIDirection } from '../../js/ai.js';
import { buildOccupancyMap } from '../../js/collision.js';
import { FoodManager } from '../../js/food.js';
import { PowerUpManager } from '../../js/powerups/manager.js';
import { decideBotDirection } from '../bots/controller.js';
import { difficultyConfig } from '../bots/config.js';

// Bot attack behaviour (server/bots/controller.js): bots must actively hunt a clearly smaller snake
// instead of fleeing every time some bigger snake merely exists in view (the "too passive" bug), while
// immediate danger from a larger snake still overrides everything else. All tests call the real
// decideBotDirection() used by MatchSim.tick() - nothing here mocks the attack logic itself.
const DIR = CONFIG.DIRECTIONS;
const SKIN = { ui: '#fff' };
const name = (d) => Object.entries(DIR).find(([, v]) => v.x === d.x && v.y === d.y)[0];
const realRandom = Math.random;
const withRandom = (value, fn) => { Math.random = () => value; try { return fn(); } finally { Math.random = realRandom; } };

let nextId = 1;
function botSnake(head, dirName, profile, length = 7) {
  const d = DIR[dirName];
  const s = new Snake({ isPlayer: false, cells: Array.from({ length }, (_, i) => ({ x: head.x - d.x * i, y: head.y - d.y * i })), direction: d, skin: SKIN, profile });
  s.playerId = `s${nextId++}`;
  s.isBot = true;
  return s;
}

function world(snakes, { food = [], terrain = new Set() } = {}) {
  const foodManager = new FoodManager(CONFIG.GRID_COLS, CONFIG.GRID_ROWS);
  foodManager.items.clear();
  for (const [x, y] of food) foodManager.items.set(cellKey(x, y), { x, y });
  const specials = new PowerUpManager({ rng: () => 0.99 }); // never interested: keeps power-ups out of the way
  const occupancyMap = buildOccupancyMap(snakes);
  for (const k of terrain) occupancyMap.set(k, { isObstacle: true });
  return { snakes, foodManager, occupancyMap, specials, matchTicks: 300, terrain };
}

const NORMAL = difficultyConfig('normal');
const noMistakes = (overrides = {}) => ({ ...NORMAL, mistakeChance: 0, hunt: { ...NORMAL.hunt, ...overrides } });

test('hunter chooses a smaller nearby snake over ordinary food', () => {
  const hunter = botSnake({ x: 30, y: 30 }, 'right', 'hunter', 10);
  const prey = botSnake({ x: 33, y: 30 }, 'right', 'forager', 3); // straight ahead, clearly smaller
  const w = world([hunter, prey], { food: [[30, 20]] }); // food is straight up - a real, different pull
  const dir = decideBotDirection(hunter, w, noMistakes());
  assert.equal(name(dir), 'right', 'goes for the kill instead of turning off toward food');
});

test('forager attacks a favorable smaller target when appropriate', () => {
  const forager = botSnake({ x: 30, y: 30 }, 'right', 'forager', 9);
  const prey = botSnake({ x: 33, y: 30 }, 'right', 'hunter', 3); // ratio 3: comfortably past forager's bar
  const w = world([forager, prey]);
  const dir = decideBotDirection(forager, w, noMistakes());
  assert.equal(name(dir), 'right', 'a clearly safe, nearby opportunity is taken even by a forager');
});

test('cautious bot refuses a risky attack (a bigger snake is moderately close)', () => {
  const prey = () => botSnake({ x: 38, y: 30 }, 'right', 'forager', 6); // ratio 1.67: past every profile's bar
  const bigger = () => botSnake({ x: 37, y: 30 }, 'down', 'hunter', 15); // body extends away from the action; not closing in

  for (const profile of ['hunter', 'forager']) {
    const bot = botSnake({ x: 30, y: 30 }, 'right', profile, 10);
    const dir = decideBotDirection(bot, world([bot, prey(), bigger()]), noMistakes());
    assert.equal(name(dir), 'right', `${profile} presses the attack despite the distant bigger snake`);
  }

  const cautious = botSnake({ x: 30, y: 30 }, 'right', 'cautious', 10);
  const dir = decideBotDirection(cautious, world([cautious, prey(), bigger()]), noMistakes());
  assert.notEqual(name(dir), 'right', 'cautious backs off the same attack because the bigger snake is within its wider safety margin');
});

test('bot aborts an attack when a larger snake becomes an immediate threat', () => {
  const hunter = botSnake({ x: 30, y: 30 }, 'right', 'hunter', 10);
  const prey = botSnake({ x: 33, y: 30 }, 'right', 'forager', 3);
  const first = decideBotDirection(hunter, world([hunter, prey]), noMistakes());
  assert.equal(name(first), 'right', 'commits to the chase when nothing threatens it');

  // The same hunter, same tick's worth of state, but now a bigger snake has closed to point-blank range.
  const attacker = botSnake({ x: 32, y: 30 }, 'left', 'hunter', 20);
  const second = decideBotDirection(hunter, world([hunter, prey, attacker]), noMistakes());
  assert.notEqual(name(second), 'right', 'immediate danger overrides the chase - it does not walk toward the threat to reach its target');
});

test('bot does not attack an equal or larger snake', () => {
  const hunter = botSnake({ x: 30, y: 30 }, 'right', 'hunter', 8);
  const equal = botSnake({ x: 33, y: 30 }, 'right', 'forager', 8); // same length: never "clearly smaller"
  const bigger = botSnake({ x: 30, y: 36 }, 'down', 'forager', 12); // farther down, actually bigger, out of immediate-danger range
  const w = world([hunter, equal, bigger], { food: [[30, 24]] }); // food straight up - the only real pull left
  const dir = decideBotDirection(hunter, w, noMistakes());
  assert.equal(name(dir), 'up', 'ignores both the equal-size and the bigger snake, and forages instead');
});

test('bot predicts and intercepts a moving smaller target instead of chasing its current position', () => {
  const setup = (leadTicks) => {
    const hunter = botSnake({ x: 30, y: 30 }, 'right', 'hunter', 10);
    const prey = botSnake({ x: 36, y: 30 }, 'up', 'forager', 3); // dead ahead, but moving away vertically
    return decideBotDirection(hunter, world([hunter, prey]), noMistakes({ leadTicks }));
  };
  const noLead = setup(0); // "chase current position": prey is dead ahead, so straight on is clearly best
  assert.equal(name(noLead), 'right', 'with no lead, it just closes the gap along the row it shares with the prey');

  const withLead = setup(8); // aims at roughly where the prey will BE, well off that row by then
  assert.notEqual(name(withLead), name(noLead), 'prediction changes the choice - it is not just following the current head');
});

test('an obstacle-aware attack never routes through a wall', () => {
  const hunter = botSnake({ x: 30, y: 30 }, 'right', 'hunter', 10);
  const prey = botSnake({ x: 33, y: 30 }, 'right', 'forager', 3); // straight ahead - "right" would normally win
  const terrain = new Set([cellKey(31, 30)]); // but that cell is a wall
  const dir = decideBotDirection(hunter, world([hunter, prey], { terrain }), noMistakes());
  assert.notEqual(name(dir), 'right', 'does not walk into the obstacle just because it is the straight line to the target');
  assert.equal(terrain.has(cellKey(30 + dir.x, 30 + dir.y)), false, 'the chosen cell is never the wall itself');
});

test('existing survival behaviour still works: a real, close, bigger snake is still avoided', () => {
  const bot = botSnake({ x: 30, y: 30 }, 'right', 'forager', 6);
  const attacker = botSnake({ x: 32, y: 30 }, 'left', 'hunter', 12); // 2 cells ahead, closing in, much bigger
  const dir = decideBotDirection(bot, world([bot, attacker]), noMistakes());
  assert.notEqual(name(dir), 'right', 'does not carry on toward a real, closing threat');
});

test('with nothing to attack, a bot behaves exactly like plain decideAIDirection (forage/idle unchanged)', () => {
  const bot = () => botSnake({ x: 30, y: 30 }, 'right', 'forager', 7);
  const w = () => world([bot()], { food: [[30, 24]] });
  const plain = withRandom(0.3, () => decideAIDirection(bot(), w()));
  const bots = withRandom(0.3, () => decideBotDirection(bot(), w(), noMistakes()));
  assert.equal(name(bots), name(plain), 'no attack opportunity exists, so the bot layer defers entirely to the existing AI');
});
