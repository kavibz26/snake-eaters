// Server-authoritative bot decisions. This is the ONLY place a bot's next direction is chosen, and it
// runs exclusively inside MatchSim.tick() (server/match.js) - never in a browser.
//
// It reuses js/ai.js's own building blocks (findNearestThreat, manhattan, projectPosition) unmodified,
// and its full decideAIDirection() for survival/forage steering, but the top-level PRIORITY is decided
// here rather than by js/ai.js's own decideMode(). That function treats "some bigger snake is anywhere
// in view" as reason enough to flee - tuned for single-player, where there is only ever one lone AI
// opponent to worry about. In a 6-snake multiplayer match that made bots flee almost constantly, since
// some bigger rival is very often somewhere on the board, even nowhere near actually threatening them -
// bots rarely reached "attack" and matches saw few real chases or eliminations.
//
// The fix keeps the same priority ORDER the feature calls for - immediate danger first, then attacking
// a clearly smaller snake, then ordinary foraging - but immediate danger is judged by a tight, explicit
// check (a bigger snake genuinely close, or closing in) instead of js/ai.js's wider ambient one. Outside
// that, bots actively look for a smaller, reachable target, lock onto it for a few ticks (so they
// pursue rather than flicker), and steer toward where it is HEADING (a short prediction/interception),
// never through an obstacle or another snake. Difficulty (server/bots/config.js DIFFICULTIES) still only
// controls how often a bot does something worse than its best move; personality (PROFILE_HUNT) controls
// how bold that best move is - a Hunter presses even a small advantage from close threats, a Cautious
// bot only takes a very safe one and spooks easily. None of this changes speed, collision, or power-up
// rules, which are already identical for every snake in the match.
import { decideAIDirection, findNearestThreat, manhattan, projectPosition } from '../../js/ai.js';
import { CONFIG, cellKey, isOpposite } from '../../js/config.js';
import { inBounds } from '../../js/collision.js';
import { profileHuntConfig } from './config.js';

const ALL_DIRECTIONS = Object.values(CONFIG.DIRECTIONS);

// A chase is abandoned (and re-evaluated from scratch) once the target has wandered this much further
// than the hunt range that first spotted it - a bot should let a target go rather than trail it forever.
const LEASH_RANGE_MULT = 1.6;

// Per-bot hunting memory: which target it has locked onto and for how many more ticks, keyed by the
// bot's own Snake instance (mirrors js/ai.js's own aiMemory pattern - naturally GC'd on restart).
const huntMemory = new WeakMap();
function getHunt(snake) {
  let h = huntMemory.get(snake);
  if (!h) {
    h = { targetId: null, lockTicksLeft: 0 };
    huntMemory.set(snake, h);
  }
  return h;
}

// A plain mistake: any direction that isn't an instant reversal, chosen with no regard for food,
// power-ups, threats or prey. This is what "sometimes ignores food / picks a suboptimal route / makes
// a risky decision" looks like in practice - every decision below stays fully competent, and difficulty
// only decides how often this replaces the final answer.
function mistake(snake) {
  const options = ALL_DIRECTIONS.filter((d) => !isOpposite(d, snake.direction));
  return options[Math.floor(Math.random() * options.length)] || snake.direction;
}

// Highest priority, always: a bigger snake genuinely close, or a bit further away but visibly closing
// in. Deliberately independent of - and tighter than - js/ai.js's own ambient threatViewRange check, so
// a bot does not automatically abandon a good attack just because SOME bigger snake exists in view.
// Exported so tests can recognise exactly when decideBotDirection hands a decision entirely to
// decideAIDirection un-throttled (server/test/bots-movement.test.js), instead of re-approximating it.
export function immediateDanger(snake, snakes, huntCfg) {
  const threat = findNearestThreat(snake, snakes, huntCfg.dangerClosingRange);
  if (!threat) return false;
  return threat.dist <= huntCfg.dangerRange || (threat.closingIn && threat.dist <= huntCfg.dangerClosingRange);
}

// A third snake, bigger than this bot, close enough to punish committing to this chase.
function dangerNearby(snake, target, snakes, abortRange) {
  for (const s of snakes) {
    if (s === snake || s === target || !s.alive) continue;
    if (s.length > snake.length && manhattan(snake.head, s.head) <= abortRange) return true;
  }
  return false;
}

// Rough proxy for "am I still somewhere I could safely commit to a chase from" - counts open cells
// reachable from this bot's own head, capped the same way js/ai.js budgets its own floodfills. Unlike
// js/ai.js's openSpaceScore (always scored from a CANDIDATE cell, never the mover's own), this starts
// from the bot's current head, which is always technically "occupied" by the bot itself in the
// occupancy map - so, unlike that function, the start cell is never treated as blocked here.
function openSpace(head, occupancyMap) {
  const startKey = cellKey(head.x, head.y);
  const visited = new Set([startKey]);
  const queue = [head];
  let explored = 0;
  const budget = CONFIG.AI_FLOODFILL_BUDGET;
  while (queue.length && explored < budget) {
    const cell = queue.shift();
    explored++;
    for (const dir of ALL_DIRECTIONS) {
      const nx = cell.x + dir.x;
      const ny = cell.y + dir.y;
      if (!inBounds(nx, ny)) continue;
      const key = cellKey(nx, ny);
      if (visited.has(key) || occupancyMap.has(key)) continue;
      visited.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  return explored;
}

function isClearlySmaller(snake, other, minAdvantage) {
  return snake.length >= other.length * minAdvantage;
}

// Still worth chasing: alive, clearly smaller, not wandered off the leash, and nothing bigger has
// closed in to make the chase a bad idea (requirement: abort if the situation turns dangerous).
function isValidTarget(snake, target, world, huntCfg, leash) {
  if (!target || !target.alive) return false;
  if (!isClearlySmaller(snake, target, huntCfg.minAdvantage)) return false;
  if (manhattan(snake.head, target.head) > leash) return false;
  if (dangerNearby(snake, target, world.snakes, huntCfg.abortRange)) return false;
  return true;
}

// The best new attack target for this bot, or null. Nearest clearly-smaller snake within range that
// isn't currently dangerous to approach; a Cautious bot additionally insists on open ground around
// itself before it will commit (its "favorable escape route" requirement).
function findHuntTarget(snake, world, huntCfg, range) {
  let best = null;
  let bestDist = Infinity;
  for (const other of world.snakes) {
    if (other === snake || !other.alive) continue;
    if (!isClearlySmaller(snake, other, huntCfg.minAdvantage)) continue;
    const dist = manhattan(snake.head, other.head);
    if (dist > range || dist >= bestDist) continue;
    if (dangerNearby(snake, other, world.snakes, huntCfg.abortRange)) continue;
    best = other;
    bestDist = dist;
  }
  if (best && huntCfg.requireClearEscape) {
    const space = openSpace(snake.head, world.occupancyMap);
    if (space < CONFIG.AI_FLOODFILL_BUDGET * 0.5) return null; // too boxed in to safely commit
  }
  return best;
}

// Steers toward where the target is HEADING (a few ticks of lead), not where it stood - "intercept"
// rather than "follow the tail". Never routes through an obstacle or another snake's body: if every
// legal direction is blocked, returns null so the caller falls back to decideAIDirection's own choice.
// Closing the gap is weighed against a little open-space awareness (the same floodfill js/ai.js itself
// scores every candidate with) so a chase never single-mindedly walks a bot into a dead end just to
// shave one cell off the distance - "an obvious wall/obstacle trap" is a bad attack even when it is
// technically the shortest path.
function interceptDirection(snake, target, occupancyMap, leadTicks) {
  const aim = projectPosition(target, leadTicks);
  const head = snake.head;
  const distNow = manhattan(head, aim);
  const candidates = ALL_DIRECTIONS.filter((d) => !isOpposite(d, snake.direction));
  let best = null;
  let bestScore = -Infinity;
  for (const dir of candidates) {
    const next = { x: head.x + dir.x, y: head.y + dir.y };
    if (!inBounds(next.x, next.y) || occupancyMap.has(cellKey(next.x, next.y))) continue;
    const space = openSpace(next, occupancyMap);
    const score = (distNow - manhattan(next, aim)) * 3 + Math.min(space, CONFIG.AI_FLOODFILL_BUDGET / 2);
    if (score > bestScore) {
      bestScore = score;
      best = dir;
    }
  }
  return best;
}

// Holds an existing chase, or looks for a new one; returns a steering direction, or null when there is
// nothing worth attacking right now (the caller then uses decideAIDirection's own forage/idle choice).
function pursue(snake, world, difficulty, huntCfg) {
  const range = difficulty.hunt.range * huntCfg.rangeMult;
  const hunt = getHunt(snake);

  let target = hunt.targetId ? world.snakes.find((s) => s.playerId === hunt.targetId) : null;
  if (!isValidTarget(snake, target, world, huntCfg, range * LEASH_RANGE_MULT) || hunt.lockTicksLeft <= 0) {
    target = findHuntTarget(snake, world, huntCfg, range);
    hunt.targetId = target ? target.playerId : null;
    hunt.lockTicksLeft = target ? difficulty.hunt.lockTicks : 0;
  }
  if (!target) return null;
  hunt.lockTicksLeft--;

  const dir = interceptDirection(snake, target, world.occupancyMap, difficulty.hunt.leadTicks);
  if (!dir) hunt.lockTicksLeft = 0; // the route is blocked this tick - drop the lock, try fresh next time
  return dir;
}

function finish(snake, difficulty, dir) {
  return Math.random() < difficulty.mistakeChance ? mistake(snake) : dir;
}

// --- movement pipeline: turn-rate bookkeeping ----------------------------------------------------
// js/ai.js's own decideAIDirection() holds a heading for at least AI_MIN_TURN_GAP ticks before
// allowing another turn (its own aiMemory.sinceTurn), unless continuing straight is itself an
// emergency. Hunting (pursue()/interceptDirection above) has no such gap of its own: left alone, it
// can produce a brand-new steering direction on every single tick. That is not a priority problem, but
// a movement one - the Speed power-up's extra pre-step (server/match.js tick(), before bot decisions
// run) moves using whatever direction was already committed BEFORE this tick, so a direction that
// changes on every tick can make that extra step and this tick's normal step point different ways,
// and the net head displacement for the tick looks diagonal even though neither sub-step actually was.
// This tracks the SAME rule, independently of js/ai.js's own counter (which only advances when IT is
// called, so it cannot by itself stay in sync with a hunting-driven turn), so it applies no matter
// which of the branches below produced the final direction.
const turnMemory = new WeakMap();
function getTurnState(snake) {
  let t = turnMemory.get(snake);
  if (!t) {
    t = { sinceTurn: 99 }; // large: a bot's very first-ever decision is never gated (matches js/ai.js)
    turnMemory.set(snake, t);
  }
  return t;
}
function isTurn(snake, dir) {
  return dir.x !== snake.direction.x || dir.y !== snake.direction.y;
}

// Keeps the counter in sync with a direction that was already decided safely elsewhere (immediate
// danger, handed entirely to decideAIDirection's own emergency-aware logic) - recorded, never overridden.
function noteTurn(snake, dir) {
  const state = getTurnState(snake);
  state.sinceTurn = isTurn(snake, dir) ? 0 : state.sinceTurn + 1;
}

// Enforces the gap: a turn is held back (the snake just continues straight) unless it has already held
// its current heading long enough, or continuing straight would itself run into a wall, obstacle or
// body (an emergency turn is always allowed, exactly like js/ai.js's own override).
function throttleTurn(snake, dir, occupancyMap) {
  const state = getTurnState(snake);
  if (!isTurn(snake, dir)) {
    state.sinceTurn++;
    return dir;
  }
  const straightNext = { x: snake.head.x + snake.direction.x, y: snake.head.y + snake.direction.y };
  const emergency = !inBounds(straightNext.x, straightNext.y) || occupancyMap.has(cellKey(straightNext.x, straightNext.y));
  if (!emergency && state.sinceTurn < CONFIG.AI_MIN_TURN_GAP) {
    state.sinceTurn++;
    return snake.direction;
  }
  state.sinceTurn = 0;
  return dir;
}

// snake: a bot's Snake (isBot, profile already set - see MatchSim._spawnSnakes).
// world: the same shape js/game.js already builds for single-player AI (snakes, foodManager,
//   occupancyMap, matchTicks, specials, terrain).
// difficulty: a resolved entry from server/bots/config.js DIFFICULTIES (see difficultyConfig()).
export function decideBotDirection(snake, world, difficulty) {
  const huntCfg = profileHuntConfig(snake.profile);

  if (immediateDanger(snake, world.snakes, huntCfg)) {
    const hunt = getHunt(snake);
    hunt.targetId = null;
    hunt.lockTicksLeft = 0; // real danger: abandon any chase immediately, decideAIDirection handles survival
    const dir = finish(snake, difficulty, decideAIDirection(snake, world));
    noteTurn(snake, dir);
    return dir;
  }

  const attack = pursue(snake, world, difficulty, huntCfg);
  const dir = finish(snake, difficulty, attack || decideAIDirection(snake, world));
  return throttleTurn(snake, dir, world.occupancyMap);
}
