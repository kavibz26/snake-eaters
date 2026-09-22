// Shared constants for grid, timing, scoring, and visuals.
export const CONFIG = {
  GRID_COLS: 84, // enlarged from 70 for more breathing room (ratio kept at 7:5, so CSS aspect-ratio is unaffected)
  GRID_ROWS: 60, // enlarged from 50
  CELL_SIZE: 14,
  TICK_MS: 150, // slowed further from 125 - the single biggest lever for giving a human time to react
  MAX_CATCHUP_TICKS: 5, // cap simulation catch-up if a frame stalls (e.g. tab was backgrounded)

  INITIAL_SNAKE_LENGTH: 5, // AI starting length
  PLAYER_INITIAL_LENGTH: 7, // player starts a bit longer - a small built-in cushion
  AI_COUNT: 5, // kept steady - the bigger arena provides room, not a thinner population
  SPAWN_MARGIN: 6, // min cells kept clear from arena edge when placing a spawn

  PLAYER_SPAWN_FOOD_COUNT: 8, // food guaranteed to exist near the player's spawn, on top of normal replenishment
  PLAYER_SPAWN_FOOD_RADIUS: 18, // cells; guaranteed spawn food is scattered within this radius of the player's head

  AI_MIN_TURN_GAP: 1, // ticks an AI must hold a heading before turning again (barring an emergency) - the player has no such limit, a small deterministic maneuverability edge
  AI_PLAYER_SAFETY_MULT: 1.3, // extra size-advantage multiplier an AI needs specifically to commit to attacking the player (on top of its profile's normal minSizeAdvantage)
  AI_PLAYER_ENGAGE_RANGE: 11, // an AI won't even consider attacking the player from farther than this - must be a real, nearby opportunity
  MAX_PLAYER_ATTACKERS: 1, // at most this many AI may be actively committed to attacking the player at once
  PLAYER_ATTACK_GRACE_TICKS: 240, // ~36s at TICK_MS=150 - the requested 30-45s learning phase before any AI will target the player for attack

  FOOD_TARGET_DIVISOR: 70, // target food count = (cols*rows)/this - lowered from 100 for moderately denser food
  FOOD_SCORE: 10,
  KILL_SCORE: 100,
  KILL_GROWTH_RATIO: 0.5, // winner of a head-to-head gains this fraction of loser's length
  DEATH_FOOD_STRIDE: 2, // every Nth body segment of a dead snake becomes food

  AI_VIEW_RANGE: 14, // cells; how far AI "notices" food
  AI_FLOODFILL_BUDGET: 32, // max cells explored when scoring open space - shortened from 45 so escape planning has realistic limits (an AI can misjudge a route that looks open nearby but narrows further out) instead of always finding the objectively perfect route

  BOOST_DURATION_TICKS: 10, // ~1.5s at TICK_MS=150 - the player moves 2 cells/tick instead of 1 for this long
  BOOST_COOLDOWN_TICKS: 27, // ~4s before boost can be used again after it ends

  PLAYER_COLOR: '#3ee08a',
  AI_COLORS: ['#ff5d5d', '#5db3ff', '#ffcf4d', '#c77dff', '#ff9f4d', '#4de0d6', '#ff6fb0'],

  DIRECTIONS: {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  },
};

export function isOpposite(dirA, dirB) {
  if (!dirA || !dirB) return false;
  return dirA.x === -dirB.x && dirA.y === -dirB.y;
}

export function cellKey(x, y) {
  return x + ',' + y;
}
