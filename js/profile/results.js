// Adapters from the two kinds of "match is over" data to the one normalised result the profile
// consumes. Multiplayer figures come ONLY from the server's `over` message - the client never
// reports (or supplies) its own kills, wins, score or XP.
import { CONFIG } from '../config.js';
import { foodFromMultiplayerScore } from './rewards.js';

// payload: Game.onGameOver({ victory, score, length, eliminations, foodEaten, ticks })
export function fromSinglePlayer(payload, key) {
  if (!payload || !key) return null;
  return {
    key,
    mode: 'single',
    victory: payload.victory === true,
    survived: payload.victory === true,
    score: payload.score,
    length: payload.length,
    kills: payload.eliminations,
    food: payload.foodEaten,
    powerups: payload.powerups,
    mega: payload.mega,
    playSeconds: Math.round(((payload.ticks || 0) * CONFIG.TICK_MS) / 1000), // game time: pauses are not counted
  };
}

// over: the server's { t:'over', winnerId, reason, results: [{ id, rank, score, length, kills, survived, ... }] }
// Returns null when this player is not in the results (e.g. they left before the end).
export function fromMultiplayer(over, myId, key, playSeconds) {
  if (!over || !Array.isArray(over.results) || !myId || !key) return null;
  const me = over.results.find((r) => r && r.id === myId);
  if (!me) return null;
  const won = over.winnerId != null && over.winnerId === myId && over.results.length >= 2;
  return {
    key,
    mode: 'multiplayer',
    victory: won,
    survived: me.survived === true,
    score: me.score,
    length: me.length,
    kills: me.kills,
    food: foodFromMultiplayerScore(me.score, me.kills, me.mega), // Mega Food score is not "food eaten"
    powerups: me.powerups,
    mega: me.mega,
    playSeconds,
  };
}
