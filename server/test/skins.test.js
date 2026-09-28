import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKINS, DEFAULT_SKIN_ID, getSkinById } from '../../js/skins.js';
import { SKIN_UNLOCK_LEVELS } from '../../js/profile/config.js';
import { getUnlockLevel } from '../../js/profile/profile.js';
import { PATTERN_MARKS } from '../../js/snakeRender.js';

// The skin catalog: js/skins.js (58 skins - the original 8 plus the 50-skin Level 1-10 progression
// ladder) and its unlock levels (js/profile/config.js SKIN_UNLOCK_LEVELS). Pure data/catalog checks;
// profile-integration behaviour (locking, selection, migration) is covered in profile.test.js.

const ORIGINAL_SKIN_IDS = ['classic', 'inferno', 'frost', 'toxic', 'cosmic', 'golden', 'shadow', 'jungle'];
const newSkins = () => SKINS.filter((s) => !ORIGINAL_SKIN_IDS.includes(s.id));

// The exact design this catalog was built from - every new skin's stable id and intended level, so a
// future edit that accidentally moves one is caught precisely, not just by an aggregate count.
const EXPECTED_NEW_SKINS = {
  1: ['neon_lime', 'ocean_blue', 'ruby_red', 'purple_pulse', 'arctic_white'],
  2: ['lava_core', 'electric_blue', 'emerald_venom', 'pink_plasma', 'solar_orange'],
  3: ['cyber_snake', 'digital_glitch', 'holographic', 'chrome', 'carbon_fiber'],
  4: ['deep_ocean', 'volcanic_rock', 'toxic_reactor', 'plasma_storm', 'frozen_crystal'],
  5: ['galaxy', 'nebula', 'starfire', 'black_hole', 'astral'],
  6: ['samurai', 'ninja', 'dragon', 'phoenix', 'oni'],
  7: ['golden_dragon', 'royal_emerald', 'royal_sapphire', 'royal_ruby', 'royal_amethyst'],
  8: ['shadow_flame', 'void', 'blood_moon', 'eclipse', 'dark_matter'],
  9: ['lightning_god', 'ice_god', 'fire_god', 'storm_god', 'cosmic_god'],
  10: ['ancient_king', 'immortal', 'celestial', 'infinity', 'ultimate_venom'],
};

test('exactly 50 new skins exist, on top of the 8 pre-existing ones (58 total)', () => {
  assert.equal(SKINS.length, 58);
  assert.equal(newSkins().length, 50);
  for (const id of ORIGINAL_SKIN_IDS) assert.ok(SKINS.some((s) => s.id === id), `pre-existing skin ${id} still exists`);
});

test('every new skin has a unique, stable snake_case id - never a level number or display name', () => {
  const ids = newSkins().map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  assert.equal(new Set([...SKINS.map((s) => s.id)]).size, SKINS.length, 'no id collides with an existing skin either');
  for (const id of ids) {
    assert.match(id, /^[a-z][a-z0-9_]*$/, `${id} is snake_case`);
    assert.ok(!/^\d+$/.test(id) && !/^level/.test(id), `${id} is not a level number in disguise`);
  }
});

test('every new skin has exactly the unlock level the design specifies', () => {
  for (const [level, ids] of Object.entries(EXPECTED_NEW_SKINS)) {
    for (const id of ids) {
      assert.equal(SKIN_UNLOCK_LEVELS[id], Number(level), `${id} should unlock at level ${level}`);
      assert.equal(getUnlockLevel(id), Number(level));
    }
  }
});

test('exactly 5 new skins are assigned to each level from 1 to 10, and none beyond level 10', () => {
  for (let lvl = 1; lvl <= 10; lvl++) {
    const atLevel = newSkins().filter((s) => SKIN_UNLOCK_LEVELS[s.id] === lvl);
    assert.equal(atLevel.length, 5, `level ${lvl} has exactly 5 new skins`);
  }
  assert.ok(newSkins().every((s) => SKIN_UNLOCK_LEVELS[s.id] >= 1 && SKIN_UNLOCK_LEVELS[s.id] <= 10), 'no new skin unlocks below 1 or past 10');
});

test('Level 10 unlocks all 50 new skins; Level 11 grants no further skin (upgrades take over from there)', () => {
  const unlockedByLevel = (lvl) => new Set(Object.entries(SKIN_UNLOCK_LEVELS).filter(([, l]) => l <= lvl).map(([id]) => id));
  const at10 = unlockedByLevel(10);
  const at11 = unlockedByLevel(11);
  for (const s of newSkins()) assert.ok(at10.has(s.id), `${s.id} is unlocked by level 10`);
  assert.equal(at11.size, at10.size, 'no additional skin becomes unlocked between level 10 and level 11');
});

test('every skin (existing and new) has a complete, valid render definition', () => {
  const knownPatterns = new Set(Object.keys(PATTERN_MARKS));
  const hex = /^#[0-9a-fA-F]{6}$/;
  for (const s of SKINS) {
    for (const field of ['id', 'name', 'emoji', 'base', 'baseShade', 'accent', 'accent2', 'pattern', 'ui']) {
      assert.equal(typeof s[field], 'string', `${s.id}.${field} is a string`);
      assert.ok(s[field].length > 0, `${s.id}.${field} is not empty`);
    }
    for (const field of ['base', 'baseShade', 'accent', 'accent2', 'ui']) assert.match(s[field], hex, `${s.id}.${field} is a valid hex color`);
    assert.ok(knownPatterns.has(s.pattern), `${s.id} uses a real pattern ("${s.pattern}") - js/snakeRender.js can actually draw it`);
    assert.ok(Number.isInteger(s.patternPeriod) && s.patternPeriod >= 1, `${s.id} has a valid patternPeriod`);
    assert.ok(Number.isFinite(s.glow) && s.glow >= 0, `${s.id} has a non-negative glow`);
  }
});

test('every skin id is unique across the whole catalog and getSkinById resolves every one of them', () => {
  const ids = SKINS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.equal(getSkinById(id).id, id);
  assert.equal(getSkinById('does-not-exist').id, DEFAULT_SKIN_ID, 'an unknown id safely falls back to the default skin');
});

test('higher-tier skins escalate glow as a rarity signal, without ever exceeding a sane cap for mobile performance', () => {
  // Not a strict per-skin ordering (colour/theme matters more than a single number), but the tier
  // AVERAGE should trend up, and nothing should run away to a value expensive to redraw every segment.
  const avgGlowForLevels = (lo, hi) => {
    const tier = newSkins().filter((s) => SKIN_UNLOCK_LEVELS[s.id] >= lo && SKIN_UNLOCK_LEVELS[s.id] <= hi);
    return tier.reduce((sum, s) => sum + s.glow, 0) / tier.length;
  };
  const common = avgGlowForLevels(1, 2);
  const rare = avgGlowForLevels(3, 5);
  const legendary = avgGlowForLevels(8, 10);
  assert.ok(common < rare, `common tier glow (${common}) should read as calmer than rare tier (${rare})`);
  assert.ok(rare < legendary, `rare tier glow (${rare}) should read as calmer than legendary tier (${legendary})`);
  for (const s of SKINS) assert.ok(s.glow <= 16, `${s.id}'s glow (${s.glow}) stays within a performance-sane bound`);
});
