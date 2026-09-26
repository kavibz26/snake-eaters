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
};

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
