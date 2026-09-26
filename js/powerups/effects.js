// Per-snake power-up state and rules. Pure functions on plain snake-like objects, used by BOTH the
// single-player Game and the authoritative multiplayer MatchSim (and the client predictor for the
// one rule it must mirror: the extra Speed step).
import { POWERUPS } from './config.js';

export function initEffects(s) {
  s.speedTicksLeft = 0;
  s.magnetTicksLeft = 0;
  s.shieldTicksLeft = 0;
  s.shieldGraceLeft = 0; // recovery window after a shield absorbed a hit
  s.powerupsCollected = 0; // Speed / Magnet / Shield pickups
  s.megaCollected = 0; // Mega Food pickups
}

export function clearEffects(s) {
  s.speedTicksLeft = 0;
  s.magnetTicksLeft = 0;
  s.shieldTicksLeft = 0;
  s.shieldGraceLeft = 0;
}

export function hasAnyEffect(s) {
  return s.speedTicksLeft > 0 || s.magnetTicksLeft > 0 || s.shieldTicksLeft > 0;
}

// Picks up an item. Effects REFRESH rather than stack (same timer, same single-hit shield).
// -> { kind: 'mega' | 'powerup', type }
export function collectSpecial(s, type) {
  if (type === 'mega') {
    s.grow(POWERUPS.mega.grow);
    s.score += POWERUPS.mega.score;
    s.megaCollected++;
    s.justAte = true;
    return { kind: 'mega', type };
  }
  if (type === 'speed') s.speedTicksLeft = POWERUPS.speed.durationTicks;
  else if (type === 'magnet') s.magnetTicksLeft = POWERUPS.magnet.durationTicks;
  else if (type === 'shield') {
    s.shieldTicksLeft = POWERUPS.shield.durationTicks;
    s.shieldGraceLeft = 0;
  } else {
    return null;
  }
  s.powerupsCollected++;
  return { kind: 'powerup', type };
}

// Does this snake take an extra movement step on simulation tick `tick`? Speed Boost gives one every
// tick, the Speed power-up one every `extraStepInterval` ticks. At most ONE extra step per tick, so
// the combination is capped at 2 cells/tick (the Boost's own speed).
export function takesExtraStep(s, tick) {
  if (s.boostTicksLeft > 0) return true;
  return s.speedTicksLeft > 0 && tick % POWERUPS.speed.extraStepInterval === 0;
}

// The lethal-collision rule. Called wherever a snake WOULD die.
//   'consumed' - the shield just absorbed it (caller emits the effect and holds the snake in place)
//   'grace'    - still inside the recovery window after an absorbed hit (hold in place, nothing consumed)
//   false      - no protection: the snake dies
export function absorbLethal(s) {
  if (s.shieldTicksLeft > 0) {
    s.shieldTicksLeft = 0; // one hit only
    s.shieldGraceLeft = POWERUPS.shield.graceTicks;
    return 'consumed';
  }
  if (s.shieldGraceLeft > 0) return 'grace';
  return false;
}

// End-of-tick timers for the effects the simulation drives from a single place. (Speed counts down
// where its extra step is decided, next to the Boost timer.)
export function endOfTickEffects(s) {
  if (s.magnetTicksLeft > 0) s.magnetTicksLeft--;
  if (s.shieldTicksLeft > 0) s.shieldTicksLeft--;
  if (s.shieldGraceLeft > 0) s.shieldGraceLeft--;
}
