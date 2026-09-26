// Profile persistence: default profile, safe parsing, validation, migrations, and the actual
// localStorage reads/writes. No DOM. `storage` is injectable (tests pass a fake), and every access
// is wrapped so a missing / blocked / full localStorage can never crash the game.
import {
  PROFILE_VERSION, STORAGE_KEY, LEGACY_SKIN_KEY, LEGACY_NICK_KEY, NICKNAME, MAX_LEVEL,
  SKIN_UNLOCK_LEVELS, GRANDFATHER_LEGACY_SKINS,
} from './config.js';
import { getLevelFromXP, getXPForLevel } from './xp.js';

const MAX_XP = getXPForLevel(MAX_LEVEL) * 2; // sanity ceiling for a value read from storage
const MAX_STAT = 1e9;

export function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // accessing localStorage itself can throw (blocked cookies / sandboxed frames)
  }
}

// --- nickname ---------------------------------------------------------------------------------------

// Same rules as the server's sanitizeName, so the name shown in the profile is the name other
// players see. Text only: it is always rendered with textContent, never as HTML.
export function sanitizeNickname(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/[^\p{L}\p{N} _.\-!]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, NICKNAME.max).join('').trim();
}

// -> { ok, value, error, changed }   `changed`: characters were removed / shortened
export function validateNickname(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const value = sanitizeNickname(text);
  if (Array.from(value).length < NICKNAME.min) {
    return { ok: false, value, error: value ? `Use at least ${NICKNAME.min} characters.` : 'Please enter a nickname.', changed: false };
  }
  return { ok: true, value, error: null, changed: value !== text.trim().replace(/\s+/g, ' ') };
}

export function generateDefaultNickname(random = Math.random) {
  return `${NICKNAME.fallbackPrefix}${1000 + Math.floor(random() * 9000)}`;
}

// --- shape -----------------------------------------------------------------------------------------

const STAT_KEYS = ['gamesPlayed', 'gamesWon', 'kills', 'foodEaten', 'highestScore', 'longestSnake', 'totalPlayTime', 'multiplayerGames', 'multiplayerWins', 'powerupsCollected', 'megaFoodCollected'];

const num = (v, max = MAX_STAT) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
};

export function createDefaultProfile({ now = Date.now(), random = Math.random, legacy = {}, knownSkins = Object.keys(SKIN_UNLOCK_LEVELS) } = {}) {
  const nick = validateNickname(legacy.nickname);
  const legacySkin = knownSkins.includes(legacy.skin) ? legacy.skin : null;
  const unlocked = new Set(Object.entries(SKIN_UNLOCK_LEVELS).filter(([, lvl]) => lvl <= 1).map(([id]) => id));
  // An existing player (old skin / nickname key present) keeps every skin the old game offered.
  const existingPlayer = Boolean(legacy.skin || legacy.nickname);
  if (existingPlayer && GRANDFATHER_LEGACY_SKINS) for (const id of knownSkins) unlocked.add(id);
  return {
    version: PROFILE_VERSION,
    nickname: nick.ok ? nick.value : generateDefaultNickname(random),
    level: 1,
    xp: 0,
    stats: Object.fromEntries(STAT_KEYS.map((k) => [k, 0])),
    unlockedSkins: [...unlocked],
    selectedSkin: legacySkin && unlocked.has(legacySkin) ? legacySkin : 'classic',
    recentUnlock: null, // { skinId, at } - the skin unlocked most recently, for the profile highlight
    legacySkinsChecked: true, // a brand-new profile has nothing left to migrate
    createdAt: now,
    updatedAt: now,
  };
}

// One-way migration for a profile that predates the legacy-skin grant (or whose flag is missing):
// if the old game's keys exist, every known skin is added to `unlockedSkins`. Nothing is ever removed,
// the selection / XP / level are untouched, and the flag makes sure it runs once. -> true if changed.
export function grantLegacySkins(profile, legacy, knownSkins = Object.keys(SKIN_UNLOCK_LEVELS)) {
  if (profile.legacySkinsChecked) return false;
  profile.legacySkinsChecked = true;
  if (GRANDFATHER_LEGACY_SKINS && (legacy.skin || legacy.nickname)) {
    for (const id of knownSkins) if (!profile.unlockedSkins.includes(id)) profile.unlockedSkins.push(id);
  }
  return true;
}

// Coerces ANY parsed value into a valid current-version profile: unknown fields are dropped,
// numbers are clamped, skins are checked against the real skin list, the selected skin is forced
// to be one the player owns, and `level` is always recomputed from `xp`.
export function sanitizeProfile(raw, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const knownSkins = ctx.knownSkins || Object.keys(SKIN_UNLOCK_LEVELS);
  const base = createDefaultProfile({ now, random: ctx.random, knownSkins });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;

  const nick = validateNickname(raw.nickname);
  const xp = num(raw.xp, MAX_XP);
  const stats = {};
  const rs = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  for (const k of STAT_KEYS) stats[k] = num(rs[k]);

  const level = getLevelFromXP(xp);
  const unlocked = new Set(base.unlockedSkins);
  if (Array.isArray(raw.unlockedSkins)) for (const id of raw.unlockedSkins) if (knownSkins.includes(id)) unlocked.add(id);
  // Skins earned by level are always owned, even if the stored list is stale or was edited.
  for (const [id, lvl] of Object.entries(SKIN_UNLOCK_LEVELS)) if (lvl <= level && knownSkins.includes(id)) unlocked.add(id);

  const selected = knownSkins.includes(raw.selectedSkin) && unlocked.has(raw.selectedSkin) ? raw.selectedSkin : 'classic';
  const recent = raw.recentUnlock && typeof raw.recentUnlock === 'object' && unlocked.has(raw.recentUnlock.skinId)
    ? { skinId: raw.recentUnlock.skinId, at: num(raw.recentUnlock.at, Number.MAX_SAFE_INTEGER) }
    : null;
  const createdAt = num(raw.createdAt, Number.MAX_SAFE_INTEGER) || now;

  return {
    version: PROFILE_VERSION,
    nickname: nick.ok ? nick.value : base.nickname,
    level,
    xp,
    stats,
    unlockedSkins: [...unlocked],
    selectedSkin: selected,
    recentUnlock: recent,
    legacySkinsChecked: raw.legacySkinsChecked === true,
    createdAt,
    updatedAt: num(raw.updatedAt, Number.MAX_SAFE_INTEGER) || now,
  };
}

// --- migrations ----------------------------------------------------------------------------------------
// MIGRATIONS[n] upgrades a profile stored with `version: n` to version n + 1. When the schema
// changes, bump PROFILE_VERSION, add the step here and (if the key is versioned) the new key.
export const MIGRATIONS = {
  // 0 -> 1: profiles written before versioning carried no `version` field.
  0: (p) => ({ ...p, version: 1 }),
};

export function migrateProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { data: raw, future: false };
  let v = Number.isInteger(raw.version) ? raw.version : 0;
  if (v > PROFILE_VERSION) return { data: raw, future: true }; // written by a NEWER build: read it, never overwrite it
  let data = raw;
  while (v < PROFILE_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) break;
    data = step(data);
    v++;
  }
  return { data, future: false };
}

// --- load / save --------------------------------------------------------------------------------------

function readLegacy(storage) {
  const out = {};
  try { out.skin = storage.getItem(LEGACY_SKIN_KEY) || undefined; } catch { /* ignore */ }
  try { out.nickname = storage.getItem(LEGACY_NICK_KEY) || undefined; } catch { /* ignore */ }
  return out;
}

// -> { profile, source, readOnly }
//   source: 'stored' | 'new' | 'legacy-import' | 'recovered' (stored data was unreadable) | 'unavailable'
export function loadProfile(storage = defaultStorage(), ctx = {}) {
  const now = ctx.now ?? Date.now();
  if (!storage) return { profile: createDefaultProfile({ now, random: ctx.random, knownSkins: ctx.knownSkins }), source: 'unavailable', readOnly: true };
  let text = null;
  try { text = storage.getItem(STORAGE_KEY); } catch { return { profile: createDefaultProfile({ now, random: ctx.random, knownSkins: ctx.knownSkins }), source: 'unavailable', readOnly: true }; }
  const legacy = readLegacy(storage);

  if (text == null) {
    const fresh = createDefaultProfile({ now, random: ctx.random, legacy, knownSkins: ctx.knownSkins });
    return { profile: fresh, source: legacy.skin || legacy.nickname ? 'legacy-import' : 'new', readOnly: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { profile: createDefaultProfile({ now, random: ctx.random, legacy, knownSkins: ctx.knownSkins }), source: 'recovered', readOnly: false, corruptText: text };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { profile: createDefaultProfile({ now, random: ctx.random, legacy, knownSkins: ctx.knownSkins }), source: 'recovered', readOnly: false, corruptText: text };
  }
  const { data, future } = migrateProfile(parsed);
  const profile = sanitizeProfile(data, ctx);
  // A profile written by a newer build is read as-is and never modified.
  const migrated = future ? false : grantLegacySkins(profile, legacy, ctx.knownSkins);
  return { profile, source: 'stored', readOnly: future, migrated };
}

export function saveProfile(storage, profile) {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false; // quota / private mode: progress just will not persist this time
  }
}
