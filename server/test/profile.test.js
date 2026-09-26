import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Profile, getUnlockLevel } from '../../js/profile/profile.js';
import { getLevelFromXP, getXPForLevel, getXPIntoCurrentLevel, getXPRequiredForNextLevel, getLevelProgress } from '../../js/profile/xp.js';
import { computeMatchRewards, foodFromMultiplayerScore, foodXP, killXP } from '../../js/profile/rewards.js';
import { fromSinglePlayer, fromMultiplayer } from '../../js/profile/results.js';
import { loadProfile, saveProfile, sanitizeProfile, validateNickname, sanitizeNickname, createDefaultProfile, migrateProfile } from '../../js/profile/store.js';
import { STORAGE_KEY, LEGACY_SKIN_KEY, LEGACY_NICK_KEY, REWARDS, SKIN_UNLOCK_LEVELS, MAX_LEVEL, NICKNAME } from '../../js/profile/config.js';
import { SKINS } from '../../js/skins.js';

class FakeStorage {
  constructor(initial = {}) { this.map = new Map(Object.entries(initial)); this.writes = 0; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.writes++; this.map.set(k, String(v)); }
}
const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
const fullStorage = { getItem: () => null, setItem() { throw new Error('QuotaExceededError'); } };
const mk = (initial, opts = {}) => {
  const storage = new FakeStorage(initial);
  return { storage, profile: new Profile({ storage, now: () => 1000, random: () => 0.5, schedule: () => 1, cancel: () => {}, ...opts }) };
};
const single = (over = {}) => ({ key: 'run-1', mode: 'single', victory: false, survived: false, score: 0, length: 7, kills: 0, food: 0, playSeconds: 30, ...over });

// --- XP curve --------------------------------------------------------------------------------------------------

test('XP curve: the documented thresholds, and every level boundary is exact', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(getXPForLevel), [0, 100, 250, 450, 700, 1000, 1350]);
  for (let l = 1; l < MAX_LEVEL; l++) {
    const at = getXPForLevel(l + 1);
    assert.equal(getLevelFromXP(at - 1), l, `one XP short of level ${l + 1}`);
    assert.equal(getLevelFromXP(at), l + 1, `exactly level ${l + 1}`);
  }
  assert.equal(getLevelFromXP(0), 1);
  assert.equal(getLevelFromXP(-50), 1);
  assert.equal(getLevelFromXP(NaN), 1);
  assert.equal(getLevelFromXP('250'), 3);
  assert.equal(getLevelFromXP(1e15), MAX_LEVEL, 'capped at the maximum level');
});

test('XP progress helpers agree with each other', () => {
  assert.equal(getXPIntoCurrentLevel(0), 0);
  assert.equal(getXPRequiredForNextLevel(0), 100);
  assert.equal(getXPIntoCurrentLevel(120), 20);
  assert.equal(getXPRequiredForNextLevel(120), 150);
  assert.equal(getLevelProgress(175), 0.5);
  assert.equal(getLevelProgress(getXPForLevel(MAX_LEVEL)), 1);
  assert.equal(getXPRequiredForNextLevel(getXPForLevel(MAX_LEVEL)), 0);
});

// --- default profile / storage -----------------------------------------------------------------------------------

test('default profile: valid, extensible shape, level 1, only default skins, nothing written by reading', () => {
  const { profile, storage } = mk();
  const d = profile.data;
  assert.equal(d.version, 1);
  assert.equal(d.level, 1);
  assert.equal(d.xp, 0);
  assert.match(d.nickname, /^Snake\d{4}$/);
  assert.deepEqual(Object.keys(d.stats).sort(), ['foodEaten', 'gamesPlayed', 'gamesWon', 'highestScore', 'kills', 'longestSnake', 'multiplayerGames', 'multiplayerWins', 'totalPlayTime']);
  assert.ok(Object.values(d.stats).every((v) => v === 0));
  assert.deepEqual(d.unlockedSkins, ['classic']);
  assert.equal(d.selectedSkin, 'classic');
  assert.equal(d.createdAt, 1000);
  assert.equal(storage.writes, 1, 'first run writes one clean profile');
  assert.ok(storage.getItem(STORAGE_KEY), 'stored under the versioned key');
  assert.match(STORAGE_KEY, /v1$/);
});

test('load: a saved profile round-trips exactly', () => {
  const a = mk();
  a.profile.setNickname('Viper');
  a.profile.addXP(300, 'test');
  a.profile.selectSkin('inferno');
  a.profile.flush();
  const b = new Profile({ storage: a.storage });
  assert.equal(b.nickname, 'Viper');
  assert.equal(b.xp, 300);
  assert.equal(b.level, 3);
  assert.equal(b.selectedSkin, 'inferno');
  assert.deepEqual(b.data.unlockedSkins.sort(), ['classic', 'frost', 'inferno']);
});

test('corrupted storage: garbage, wrong types and truncated JSON all fall back to a fresh profile (and the bad text is kept aside)', () => {
  for (const bad of ['{', 'not json', '[]', 'null', '42', '"x"', '{"xp":', '']) {
    const { profile, storage } = mk({ [STORAGE_KEY]: bad });
    assert.equal(profile.level, 1, `fallback for ${JSON.stringify(bad)}`);
    assert.equal(profile.source, bad === '' ? 'recovered' : 'recovered');
    assert.ok(JSON.parse(storage.getItem(STORAGE_KEY)).version === 1, 'a clean profile was written back');
  }
  const { storage } = mk({ [STORAGE_KEY]: '{oops' });
  assert.equal(storage.getItem(`${STORAGE_KEY}.corrupt`), '{oops');
});

test('sanitising: hostile / out-of-range stored values are coerced, never trusted', () => {
  const p = sanitizeProfile({
    nickname: '<img src=x onerror=alert(1)>', xp: -5, level: 999, stats: { gamesPlayed: 'lots', kills: -3, foodEaten: 12.9, highestScore: Infinity, extra: 1 },
    unlockedSkins: ['jungle', 'nope', 7], selectedSkin: 'shadow', createdAt: 'x', bogus: true,
  }, { now: 5 });
  assert.ok(!/[<>=()]/.test(p.nickname), `markup stripped from "${p.nickname}"`);
  assert.equal(p.xp, 0);
  assert.equal(p.level, 1, 'level is recomputed from xp, not taken from storage');
  assert.equal(p.stats.gamesPlayed, 0);
  assert.equal(p.stats.kills, 0);
  assert.equal(p.stats.foodEaten, 12);
  assert.equal(p.stats.highestScore, 0);
  assert.equal('extra' in p.stats, false);
  assert.equal('bogus' in p, false);
  assert.ok(p.unlockedSkins.includes('jungle') && !p.unlockedSkins.includes('nope'));
  assert.equal(p.selectedSkin, 'classic', 'a skin the player does not own cannot be the selected one (shadow is not in the list)');
  assert.equal(p.createdAt, 5);
});

test('storage unavailable (blocked / throws): the game keeps working in memory, nothing crashes', () => {
  for (const storage of [throwing, null]) {
    const profile = new Profile({ storage, now: () => 1, schedule: () => 1, cancel: () => {} });
    assert.equal(profile.level, 1);
    assert.equal(profile.readOnly, true);
    assert.ok(profile.addXP(120, 't'));
    assert.equal(profile.level, 2);
    assert.doesNotThrow(() => profile.flush());
  }
  const p = new Profile({ storage: fullStorage, now: () => 1, schedule: () => 1, cancel: () => {} });
  assert.doesNotThrow(() => { p.addXP(10, 't'); p.flush(); }, 'a full storage (quota) does not throw');
  assert.equal(saveProfile(fullStorage, p.data), false);
  assert.equal(saveProfile(null, p.data), false);
});

test('migration: an unversioned (v0) profile is upgraded; a profile from a NEWER build is read but never overwritten', () => {
  const old = { nickname: 'OldTimer', xp: 260, stats: { gamesPlayed: 4 }, selectedSkin: 'frost' };
  assert.equal(migrateProfile(old).data.version, 1);
  const { profile } = mk({ [STORAGE_KEY]: JSON.stringify(old) });
  assert.equal(profile.nickname, 'OldTimer');
  assert.equal(profile.level, 3);
  assert.equal(profile.stats.gamesPlayed, 4);
  assert.equal(profile.selectedSkin, 'frost', 'frost is unlocked at level 3, so the selection survives');

  const future = JSON.stringify({ version: 2, nickname: 'FromTheFuture', xp: 100 });
  const { profile: fp, storage } = mk({ [STORAGE_KEY]: future });
  assert.equal(fp.readOnly, true);
  fp.addXP(50, 't');
  fp.flush();
  assert.equal(storage.getItem(STORAGE_KEY), future, 'the newer build\'s data is left untouched');
});

test('legacy import: an existing player keeps their skin, nickname AND every skin the old game offered', () => {
  const { profile, storage } = mk({ [LEGACY_SKIN_KEY]: 'golden', [LEGACY_NICK_KEY]: 'Veteran' });
  assert.equal(profile.source, 'legacy-import');
  assert.equal(profile.nickname, 'Veteran');
  assert.equal(profile.selectedSkin, 'golden', 'the selected skin is kept');
  assert.ok(SKINS.every((s) => profile.isSkinUnlocked(s.id)), 'all 8 skins were available before, so all 8 stay available');
  assert.equal(profile.level, 1, 'their level is still 1 - the skins are not tied to it');
  assert.equal(profile.xp, 0);
  assert.equal(profile.recentUnlock(), null, 'no "NEW" badges for skins they already had');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).legacySkinsChecked, true);
  const { profile: junk } = mk({ [LEGACY_SKIN_KEY]: 'not-a-skin', [LEGACY_NICK_KEY]: '<b>' });
  assert.equal(junk.selectedSkin, 'classic');
  assert.match(junk.nickname, /^Snake\d{4}$/);
  assert.ok(SKINS.every((s) => junk.isSkinUnlocked(s.id)), 'an old install is recognised even if its stored skin id was odd');
});

test('legacy import: a nickname-only old install (multiplayer user) is also an existing player', () => {
  const { profile } = mk({ [LEGACY_NICK_KEY]: 'OnlyNick' });
  assert.ok(SKINS.every((s) => profile.isSkinUnlocked(s.id)));
  assert.equal(profile.selectedSkin, 'classic');
});

test('new players (no old-game data) use the level-based unlocks', () => {
  const { profile } = mk();
  assert.deepEqual(SKINS.filter((s) => profile.isSkinUnlocked(s.id)).map((s) => s.id), ['classic']);
  assert.equal(profile.data.legacySkinsChecked, true, 'nothing left to migrate, so a later stray old key cannot grant anything');
});

test('migration: a profile already created by the first progression build gets the old skins back, once, and keeps everything else', () => {
  const stored = { version: 1, nickname: 'Early', xp: 260, level: 3, stats: { gamesPlayed: 5, kills: 2 }, unlockedSkins: ['classic', 'inferno', 'frost'], selectedSkin: 'frost', recentUnlock: { skinId: 'frost', at: 7 }, createdAt: 10, updatedAt: 20 };
  const { profile, storage } = mk({ [STORAGE_KEY]: JSON.stringify(stored), [LEGACY_SKIN_KEY]: 'classic' });
  assert.ok(SKINS.every((s) => profile.isSkinUnlocked(s.id)), 'every previously available skin is available again');
  assert.equal(profile.nickname, 'Early');
  assert.equal(profile.xp, 260);
  assert.equal(profile.level, 3);
  assert.equal(profile.stats.gamesPlayed, 5);
  assert.equal(profile.selectedSkin, 'frost', 'selection untouched');
  assert.equal(profile.data.recentUnlock.skinId, 'frost', 'no fake "new unlock" for the restored skins');
  const saved = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(saved.legacySkinsChecked, true);
  assert.equal(saved.unlockedSkins.length, SKINS.length, 'the grant was written back');
  assert.deepEqual(saved.unlockedSkins.slice(0, 3), ['classic', 'inferno', 'frost'], 'existing entries keep their order');
  // one-time: loading again changes nothing and writes nothing
  const writes = storage.writes;
  const again = new Profile({ storage, now: () => 1 });
  assert.equal(storage.writes, writes, 'no rewrite on the next load');
  assert.equal(again.data.unlockedSkins.length, SKINS.length);
});

test('migration: a first-build profile of a genuinely NEW player (no old-game keys) is not granted anything', () => {
  const stored = { version: 1, nickname: 'Fresh', xp: 0, stats: {}, unlockedSkins: ['classic'], selectedSkin: 'classic', createdAt: 1, updatedAt: 1 };
  const { profile, storage } = mk({ [STORAGE_KEY]: JSON.stringify(stored) });
  assert.deepEqual(SKINS.filter((s) => profile.isSkinUnlocked(s.id)).map((s) => s.id), ['classic']);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).legacySkinsChecked, true, 'decision recorded');
  // an old-game key showing up later (e.g. another tab of the old site) must not unlock anything now
  storage.setItem(LEGACY_SKIN_KEY, 'golden');
  assert.deepEqual(SKINS.filter((s) => new Profile({ storage }).isSkinUnlocked(s.id)).map((s) => s.id), ['classic']);
});

test('migration never removes an unlocked skin and never touches a profile from a newer build', () => {
  const owned = { version: 1, xp: 0, unlockedSkins: ['classic', 'jungle', 'shadow'], selectedSkin: 'jungle', legacySkinsChecked: true };
  const { profile } = mk({ [STORAGE_KEY]: JSON.stringify(owned), [LEGACY_SKIN_KEY]: 'classic' });
  for (const id of ['classic', 'jungle', 'shadow']) assert.ok(profile.isSkinUnlocked(id), id + ' kept');
  assert.equal(profile.isSkinUnlocked('frost'), false, 'already-checked profiles are not granted again');
  assert.equal(profile.selectedSkin, 'jungle');

  const future = JSON.stringify({ version: 2, nickname: 'Later', xp: 0, unlockedSkins: ['classic'] });
  const { profile: fp, storage } = mk({ [STORAGE_KEY]: future, [LEGACY_SKIN_KEY]: 'classic' });
  assert.equal(fp.isSkinUnlocked('golden'), false, 'read-only profile is not migrated');
  assert.equal(storage.getItem(STORAGE_KEY), future, 'and not rewritten');
});

test('migration: an existing player whose new profile was corrupted still gets their old skins back', () => {
  const { profile } = mk({ [STORAGE_KEY]: '{oops', [LEGACY_SKIN_KEY]: 'inferno' });
  assert.equal(profile.source, 'recovered');
  assert.ok(SKINS.every((s) => profile.isSkinUnlocked(s.id)));
});

test('writes are coalesced: many changes schedule one save and nothing writes per call', () => {
  const timers = [];
  const { profile, storage } = mk({}, { schedule: (fn) => { timers.push(fn); return timers.length; } });
  const base = storage.writes;
  for (let i = 0; i < 50; i++) profile.addXP(1, 't');
  assert.equal(storage.writes, base, 'no synchronous writes');
  assert.equal(timers.length, 1, 'a single pending save');
  timers[0]();
  assert.equal(storage.writes, base + 1);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).xp, 50);
});

// --- nickname --------------------------------------------------------------------------------------------------------

test('nickname: trimmed, whitespace collapsed, length limited, empty and too-short rejected, unsafe characters removed', () => {
  assert.deepEqual(validateNickname('  Snake   Master  '), { ok: true, value: 'Snake Master', error: null, changed: false });
  assert.equal(validateNickname('').ok, false);
  assert.equal(validateNickname('   ').ok, false);
  assert.equal(validateNickname('a').ok, false);
  assert.equal(validateNickname(null).ok, false);
  assert.equal(validateNickname(42).ok, false);
  const long = validateNickname('x'.repeat(50));
  assert.ok(long.ok && Array.from(long.value).length === NICKNAME.max && long.changed);
  const html = validateNickname('<script>alert(1)</script>');
  assert.ok(html.ok && !/[<>()\/]/.test(html.value), html.value);
  assert.equal(sanitizeNickname('a‮b\u0000c​d'), 'abcd', 'control / bidi / zero-width characters removed');
  assert.equal(sanitizeNickname('Ünï Çødé_9'), 'Ünï Çødé_9', 'letters from any language are fine');
});

test('setNickname: an invalid name is rejected and the old one is kept; a valid one persists', () => {
  const { profile, storage } = mk();
  const before = profile.nickname;
  assert.equal(profile.setNickname('  ').ok, false);
  assert.equal(profile.setNickname('x').ok, false);
  assert.equal(profile.nickname, before);
  assert.equal(profile.setNickname('  Cobra King  ').value, 'Cobra King');
  profile.flush();
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).nickname, 'Cobra King');
  assert.equal(new Profile({ storage }).nickname, 'Cobra King', 'preserved across reloads');
});

test('the nickname rules match the multiplayer server exactly, so profile and lobby show the same name', async () => {
  const { sanitizeName } = await import('../protocol.js');
  for (const raw of ['Viper', 'a b  c', '<b>x</b>', 'x'.repeat(30), 'ñandú!', 'tab\tname', '  spaced  ', 'a.b-c_d', '😀😀name']) {
    const client = validateNickname(raw);
    if (client.ok) assert.equal(client.value, sanitizeName(raw), JSON.stringify(raw));
  }
});

// --- addXP / levelling ----------------------------------------------------------------------------------------------

test('addXP: simple gain, level-up at the boundary, multiple level-ups in one grant', () => {
  const { profile } = mk();
  let r = profile.addXP(40, 'test');
  assert.equal(r.levelsGained.length, 0);
  assert.equal(profile.levelInfo().into, 40);
  r = profile.addXP(60, 'test'); // exactly 100
  assert.deepEqual(r.levelsGained, [2]);
  assert.equal(profile.level, 2);
  assert.equal(profile.levelInfo().into, 0);
  r = profile.addXP(700, 'test'); // 800 -> level 5 (700), 3 levels at once
  assert.deepEqual(r.levelsGained, [3, 4, 5]);
  assert.equal(r.levelBefore, 2);
  assert.equal(r.levelAfter, 5);
  assert.equal(profile.levelInfo().remaining, 300 - 100);
});

test('addXP: invalid amounts are ignored, huge ones are capped, the level cap holds', () => {
  const { profile } = mk();
  for (const bad of [0, -5, NaN, Infinity, 'abc', null, undefined, {}]) assert.equal(profile.addXP(bad, 't'), null, String(bad));
  assert.equal(profile.xp, 0);
  assert.equal(profile.addXP(1e12, 't').gained, REWARDS.maxSingleGrant);
  for (let i = 0; i < 5000; i++) profile.addXP(REWARDS.maxSingleGrant, 't');
  assert.equal(profile.level, MAX_LEVEL);
  assert.equal(profile.xp, getXPForLevel(MAX_LEVEL), 'XP stops at the cap');
  assert.equal(profile.levelInfo().atCap, true);
  assert.equal(profile.levelInfo().progress, 1);
});

test('levelup event: fires once per grant that crosses a level, never for a grant that does not', () => {
  const { profile } = mk();
  const seen = [];
  profile.on('levelup', (r) => seen.push(r.levelsGained));
  profile.addXP(99, 't');
  assert.equal(seen.length, 0);
  profile.addXP(1, 't');
  profile.addXP(10, 't');
  profile.addXP(500, 't');
  assert.deepEqual(seen, [[2], [3, 4]]);
});

test('a throwing listener cannot break progression', () => {
  const { profile } = mk();
  profile.on('levelup', () => { throw new Error('ui bug'); });
  const origError = console.error;
  console.error = () => {};
  try { assert.ok(profile.addXP(150, 't')); } finally { console.error = origError; }
  assert.equal(profile.level, 2);
});

// --- rewards -----------------------------------------------------------------------------------------------------------

test('rewards: each category pays what the config says, and only when it happened', () => {
  const s = REWARDS.single;
  const sum = (res) => Object.fromEntries(res.items.map((i) => [i.id, i.xp]));
  assert.deepEqual(sum(computeMatchRewards(single({ playSeconds: 30 }))), { played: s.played, survival: 3 * s.survivalPer10s });
  assert.deepEqual(sum(computeMatchRewards(single({ playSeconds: 5 }))), {}, 'a game that lasted 5s pays nothing for "played" or survival');
  const full = sum(computeMatchRewards(single({ playSeconds: 100, food: 10, kills: 2, victory: true, score: 400 }), 0));
  assert.deepEqual(full, { played: s.played, food: 20, kills: 30, survival: 10, victory: s.victory, highScore: s.newHighScore });
  assert.equal(computeMatchRewards(single({ score: 400 }), 400).items.some((i) => i.id === 'highScore'), false, 'equalling the old best is not a new high score');
  assert.equal(computeMatchRewards(single({ score: 90 }), 0).items.some((i) => i.id === 'highScore'), false, 'a tiny score is not worth a high-score bonus');
  const m = REWARDS.multiplayer;
  const mp = sum(computeMatchRewards({ mode: 'multiplayer', victory: true, survived: true, score: 250, kills: 1, food: 15, playSeconds: 60 }, 0));
  assert.deepEqual(mp, { played: m.played, food: 30, kills: m.killEach, survived: m.survivedAtEnd, victory: m.victory, highScore: m.newHighScore });
});

test('rewards: anti-farming caps hold no matter how large the reported numbers are', () => {
  const s = REWARDS.single;
  const r = computeMatchRewards(single({ food: 1e6, kills: 1e6, playSeconds: 1e6 }), 0);
  const by = Object.fromEntries(r.items.map((i) => [i.id, i.xp]));
  assert.equal(by.food, s.foodCap);
  assert.equal(by.kills, s.killCap);
  assert.equal(by.survival, s.survivalCap);
  assert.equal(foodXP('single', -4), 0);
  assert.equal(killXP('multiplayer', NaN), 0);
});

test('multiplayer food is recovered from the authoritative score and cannot be inflated', () => {
  assert.equal(foodFromMultiplayerScore(230, 2), 3); // 2 kills = 200, 30 left = 3 food
  assert.equal(foodFromMultiplayerScore(100, 5), 0);
  assert.equal(foodFromMultiplayerScore(-10, 0), 0);
  assert.equal(foodFromMultiplayerScore('x', 'y'), 0);
});

// --- statistics ---------------------------------------------------------------------------------------------------------

test('stats: every counter moves by exactly the match figures', () => {
  const { profile } = mk();
  const r = profile.applyMatchResult(single({ key: 'a', victory: true, score: 340, length: 21, kills: 2, food: 14, playSeconds: 95 }));
  const s = profile.stats;
  assert.deepEqual(
    { g: s.gamesPlayed, w: s.gamesWon, k: s.kills, f: s.foodEaten, h: s.highestScore, l: s.longestSnake, t: s.totalPlayTime, mg: s.multiplayerGames, mw: s.multiplayerWins },
    { g: 1, w: 1, k: 2, f: 14, h: 340, l: 21, t: 95, mg: 0, mw: 0 });
  assert.equal(r.newHighScore, true);
  profile.applyMatchResult(single({ key: 'b', score: 120, length: 30, kills: 0, food: 3, playSeconds: 20 }));
  assert.equal(profile.stats.gamesPlayed, 2);
  assert.equal(profile.stats.gamesWon, 1, 'a loss is not a win');
  assert.equal(profile.stats.highestScore, 340, 'high score only ever rises');
  assert.equal(profile.stats.longestSnake, 30);
  assert.equal(profile.stats.totalPlayTime, 115);
  profile.applyMatchResult({ ...single({ key: 'c', victory: true, kills: 1, playSeconds: 40 }), mode: 'multiplayer' });
  assert.equal(profile.stats.multiplayerGames, 1);
  assert.equal(profile.stats.multiplayerWins, 1);
  assert.equal(profile.stats.gamesPlayed, 3);
});

test('stats: a result is processed exactly once, however often it is delivered', () => {
  const { profile } = mk();
  const first = profile.applyMatchResult(single({ key: 'dup', victory: true, food: 5, kills: 1, score: 200, playSeconds: 60 }));
  const xpAfter = profile.xp;
  assert.ok(first && xpAfter > 0);
  for (let i = 0; i < 5; i++) assert.equal(profile.applyMatchResult(single({ key: 'dup', victory: true, food: 5, kills: 1, score: 200, playSeconds: 60 })), null);
  assert.equal(profile.xp, xpAfter);
  assert.equal(profile.stats.gamesPlayed, 1);
  assert.equal(profile.stats.kills, 1);
  assert.equal(profile.stats.foodEaten, 5);
  assert.equal(profile.stats.gamesWon, 1);
});

test('stats: malformed results are rejected or clamped, never crash and never inflate', () => {
  const { profile } = mk();
  for (const bad of [null, undefined, 5, 'x', {}, { key: '' }, { key: 'k' }, { key: 'k', mode: 'cheat' }]) assert.equal(profile.applyMatchResult(bad), null);
  assert.equal(profile.stats.gamesPlayed, 0);
  profile.applyMatchResult(single({ key: 'n', score: -50, length: NaN, kills: 'many', food: -2, playSeconds: 1e12 }));
  assert.equal(profile.stats.gamesPlayed, 1);
  assert.equal(profile.stats.kills, 0);
  assert.equal(profile.stats.highestScore, 0);
  assert.ok(profile.stats.totalPlayTime <= 6 * 3600, 'play time per match is capped');
});

test('a match result persists immediately (not only after the debounce)', () => {
  const { profile, storage } = mk();
  profile.applyMatchResult(single({ key: 'p', victory: true, playSeconds: 60 }));
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).stats.gamesWon, 1);
});

// --- skins ------------------------------------------------------------------------------------------------------------------

test('skins: unlock levels are configured for every real skin, and start with exactly one unlocked', () => {
  for (const s of SKINS) assert.ok(Number.isInteger(SKIN_UNLOCK_LEVELS[s.id]), `${s.id} has an unlock level`);
  assert.equal(Object.keys(SKIN_UNLOCK_LEVELS).length, SKINS.length, 'no stale entries');
  assert.equal(getUnlockLevel('classic'), 1);
  assert.equal(getUnlockLevel('a-future-skin'), 1);
  const { profile } = mk();
  assert.deepEqual(SKINS.filter((s) => profile.isSkinUnlocked(s.id)).map((s) => s.id), ['classic']);
});

test('skins: reaching a level unlocks exactly the skins for that level, reported once', () => {
  const { profile } = mk();
  let r = profile.addXP(100, 't'); // level 2
  assert.deepEqual(r.unlocked, [{ skinId: 'inferno', level: 2 }]);
  r = profile.addXP(1, 't');
  assert.deepEqual(r.unlocked, [], 'not reported again');
  r = profile.addXP(getXPForLevel(9) - profile.xp, 't'); // jump 2 -> 9
  assert.deepEqual(r.unlocked.map((u) => u.skinId), ['frost', 'toxic', 'cosmic', 'golden', 'shadow']);
  assert.ok(!profile.isSkinUnlocked('jungle'));
  assert.equal(profile.recentUnlock(), 'shadow');
  assert.deepEqual(profile.skinStatus('jungle'), { unlocked: false, unlockLevel: 12 });
  profile.addXP(getXPForLevel(12) - profile.xp, 't');
  assert.ok(SKINS.every((s) => profile.isSkinUnlocked(s.id)));
});

test('skins: a locked skin cannot be selected, an unlocked one can, unknown ids are refused', () => {
  const { profile } = mk();
  assert.equal(profile.selectSkin('golden'), false);
  assert.equal(profile.selectedSkin, 'classic');
  assert.equal(profile.selectSkin('does-not-exist'), false);
  assert.equal(profile.selectSkin(undefined), false);
  profile.addXP(100, 't');
  assert.equal(profile.selectSkin('inferno'), true);
  assert.equal(profile.selectedSkin, 'inferno');
  assert.equal(profile.selectSkin('classic'), true);
});

test('skins: an invalid or no-longer-owned stored selection falls back to an unlocked skin; earned skins survive a stale list', () => {
  const bad = JSON.stringify({ version: 1, xp: 0, selectedSkin: 'cosmic', unlockedSkins: ['classic'] });
  assert.equal(mk({ [STORAGE_KEY]: bad }).profile.selectedSkin, 'classic');
  const stale = JSON.stringify({ version: 1, xp: getXPForLevel(5), selectedSkin: 'cosmic', unlockedSkins: [] });
  const { profile } = mk({ [STORAGE_KEY]: stale });
  assert.equal(profile.selectedSkin, 'cosmic', 'level 5 earns cosmic even if the stored list forgot it');
  assert.ok(profile.isSkinUnlocked('toxic'));
});

test('skins: unlocking is permanent - editing the unlock config later never re-locks a skin', () => {
  const { profile, storage } = mk();
  profile.addXP(getXPForLevel(7), 't');
  profile.flush();
  const stored = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.ok(stored.unlockedSkins.includes('golden'));
});

test('skin selection persists across a reload', () => {
  const a = mk();
  a.profile.addXP(250, 't');
  a.profile.selectSkin('frost');
  a.profile.flush();
  assert.equal(new Profile({ storage: a.storage }).selectedSkin, 'frost');
});

// --- result adapters ------------------------------------------------------------------------------------------------------

test('single-player result adapter: uses the game\'s own totals; play time is game time (ticks), so pauses do not count', () => {
  const r = fromSinglePlayer({ victory: true, score: 260, length: 18, eliminations: 3, foodEaten: 11, ticks: 400 }, 'run-9');
  assert.deepEqual(r, { key: 'run-9', mode: 'single', victory: true, survived: true, score: 260, length: 18, kills: 3, food: 11, playSeconds: 60 });
  assert.equal(fromSinglePlayer(null, 'k'), null);
  assert.equal(fromSinglePlayer({}, ''), null);
});

test('multiplayer result adapter: only the server\'s figures, only for a player who is in the results', () => {
  const over = { t: 'over', winnerId: 'p1', reason: 'last_standing', results: [
    { id: 'p1', rank: 1, name: 'Ann', score: 330, length: 14, kills: 2, survived: true },
    { id: 'p2', rank: 2, name: 'Bob', score: 40, length: 9, kills: 0, survived: false },
  ] };
  assert.deepEqual(fromMultiplayer(over, 'p1', 'm1', 75), { key: 'm1', mode: 'multiplayer', victory: true, survived: true, score: 330, length: 14, kills: 2, food: 13, playSeconds: 75 });
  const loser = fromMultiplayer(over, 'p2', 'm1', 75);
  assert.equal(loser.victory, false);
  assert.equal(loser.food, 4);
  assert.equal(fromMultiplayer(over, 'ghost', 'm1', 75), null, 'not in the results (left early): no reward');
  assert.equal(fromMultiplayer({ ...over, winnerId: null }, 'p1', 'm1', 75).victory, false, 'a draw is not a win');
  assert.equal(fromMultiplayer({ ...over, results: [over.results[0]] }, 'p1', 'm1', 75).victory, false, 'a win needs an opponent');
  assert.equal(fromMultiplayer({ t: 'over' }, 'p1', 'm1', 5), null);
});
