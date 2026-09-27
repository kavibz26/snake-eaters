// Bot AI tuning: identities, how many fill a solo human's match, and difficulty. The ONE place these
// numbers live - lobby/match code only ever reads from here, never hard-codes a name, count or
// behaviour number. Difficulty affects BEHAVIOUR ONLY: every bot is a completely ordinary Snake that
// goes through the exact same movement, collision, map and power-up rules as every other snake in
// server/match.js (see js/snake.js, js/collision.js) - nothing here can give a bot extra cells, extra
// speed, or any immunity a human snake does not also have.
export const BOT_NAMES = ['Viper', 'Cobra', 'Fang', 'Venom', 'Python'];

// Bots are added once, the moment the first human is alone in an otherwise empty lobby (see
// Lobby._maybeFillBots in server/lobbies.js) - never topped up again after that.
export const SOLO_BOT_COUNT = 3;

// Each difficulty is a pool of the existing single-player AI personalities (js/ai.js PROFILE_TRAITS -
// unchanged, just reused) plus how often a bot ignores its own best move and does something worse on
// purpose (see server/bots/controller.js). This is what makes Easy forgiving and Hard sharp without
// touching a single movement/collision/speed rule.
//
// `hunt` tunes ONLY how eagerly a bot goes looking for a smaller snake to chase (server/bots/controller.js):
//   range:     how far (cells) a bot will look for a target worth chasing
//   lockTicks: once it commits to a target, how many ticks it keeps chasing before it is free to
//              re-evaluate (so bots pursue rather than flicker between targets every tick)
//   leadTicks: how far ahead of the target's current heading the bot aims (its "interception" guess)
// None of this touches movement speed, collision, or power-up rules - it only decides which direction
// a bot's own ordinary move this tick is aimed at.
// `range` is deliberately generous relative to js/ai.js's own AI_VIEW_RANGE (14, tuned for noticing
// nearby FOOD): on an 84x60 board with only a handful of snakes on it, two snakes are rarely within 14
// cells of each other at all, so a "hunting" range that size almost never finds anyone to chase - a bot
// that is meant to actively hunt has to be willing to travel to reach a target it has spotted.
export const DIFFICULTIES = {
  easy: { profiles: ['forager', 'cautious'], mistakeChance: 0.22, hunt: { range: 20, lockTicks: 10, leadTicks: 2 } },
  normal: { profiles: ['forager', 'hunter', 'cautious'], mistakeChance: 0.1, hunt: { range: 30, lockTicks: 16, leadTicks: 3 } },
  hard: { profiles: ['hunter', 'forager'], mistakeChance: 0.03, hunt: { range: 40, lockTicks: 22, leadTicks: 4 } },
};

export const DEFAULT_DIFFICULTY = 'normal';

// Per-PERSONALITY attack tuning (server/bots/controller.js), layered on top of the difficulty's base
// `hunt` numbers above - this is what makes a Hunter aggressive, a Forager opportunistic, and a
// Cautious bot picky, independent of which difficulty they are playing at:
//   minAdvantage:       the target must be at least this much smaller (length ratio) to be worth chasing
//   rangeMult:          multiplies the difficulty's base hunt range
//   abortRange:         a THIRD snake bigger than this bot, this close, cancels the chase (self-preservation)
//   requireClearEscape: only commit to a chase when this bot's immediate surroundings are still open
//   dangerRange:        a bigger snake THIS close is treated as immediate danger no matter what it's doing
//   dangerClosingRange: ...or a bit further away but actually closing in - either overrides any chase
// The last two are what makes a Hunter bold (small bubble, hard to scare off) and a Cautious bot
// jumpy (large bubble, backs off from further away) - "immediate danger" always outranks attacking.
export const PROFILE_HUNT = {
  hunter: { minAdvantage: 1.05, rangeMult: 1.25, abortRange: 3, requireClearEscape: false, dangerRange: 3, dangerClosingRange: 5 },
  forager: { minAdvantage: 1.2, rangeMult: 0.85, abortRange: 5, requireClearEscape: false, dangerRange: 4, dangerClosingRange: 7 },
  cautious: { minAdvantage: 1.45, rangeMult: 0.7, abortRange: 7, requireClearEscape: true, dangerRange: 6, dangerClosingRange: 9 },
};

export function profileHuntConfig(profile) {
  return PROFILE_HUNT[profile] || PROFILE_HUNT.forager;
}

export function isKnownDifficulty(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(DIFFICULTIES, name);
}

export function difficultyConfig(name) {
  return DIFFICULTIES[isKnownDifficulty(name) ? name : DEFAULT_DIFFICULTY];
}

// A personality for the i-th bot in a match, drawn from this difficulty's pool. Deterministic per
// index so a given seat always gets the same style of opponent, without needing per-match randomness.
export function profileFor(difficultyName, index) {
  const pool = difficultyConfig(difficultyName).profiles;
  return pool[index % pool.length];
}

// A deterministic name for the i-th bot added to a lobby (BOT_NAMES has exactly as many entries as a
// lobby can ever need bots - at most 5, one human plus 5 bots being the 6-player cap).
export function botName(index) {
  return BOT_NAMES[index % BOT_NAMES.length];
}
