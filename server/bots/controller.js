// Server-authoritative bot decisions. This is the ONLY place a bot's next direction is chosen, and it
// runs exclusively inside MatchSim.tick() (server/match.js) - never in a browser. It reuses the exact
// heuristic single-player already plays against (js/ai.js: view ranges, flee/attack/forage scoring,
// floodfill-based space awareness, obstacle-aware reachability) completely unmodified - a bot is simply
// another Snake handed to decideAIDirection(). Difficulty (server/bots/config.js) only decides how
// often that competent choice is overridden with a plain mistake; it never changes speed, collision,
// or power-up rules, which are already identical for every snake in the match.
import { decideAIDirection } from '../../js/ai.js';
import { CONFIG, isOpposite } from '../../js/config.js';

const ALL_DIRECTIONS = Object.values(CONFIG.DIRECTIONS);

// A plain mistake: any direction that isn't an instant reversal, chosen with no regard for food,
// power-ups, threats or prey. This is what "sometimes ignores food / picks a suboptimal route / makes
// a risky decision" looks like in practice - decideAIDirection stays fully competent, and difficulty
// only decides how often this replaces its answer.
function mistake(snake) {
  const options = ALL_DIRECTIONS.filter((d) => !isOpposite(d, snake.direction));
  return options[Math.floor(Math.random() * options.length)] || snake.direction;
}

// snake: a bot's Snake (isBot, profile already set - see MatchSim._spawnSnakes).
// world: the same shape js/game.js already builds for single-player AI (snakes, foodManager,
//   occupancyMap, matchTicks, specials, terrain).
// difficulty: a resolved entry from server/bots/config.js DIFFICULTIES (see difficultyConfig()).
export function decideBotDirection(snake, world, difficulty) {
  const best = decideAIDirection(snake, world);
  if (Math.random() < difficulty.mistakeChance) return mistake(snake);
  return best;
}
