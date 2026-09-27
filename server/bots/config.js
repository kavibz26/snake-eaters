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
export const DIFFICULTIES = {
  easy: { profiles: ['forager', 'cautious'], mistakeChance: 0.22 },
  normal: { profiles: ['forager', 'hunter', 'cautious'], mistakeChance: 0.1 },
  hard: { profiles: ['hunter', 'forager'], mistakeChance: 0.03 },
};

export const DEFAULT_DIFFICULTY = 'normal';

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
