// Every balance number for special food / power-ups lives here. Nothing else in the game hard-codes
// a duration, radius, spawn rate, score or XP value. Times are written in SECONDS and converted to
// simulation ticks (CONFIG.TICK_MS, 150ms) so retuning the tick rate never breaks the balance.
import { CONFIG } from '../config.js';

const ticks = (seconds) => Math.max(1, Math.round((seconds * 1000) / CONFIG.TICK_MS));

// Wire / storage order. The index of a type in this list is its id on the network.
export const POWERUP_TYPES = ['speed', 'magnet', 'shield', 'mega'];

export const POWERUPS = {
  // --- spawning (identical in single player and on the server) ------------------------------------
  spawn: {
    startCooldownTicks: ticks(8), // nothing spawns in the first seconds of a match
    cooldownTicks: ticks(12), // minimum gap between two spawns
    chancePerTick: 0.03, // once the cooldown is over: ~5s on average until the next one appears
    maxActive: 3, // never more than this many special items on the board
    lifetimeTicks: ticks(25), // an item nobody picks up disappears
    minSnakeDistance: 5, // Manhattan cells between a new item and ANY snake segment
    edgeMargin: 2, // never spawn on the outer rim, so it is always approachable
    maxAttempts: 40,
    weights: { speed: 3, magnet: 3, shield: 2, mega: 3 },
  },

  // --- SPEED -----------------------------------------------------------------------------------------
  // Adds one extra step every `extraStepInterval` ticks (2 => 1.5 cells/tick instead of 1). Picking
  // up another Speed while it is active REFRESHES the timer; it never stacks. The Speed Boost button
  // uses the same extra-step mechanism every tick (2 cells/tick); a snake takes at most ONE extra
  // step per tick, so Speed + Boost together are capped at Boost's 2 cells/tick.
  speed: { durationTicks: ticks(5), extraStepInterval: 2 },

  // --- MAGNET ----------------------------------------------------------------------------------------
  // Each tick, food within `radius` cells (Chebyshev) of the head moves one cell closer; food next
  // to the head is collected. Only ordinary food is attracted (never power-ups).
  magnet: { durationTicks: ticks(7), radius: 6 },

  // --- SHIELD ------------------------------------------------------------------------------------------
  // Absorbs the FIRST lethal collision (wall, own body, another snake, being eaten, head-to-head, a
  // fatal boost step). The blocked snake is held in place for that tick, the shield is consumed, and a
  // short `graceTicks` recovery window lets the player steer away (further collisions in that window
  // are also held, without consuming anything). Never more than durationTicks, never more than one hit.
  shield: { durationTicks: ticks(8), graceTicks: 2 },

  // --- MEGA FOOD -------------------------------------------------------------------------------------
  // Normal food is CONFIG.FOOD_SCORE (10) and +1 length.
  mega: { score: 50, grow: 3 },

  // --- XP (paid once, from the final match result; see js/profile) ---------------------------------------
  xp: { powerupEach: 3, powerupCap: 30, megaEach: 8, megaCap: 40 },
};

export const POWERUP_INDEX = Object.fromEntries(POWERUP_TYPES.map((t, i) => [t, i]));
