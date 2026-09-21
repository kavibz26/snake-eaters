import { CONFIG, cellKey, isOpposite } from './config.js';
import { inBounds } from './collision.js';

const ALL_DIRECTIONS = Object.values(CONFIG.DIRECTIONS);

// Personality traits. These drive *when* a snake decides to fight, flee, or
// just forage - the actual scoring math is shared by all profiles.
const PROFILE_TRAITS = {
  // Mostly food-driven, but will snap up an easy kill or bolt from danger.
  forager: {
    threatViewRange: 11,
    preyViewRange: 10,
    fleeCloseFactor: 0.75, // flee once a closing-in threat is within this fraction of threatViewRange
    fleeFarFactor: 0.45, // flee from a threat merely nearby (not visibly pursuing) within this fraction
    fleeUrgency: 2.4,
    attackDesire: 1.5,
    interceptWeight: 1.3,
    foodWeight: 2.6,
    spaceWeight: 1.2,
    minSizeAdvantage: 1.3, // must outweigh prey by this ratio to bother attacking
    engageRiskRange: 6, // abandons an attack if any bigger snake is within this range
    jitter: 0.5,
  },
  // Actively searches for kills; only backs off once a fight looks unsafe.
  hunter: {
    threatViewRange: 9,
    preyViewRange: 17,
    fleeCloseFactor: 0.65,
    fleeFarFactor: 0.3,
    fleeUrgency: 1.7,
    attackDesire: 3.0,
    interceptWeight: 2.4,
    foodWeight: 1.0,
    spaceWeight: 1.0,
    minSizeAdvantage: 1.05,
    engageRiskRange: 3,
    jitter: 0.35,
  },
  // Prioritizes not dying. Flees early, only fights sure things.
  cautious: {
    threatViewRange: 16,
    preyViewRange: 8,
    fleeCloseFactor: 0.85,
    fleeFarFactor: 0.6,
    fleeUrgency: 3.4,
    attackDesire: 0.7,
    interceptWeight: 0.8,
    foodWeight: 1.8,
    spaceWeight: 1.9,
    minSizeAdvantage: 1.7,
    engageRiskRange: 10,
    jitter: 0.25,
  },
};

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// Per-AI-snake scratch state, keyed by the Snake instance itself so it needs
// no wiring through Game/Snake and is naturally garbage-collected on restart.
const aiMemory = new WeakMap();

function getMemory(snake) {
  let mem = aiMemory.get(snake);
  if (!mem) {
    mem = { sinceTurn: 99, lastMode: null, lastTargetingPlayer: false }; // sinceTurn large so a snake's very first decision is never gated
    aiMemory.set(snake, mem);
  }
  return mem;
}

// Read-only peek at an AI snake's last decided mode, for the renderer - lets
// the player see who's hunting them and who's on the run without exposing
// any of the decision internals.
export function getAIDisplayState(snake) {
  const mem = aiMemory.get(snake);
  if (!mem) return null;
  return { mode: mem.lastMode, targetingPlayer: mem.lastTargetingPlayer };
}

function clampToGrid(cell) {
  return {
    x: Math.max(0, Math.min(CONFIG.GRID_COLS - 1, cell.x)),
    y: Math.max(0, Math.min(CONFIG.GRID_ROWS - 1, cell.y)),
  };
}

// Where a snake will likely be in `steps` ticks if it keeps its current
// heading - used to aim at where a target is *going*, not where it stood.
function projectPosition(snakeLike, steps) {
  return clampToGrid({
    x: snakeLike.head.x + snakeLike.direction.x * steps,
    y: snakeLike.head.y + snakeLike.direction.y * steps,
  });
}

// True if `mover` is actually heading toward `target` right now, as opposed
// to just happening to be nearby - lets AI tell a real chase from a near miss.
function isClosingIn(mover, target) {
  const toTarget = { x: target.head.x - mover.head.x, y: target.head.y - mover.head.y };
  const dot = toTarget.x * mover.direction.x + toTarget.y * mover.direction.y;
  return dot > 0;
}

// Small BFS capped at a cell budget: cheap proxy for "how much open room is
// there if I go this way", so AI snakes steer away from dead ends.
function openSpaceScore(startCell, occupancyMap, budget) {
  const startKey = cellKey(startCell.x, startCell.y);
  if (occupancyMap.has(startKey)) return 0;
  const visited = new Set([startKey]);
  const queue = [startCell];
  let explored = 0;
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

function findNearestFood(head, foodManager, viewRange) {
  let best = null;
  let bestDist = Infinity;
  for (const food of foodManager.all()) {
    const d = manhattan(head, food);
    if (d <= viewRange && d < bestDist) {
      bestDist = d;
      best = food;
    }
  }
  return best;
}

// The single most urgent bigger snake in view, "urgency" favoring one that's
// both close AND actually bearing down on us over one that's merely nearby.
function findNearestThreat(snake, snakes, viewRange) {
  let best = null;
  let bestUrgency = Infinity;
  for (const other of snakes) {
    if (other === snake || !other.alive) continue;
    if (other.length <= snake.length) continue;
    const dist = manhattan(snake.head, other.head);
    if (dist > viewRange) continue;
    const closingIn = isClosingIn(other, snake);
    const urgency = dist - (closingIn ? 3 : 0);
    if (urgency < bestUrgency) {
      bestUrgency = urgency;
      best = { snake: other, dist, closingIn };
    }
  }
  return best;
}

// The nearest snake this profile is both able (size) and willing (no bigger
// threat lurking close enough to punish the attempt) to go after.
function findSafePrey(snake, snakes, traits, viewRange) {
  let best = null;
  let bestDist = Infinity;
  for (const other of snakes) {
    if (other === snake || !other.alive) continue;
    if (snake.length < other.length * traits.minSizeAdvantage) continue;
    const dist = manhattan(snake.head, other.head);
    if (dist > viewRange) continue;
    if (dist < bestDist) {
      bestDist = dist;
      best = other;
    }
  }
  if (!best) return null;

  for (const other of snakes) {
    if (other === snake || other === best || !other.alive) continue;
    if (other.length > snake.length && manhattan(snake.head, other.head) <= traits.engageRiskRange) {
      return null; // a bigger snake is close enough to punish committing to this chase
    }
  }
  return best;
}

// Priority order: (1) never run into something (handled by the caller's
// blocked-cell filter, applies no matter what mode we're in), (2) escape a
// snake that's actually a threat, (3) press an advantage if one is safely
// available, (4) otherwise forage / hold position for later.
function decideMode(traits, threat, prey) {
  if (threat) {
    const threshold = threat.closingIn
      ? traits.threatViewRange * traits.fleeCloseFactor
      : traits.threatViewRange * traits.fleeFarFactor;
    if (threat.dist <= threshold) return 'flee';
  }
  if (prey) return 'attack';
  return 'forage';
}

// The player gets extra protection an AI wouldn't extend to another AI: a
// bigger safety margin, a shorter "must actually be nearby" engage range, an
// opening-minutes grace period, and a cap on how many AI commit to it at
// once. This is what keeps early pressure from feeling like a pile-on while
// leaving AI-vs-AI hunting exactly as sharp as before.
export function restrictPreyIfPlayer(snake, prey, traits, world) {
  if (!prey || !prey.isPlayer) return prey;

  if ((world.matchTicks || 0) < CONFIG.PLAYER_ATTACK_GRACE_TICKS) return null;

  const requiredAdvantage = traits.minSizeAdvantage * CONFIG.AI_PLAYER_SAFETY_MULT;
  if (snake.length < prey.length * requiredAdvantage) return null;

  if (manhattan(snake.head, prey.head) > CONFIG.AI_PLAYER_ENGAGE_RANGE) return null;

  const pressure = world.playerPressure;
  if (pressure) {
    if (pressure.count >= pressure.cap) return null; // enough AI are already on the player this tick
    pressure.count++;
  }
  return prey;
}

export function decideAIDirection(snake, world) {
  const { snakes, foodManager, occupancyMap } = world;
  const traits = PROFILE_TRAITS[snake.profile] || PROFILE_TRAITS.forager;
  const head = snake.head;

  const threat = findNearestThreat(snake, snakes, traits.threatViewRange);
  let prey = findSafePrey(snake, snakes, traits, traits.preyViewRange);
  prey = restrictPreyIfPlayer(snake, prey, traits, world);
  const mode = decideMode(traits, threat, prey);
  const food = mode === 'forage' ? findNearestFood(head, foodManager, CONFIG.AI_VIEW_RANGE) : null;

  const memory = getMemory(snake);
  memory.lastMode = mode;
  memory.lastTargetingPlayer = !!(prey && prey.isPlayer);

  const threatProjected = threat ? projectPosition(threat.snake, 2) : null;
  const preyProjected = prey ? projectPosition(prey, 2) : null;

  const candidates = ALL_DIRECTIONS.filter((dir) => !isOpposite(dir, snake.direction));

  let best = null;
  let bestScore = -Infinity;
  let bestSafeFallback = null;
  let bestFallbackSpace = -1;

  for (const dir of candidates) {
    const next = { x: head.x + dir.x, y: head.y + dir.y };
    const blocked = !inBounds(next.x, next.y) || occupancyMap.has(cellKey(next.x, next.y));
    const space = openSpaceScore(next, occupancyMap, CONFIG.AI_FLOODFILL_BUDGET);

    if (blocked) {
      // Track the least-bad blocked option in case every direction is unsafe.
      if (space > bestFallbackSpace) {
        bestFallbackSpace = space;
        bestSafeFallback = dir;
      }
      continue;
    }

    // Open space matters in every mode (priority 5: don't trap yourself),
    // but doubly so while fleeing - a "safe" direction into a dead end isn't.
    let score = space * traits.spaceWeight * (mode === 'flee' ? 1.6 : 1);

    if (mode === 'flee' && threat) {
      const distNow = manhattan(head, threat.snake.head);
      const distNext = manhattan(next, threat.snake.head);
      score += (distNext - distNow) * traits.fleeUrgency;

      // Lighter weight than the primary term on purpose: this should nudge
      // the escape route, not compete with it - two similarly-weighted pulls
      // in different directions is what makes fleeing look indecisive.
      const projNow = manhattan(head, threatProjected);
      const projNext = manhattan(next, threatProjected);
      score += (projNext - projNow) * traits.fleeUrgency * 0.3;
    } else if (mode === 'attack' && prey) {
      const distNow = manhattan(head, prey.head);
      const distNext = manhattan(next, prey.head);
      score += (distNow - distNext) * traits.attackDesire;

      const projNow = manhattan(head, preyProjected);
      const projNext = manhattan(next, preyProjected);
      score += (projNow - projNext) * traits.interceptWeight;
    } else if (food) {
      const distNow = manhattan(head, food);
      const distNext = manhattan(next, food);
      score += (distNow - distNext) * traits.foodWeight;
    }

    // Even off-mode, a distant threat or an opportunistic snack still nudges
    // the decision - keeps behavior from feeling like it's on rails.
    if (mode !== 'flee' && threat) {
      const distNow = manhattan(head, threat.snake.head);
      const distNext = manhattan(next, threat.snake.head);
      score += (distNext - distNow) * traits.fleeUrgency * 0.25;
    }

    // Dial down randomness while fleeing or attacking - both should read as
    // deliberate, not confused. Foraging keeps full jitter; there's nothing
    // at stake in wandering unpredictably between food.
    const jitterMult = mode === 'flee' ? 0.4 : mode === 'attack' ? 0.6 : 1;
    score += Math.random() * traits.jitter * jitterMult;

    if (score > bestScore) {
      bestScore = score;
      best = dir;
    }
  }

  const chosen = best || bestSafeFallback || snake.direction;

  // The player can change direction every single tick; AI must hold a
  // heading for a beat before turning again unless continuing straight is
  // actually unsafe, or a threat is right on top of it. Small, deterministic,
  // and it never overrides genuine survival needs - just a reflex-speed gap.
  const wantsTurn = chosen.x !== snake.direction.x || chosen.y !== snake.direction.y;
  if (wantsTurn) {
    const straightNext = { x: head.x + snake.direction.x, y: head.y + snake.direction.y };
    const straightBlocked = !inBounds(straightNext.x, straightNext.y) || occupancyMap.has(cellKey(straightNext.x, straightNext.y));
    const emergency = straightBlocked || (mode === 'flee' && threat && threat.dist <= 2);

    if (!emergency && memory.sinceTurn < CONFIG.AI_MIN_TURN_GAP) {
      memory.sinceTurn++;
      return snake.direction;
    }
    memory.sinceTurn = 0;
    return chosen;
  }

  memory.sinceTurn++;
  return chosen;
}
