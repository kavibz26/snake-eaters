// Turns a finished match into XP. Pure: the same result always yields the same breakdown, and it
// only reads figures that are already final (a single-player run's own totals, or the
// SERVER's authoritative multiplayer results). Nothing here is ever sent anywhere.
import { REWARDS, SCORING } from './config.js';

const int = (v) => Math.max(0, Math.floor(Number(v)) || 0);

// XP for `n` foods / kills in `mode`, with the per-match cap applied.
export function foodXP(mode, n) {
  const r = REWARDS[mode];
  return Math.min(r.foodCap, int(n) * r.foodEach);
}
export function killXP(mode, n) {
  const r = REWARDS[mode];
  return Math.min(r.killCap, int(n) * r.killEach);
}

// Multiplayer results carry score / kills / length, not food; score = food * 10 + kills * 100,
// so the food count can be recovered exactly and cannot be inflated by the client.
export function foodFromMultiplayerScore(score, kills) {
  return Math.floor(Math.max(0, int(score) - int(kills) * SCORING.killScore) / SCORING.foodScore);
}

// result: { mode: 'single' | 'multiplayer', victory, survived, score, kills, food, playSeconds }
// previousHighScore: the profile's high score BEFORE this match.
// Returns { items: [{ id, label, xp, count? }], total }.
export function computeMatchRewards(result, previousHighScore = 0) {
  const mode = result.mode === 'multiplayer' ? 'multiplayer' : 'single';
  const r = REWARDS[mode];
  const seconds = int(result.playSeconds);
  const items = [];
  const add = (id, label, xp, count) => { if (xp > 0) items.push({ id, label, xp, ...(count ? { count } : {}) }); };

  if (seconds >= REWARDS.minSecondsForParticipation) {
    add('played', mode === 'multiplayer' ? 'Multiplayer match' : 'Game played', r.played);
  }
  const food = int(result.food);
  add('food', 'Food eaten', foodXP(mode, food), food);
  const kills = int(result.kills);
  add('kills', kills === 1 ? 'Kill' : 'Kills', killXP(mode, kills), kills);

  if (mode === 'single') {
    add('survival', 'Survival', Math.min(r.survivalCap, Math.floor(seconds / 10) * r.survivalPer10s));
  } else if (result.survived) {
    add('survived', 'Survived to the end', r.survivedAtEnd);
  }
  if (result.victory) add('victory', mode === 'multiplayer' ? 'Multiplayer victory' : 'Victory', r.victory);

  const score = int(result.score);
  if (score >= REWARDS.highScoreMinimum && score > int(previousHighScore)) add('highScore', 'New high score', r.newHighScore);

  return { items, total: items.reduce((sum, i) => sum + i.xp, 0) };
}
