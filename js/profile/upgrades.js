// Post-Level-10 progression placeholder. From UPGRADE_START_LEVEL (config.js) on, levelling up is meant
// to grant a gameplay upgrade instead of a new skin - but per the spec this shipped under, no upgrade
// has a real effect yet ("do NOT invent or implement gameplay-affecting upgrades"). This module is only
// the data shape a later task fills in: give a category a real `unlockLevel` and wire an effect to its
// `id`, and the profile/UI plumbing already knows how to display it (see isUpgradeLevel() below and its
// one use in js/profile/ui.js).
import { UPGRADE_START_LEVEL } from './config.js';

// One row per future upgrade category. `unlockLevel: null` means "not assigned yet" - deliberately left
// unset rather than guessed, since inventing real level requirements here would be gameplay balance,
// which this task explicitly does not cover. Nothing reads these as unlocked; they exist so a later
// task extends this list instead of designing a second progression system.
export const UPGRADE_CATEGORIES = [
  { id: 'speed', name: 'Speed', unlockLevel: null },
  { id: 'shield', name: 'Shield', unlockLevel: null },
  { id: 'dash', name: 'Dash', unlockLevel: null },
  { id: 'magnet', name: 'Magnet', unlockLevel: null },
  { id: 'powerup_duration', name: 'Power-up Duration', unlockLevel: null },
  { id: 'recovery', name: 'Recovery', unlockLevel: null },
  { id: 'vision', name: 'Vision', unlockLevel: null },
  { id: 'boost', name: 'Boost', unlockLevel: null },
];

// Whether a level is in the "upgrades, not skins" range - lets the UI decide what to say about a
// level-up without hard-coding the number 11 anywhere else.
export function isUpgradeLevel(level) {
  return Number.isInteger(level) && level >= UPGRADE_START_LEVEL;
}
