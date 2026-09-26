// Pure level maths (no DOM, no storage). All numbers come from config.js.
import { XP_CURVE, MAX_LEVEL } from './config.js';

export function getXPForLevel(level) {
  const n = Math.max(1, Math.min(MAX_LEVEL, Math.floor(Number(level)) || 1));
  return XP_CURVE * (n - 1) * (n + 2);
}

export function getLevelFromXP(xp) {
  const total = Math.max(0, Math.floor(Number(xp)) || 0);
  let level = 1;
  // MAX_LEVEL is small; a loop is clearer than inverting the quadratic and can't be off by one.
  while (level < MAX_LEVEL && total >= getXPForLevel(level + 1)) level++;
  return level;
}

export function getXPIntoCurrentLevel(xp) {
  const total = Math.max(0, Math.floor(Number(xp)) || 0);
  return total - getXPForLevel(getLevelFromXP(total));
}

// XP the current level spans (the size of the bar); 0 at the level cap.
export function getXPRequiredForNextLevel(xp) {
  const level = getLevelFromXP(xp);
  if (level >= MAX_LEVEL) return 0;
  return getXPForLevel(level + 1) - getXPForLevel(level);
}

// 0..1 fill for the progress bar (full at the level cap).
export function getLevelProgress(xp) {
  const span = getXPRequiredForNextLevel(xp);
  return span === 0 ? 1 : getXPIntoCurrentLevel(xp) / span;
}
