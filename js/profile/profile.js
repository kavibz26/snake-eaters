// The player's persistent local profile: nickname, XP / level, statistics and skin unlocks.
// One instance is shared by the whole game. No DOM in here - the UI subscribes to events.
import { SKINS } from '../skins.js';
import { STORAGE_KEY, SKIN_UNLOCK_LEVELS, REWARDS, SAVE_DEBOUNCE_MS, RECENT_UNLOCK_MS, MAX_LEVEL } from './config.js';
import { getLevelFromXP, getXPForLevel, getXPIntoCurrentLevel, getXPRequiredForNextLevel, getLevelProgress } from './xp.js';
import { computeMatchRewards } from './rewards.js';
import { loadProfile, saveProfile, defaultStorage, validateNickname } from './store.js';

const KNOWN_SKINS = SKINS.map((s) => s.id);
const MAX_PROCESSED_KEYS = 200;
const MAX_PLAY_SECONDS = 6 * 60 * 60; // no single match is longer than this

const int = (v, max = 1e9) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0; };

export function getUnlockLevel(skinId) {
  return SKIN_UNLOCK_LEVELS[skinId] ?? 1; // a skin without an entry is simply always available
}

export class Profile {
  constructor({ storage = defaultStorage(), now = () => Date.now(), random = Math.random, schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id) } = {}) {
    this.storage = storage;
    this.now = now;
    this._schedule = schedule;
    this._cancel = cancel;
    const loaded = loadProfile(storage, { now: now(), random, knownSkins: KNOWN_SKINS });
    this.data = loaded.profile;
    this.source = loaded.source;
    this.readOnly = loaded.readOnly; // storage unavailable, or written by a newer build: keep in memory, do not overwrite
    this._listeners = new Map();
    this._processed = new Set(); // match keys already turned into XP (a result is only ever counted once)
    this._saveTimer = null;
    this._dirty = false;
    if (loaded.source === 'recovered' && storage) {
      try { storage.setItem(`${STORAGE_KEY}.corrupt`, loaded.corruptText); } catch { /* best effort */ }
    }
    if ((loaded.source !== 'stored' || loaded.migrated) && !this.readOnly) this._save(); // first run / recovery / one-time migration: write once
  }

  // --- events ('change' | 'levelup') -------------------------------------------------------------------
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event).delete(fn);
  }
  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error('profile listener failed', err); } // one bad listener must not break progression
    }
  }

  // --- persistence (coalesced: never per frame / per tick) ----------------------------------------------
  _touch() {
    this.data.updatedAt = this.now();
    this._dirty = true;
    if (this.readOnly) return;
    if (this._saveTimer == null) this._saveTimer = this._schedule(() => this.flush(), SAVE_DEBOUNCE_MS);
  }
  _save() {
    this._dirty = false;
    return saveProfile(this.storage, this.data);
  }
  flush() {
    if (this._saveTimer != null) { this._cancel(this._saveTimer); this._saveTimer = null; }
    if (this._dirty && !this.readOnly) return this._save();
    return true;
  }

  // --- read side -----------------------------------------------------------------------------------------
  get nickname() { return this.data.nickname; }
  get xp() { return this.data.xp; }
  get level() { return this.data.level; }
  get stats() { return this.data.stats; }
  get selectedSkin() { return this.data.selectedSkin; }

  levelInfo() {
    const xp = this.data.xp;
    return {
      level: this.data.level,
      xp,
      into: getXPIntoCurrentLevel(xp),
      span: getXPRequiredForNextLevel(xp),
      remaining: Math.max(0, getXPRequiredForNextLevel(xp) - getXPIntoCurrentLevel(xp)),
      progress: getLevelProgress(xp),
      atCap: this.data.level >= MAX_LEVEL,
    };
  }

  // { unlocked, unlockLevel } for one skin (used by every skin picker)
  skinStatus(skinId) {
    return { unlocked: this.data.unlockedSkins.includes(skinId), unlockLevel: getUnlockLevel(skinId) };
  }
  isSkinUnlocked(skinId) { return this.data.unlockedSkins.includes(skinId); }

  // The most recently unlocked skin, while it is still "new" (for the profile highlight).
  recentUnlock() {
    const r = this.data.recentUnlock;
    if (!r || this.now() - r.at > RECENT_UNLOCK_MS) return null;
    return r.skinId;
  }

  // --- nickname -------------------------------------------------------------------------------------------
  // -> { ok, value, error, changed }
  setNickname(raw) {
    const res = validateNickname(raw);
    if (!res.ok) return res;
    if (res.value !== this.data.nickname) {
      this.data.nickname = res.value;
      this._touch();
      this._emit('change', { what: 'nickname' });
    }
    return res;
  }

  // --- skins ------------------------------------------------------------------------------------------------
  // Locked or unknown skins cannot be selected. -> true when the selection is (now) that skin.
  selectSkin(skinId) {
    if (!KNOWN_SKINS.includes(skinId) || !this.isSkinUnlocked(skinId)) return false;
    if (this.data.selectedSkin !== skinId) {
      this.data.selectedSkin = skinId;
      this._touch();
      this._emit('change', { what: 'skin' });
    }
    return true;
  }

  // --- XP -----------------------------------------------------------------------------------------------------
  // The one place XP is added. Returns null for an invalid amount, otherwise
  // { gained, xpBefore, xpAfter, levelBefore, levelAfter, levelsGained: [n, ...], unlocked: [{ skinId, level }] }
  addXP(amount, reason = 'other') {
    const n = Math.floor(Number(amount));
    if (!Number.isFinite(n) || n <= 0) return null;
    const gained = Math.min(n, REWARDS.maxSingleGrant);
    const xpBefore = this.data.xp;
    const levelBefore = this.data.level;
    const xpAfter = Math.min(xpBefore + gained, getXPForLevel(MAX_LEVEL));
    const levelAfter = getLevelFromXP(xpAfter);
    this.data.xp = xpAfter;
    this.data.level = levelAfter;

    const levelsGained = [];
    for (let l = levelBefore + 1; l <= levelAfter; l++) levelsGained.push(l);
    const unlocked = [];
    for (const skin of SKINS) {
      const need = getUnlockLevel(skin.id);
      if (need <= levelAfter && !this.data.unlockedSkins.includes(skin.id)) {
        this.data.unlockedSkins.push(skin.id);
        unlocked.push({ skinId: skin.id, level: need });
      }
    }
    if (unlocked.length) {
      const last = unlocked[unlocked.length - 1];
      this.data.recentUnlock = { skinId: last.skinId, at: this.now() };
    }
    this._touch();
    const result = { gained: xpAfter - xpBefore, reason, xpBefore, xpAfter, levelBefore, levelAfter, levelsGained, unlocked };
    this._emit('change', { what: 'xp', result });
    if (levelsGained.length) this._emit('levelup', result);
    return result;
  }

  // --- match results ---------------------------------------------------------------------------------------------
  // result: { key, mode: 'single' | 'multiplayer', victory, survived, score, length, kills, food, playSeconds }
  // `key` identifies THE match; a result whose key was already applied is ignored, so reconnects,
  // duplicate messages or a re-rendered results screen can never pay out twice.
  // Returns null (duplicate / invalid) or { rewards, xp, newHighScore, newLongest } where `xp` is addXP's result.
  applyMatchResult(result) {
    if (!result || typeof result.key !== 'string' || !result.key) return null;
    if (result.mode !== 'single' && result.mode !== 'multiplayer') return null;
    if (this._processed.has(result.key)) return null;
    this._processed.add(result.key);
    if (this._processed.size > MAX_PROCESSED_KEYS) this._processed.delete(this._processed.values().next().value);

    const r = {
      mode: result.mode,
      victory: result.victory === true,
      survived: result.survived === true,
      score: int(result.score),
      length: int(result.length),
      kills: int(result.kills),
      food: int(result.food),
      powerups: int(result.powerups),
      mega: int(result.mega),
      playSeconds: int(result.playSeconds, MAX_PLAY_SECONDS),
    };
    const s = this.data.stats;
    const previousHigh = s.highestScore;
    const previousLongest = s.longestSnake;
    const rewards = computeMatchRewards(r, previousHigh);

    s.gamesPlayed += 1;
    if (r.victory) s.gamesWon += 1;
    s.kills += r.kills;
    s.foodEaten += r.food;
    s.highestScore = Math.max(s.highestScore, r.score);
    s.longestSnake = Math.max(s.longestSnake, r.length);
    s.totalPlayTime += r.playSeconds;
    s.powerupsCollected += r.powerups;
    s.megaFoodCollected += r.mega;
    if (r.mode === 'multiplayer') {
      s.multiplayerGames += 1;
      if (r.victory) s.multiplayerWins += 1;
    }
    this._touch();
    const xp = this.addXP(rewards.total, `match:${r.mode}`);
    this._emit('change', { what: 'stats' });
    this.flush(); // a finished match is a meaningful event: write it now rather than wait for the debounce
    return { rewards, xp, newHighScore: r.score > previousHigh && r.score >= REWARDS.highScoreMinimum, newLongest: r.length > previousLongest };
  }
}

// The single shared instance. (Tests construct their own with a fake storage.)
let shared = null;
export function getProfile() {
  if (!shared) shared = new Profile();
  return shared;
}
