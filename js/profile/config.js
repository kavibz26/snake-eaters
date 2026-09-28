import { POWERUPS } from '../powerups/config.js';

// Every progression number lives here: the XP curve, XP rewards, skin unlock levels and the
// profile limits. Nothing else in the game hard-codes an XP amount or a level requirement.

export const PROFILE_VERSION = 1;
export const STORAGE_KEY = 'snakeEaters.profile.v1'; // versioned: a future schema gets its own key + a migration
export const LEGACY_SKIN_KEY = 'snakeEatersSkin'; // written by the pre-profile game
export const LEGACY_NICK_KEY = 'snakeEatersNick';

// --- levels --------------------------------------------------------------------------------------
// Total XP needed to REACH level n:  xpForLevel(n) = CURVE * (n - 1) * (n + 2)
//   L1 = 0, L2 = 100, L3 = 250, L4 = 450, L5 = 700, L6 = 1000, L7 = 1350 ... L12 = 3850
// (each level asks for 50 XP more than the one before it). Change CURVE to make the whole game
// faster or slower to level in.
export const XP_CURVE = 25;
export const MAX_LEVEL = 100;

// --- names --------------------------------------------------------------------------------------
// Must stay compatible with the server's sanitizeName (server/protocol.js), otherwise the name
// the player sees in their profile would differ from the one other players see in a lobby.
export const NICKNAME = { min: 2, max: 14, fallbackPrefix: 'Snake' };

// --- XP rewards -----------------------------------------------------------------------------------
// A match (single player run or multiplayer match) is turned into XP exactly once, from its final
// result. `*Cap` values stop a single match from being farmed for unlimited XP.
export const REWARDS = {
  minSecondsForParticipation: 10, // dying/quitting instantly does not pay the "played" reward
  single: {
    played: 10,
    foodEach: 2,
    foodCap: 100,
    killEach: 15,
    killCap: 150,
    survivalPer10s: 1,
    survivalCap: 60,
    victory: 50,
    newHighScore: 25,
    powerupEach: POWERUPS.xp.powerupEach, // Speed / Magnet / Shield pickups (numbers live in js/powerups/config.js)
    powerupCap: POWERUPS.xp.powerupCap,
    megaEach: POWERUPS.xp.megaEach, // Mega Food pickups
    megaCap: POWERUPS.xp.megaCap,
  },
  multiplayer: {
    played: 20, // multiplayer participation
    foodEach: 2,
    foodCap: 100,
    killEach: 20,
    killCap: 200,
    survivedAtEnd: 15,
    victory: 60, // multiplayer victory (decided by the server)
    newHighScore: 25,
    powerupEach: POWERUPS.xp.powerupEach,
    powerupCap: POWERUPS.xp.powerupCap,
    megaEach: POWERUPS.xp.megaEach,
    megaCap: POWERUPS.xp.megaCap,
  },
  highScoreMinimum: 100, // a "new personal best" only pays out once it is a real score
  maxSingleGrant: 5000, // sanity ceiling for any one addXP() call
};

// Points the server / game awards, used to work food eaten back out of an authoritative
// multiplayer score (score = 10 per food + 100 per kill).
export const SCORING = { foodScore: 10, killScore: 100, megaScore: POWERUPS.mega.score };

// --- skin unlocks ----------------------------------------------------------------------------------
// Level at which each skin becomes available. Skins are never taken away once unlocked.
export const SKIN_UNLOCK_LEVELS = {
  classic: 1,
  inferno: 2,
  frost: 3,
  toxic: 4,
  cosmic: 5,
  golden: 7,
  shadow: 9,
  jungle: 12,

  // Progression skins (js/skins.js): exactly 5 unlocked per level, Level 1 through Level 10. Level 11+
  // unlocks gameplay upgrades instead (see UPGRADE_CATEGORIES / js/profile/upgrades.js below) - no more
  // skins are gated behind level from here on.
  neon_lime: 1, ocean_blue: 1, ruby_red: 1, purple_pulse: 1, arctic_white: 1,
  lava_core: 2, electric_blue: 2, emerald_venom: 2, pink_plasma: 2, solar_orange: 2,
  cyber_snake: 3, digital_glitch: 3, holographic: 3, chrome: 3, carbon_fiber: 3,
  deep_ocean: 4, volcanic_rock: 4, toxic_reactor: 4, plasma_storm: 4, frozen_crystal: 4,
  galaxy: 5, nebula: 5, starfire: 5, black_hole: 5, astral: 5,
  samurai: 6, ninja: 6, dragon: 6, phoenix: 6, oni: 6,
  golden_dragon: 7, royal_emerald: 7, royal_sapphire: 7, royal_ruby: 7, royal_amethyst: 7,
  shadow_flame: 8, void: 8, blood_moon: 8, eclipse: 8, dark_matter: 8,
  lightning_god: 9, ice_god: 9, fire_god: 9, storm_god: 9, cosmic_god: 9,
  ancient_king: 10, immortal: 10, celestial: 10, infinity: 10, ultimate_venom: 10,
};

// --- post-Level-10 progression (placeholder) ---------------------------------------------------------
// From Level 11 on, levelling up grants a gameplay UPGRADE instead of a new skin. This is only the data
// shape + UI hook for that - see js/profile/upgrades.js. No category has a real effect yet: they are
// listed so a later task can wire one in without inventing new profile/save-file plumbing first.
export const UPGRADE_START_LEVEL = 11;

// Before profiles existed EVERY skin was available. A player who already had the game (recognised by
// the old skin / nickname keys in localStorage) keeps all of them: their selected skin stays selected
// and nothing is locked behind a level. New players use the level-based unlocks above. The grant is
// one-way and happens once (recorded in the profile as `legacySkinsChecked`).
export const GRANDFATHER_LEGACY_SKINS = true;

// --- recent-unlock highlight ----------------------------------------------------------------------
export const RECENT_UNLOCK_MS = 7 * 24 * 60 * 60 * 1000;

// --- feedback ------------------------------------------------------------------------------------
export const XP_FEED_GROUP_MS = 1400; // rapid XP events inside this window are shown as one toast
export const SAVE_DEBOUNCE_MS = 400; // profile writes are coalesced; they never happen per frame
