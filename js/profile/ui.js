// Main-menu profile card + the Profile screen (identity, level, statistics, skins, name editing).
// Everything the player controls is written with textContent - never innerHTML.
import { getSkinById } from '../skins.js';
import { renderSkinPreview } from '../snakeRender.js';
import { NICKNAME } from './config.js';
import { validateNickname } from './store.js';
import { createSkinPicker } from './skinPicker.js';

const $ = (id) => document.getElementById(id);

export function formatNumber(n) {
  const v = Number(n || 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`; // keeps huge values inside their stat cell
  return v.toLocaleString('en-US');
}

// seconds -> "45s" | "12m" | "1h 05m"
export function formatPlayTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h >= 100 ? `${h}h` : `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

const STATS = [
  ['Games', (s) => formatNumber(s.gamesPlayed)],
  ['Wins', (s) => formatNumber(s.gamesWon)],
  ['Kills', (s) => formatNumber(s.kills)],
  ['High score', (s) => formatNumber(s.highestScore)],
  ['Food', (s) => formatNumber(s.foodEaten)],
  ['Longest', (s) => formatNumber(s.longestSnake)],
  ['Play time', (s) => formatPlayTime(s.totalPlayTime)],
  ['Online games', (s) => formatNumber(s.multiplayerGames)],
  ['Online wins', (s) => formatNumber(s.multiplayerWins)],
  ['Power-ups', (s) => formatNumber(s.powerupsCollected)],
  ['Mega food', (s) => formatNumber(s.megaFoodCollected)],
  ['Events', (s) => formatNumber(s.eventsEarned)],
];

export function initProfileUI({ profile, showScreen, applySkin }) {
  const el = {
    card: $('profileCard'), cardName: $('cardName'), cardLevel: $('cardLevel'), cardXp: $('cardXp'), cardFill: $('cardFill'),
    name: $('profileName'), level: $('profileLevel'), fill: $('profileXpFill'), xpText: $('profileXpText'), xpNext: $('profileXpNext'),
    stats: $('profileStats'), skinPreview: $('profileSkinPreview'), skinName: $('profileSkinName'), recent: $('profileRecent'),
    main: $('profileMain'), skinsView: $('profileSkins'), skinGrid: $('profileSkinGrid'),
    actions: $('profileActions'), editBtn: $('profileEditBtn'), skinsBtn: $('profileSkinsBtn'), backBtn: $('profileBackBtn'),
    form: $('profileNameForm'), input: $('profileNameInput'), error: $('profileNameError'), cancel: $('profileNameCancel'),
    skinsBack: $('profileSkinsBack'), toast: $('profileToast'),
  };

  // --- stat cells are built once and only their text changes afterwards -------------------------------------------
  const statValues = STATS.map(([label]) => {
    const cell = document.createElement('div');
    cell.className = 'stat-cell';
    const value = document.createElement('b');
    const name = document.createElement('span');
    name.textContent = label;
    cell.append(value, name);
    el.stats.appendChild(cell);
    return value;
  });

  let toastTimer = null;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2600);
  }
  const onLocked = (skin, level) => toast(`${skin.name} unlocks at level ${level}${profile.level < level ? ` - you are level ${profile.level}` : ''}.`);

  const menuPicker = createSkinPicker($('skinPicker'), { profile, onSelect: applySkin, onLocked });
  const profilePicker = createSkinPicker(el.skinGrid, { profile, onSelect: (skin) => { applySkin(skin); }, onLocked });

  function fillPercent(info) {
    return `${Math.round(info.progress * 100)}%`;
  }

  function renderCard() {
    const info = profile.levelInfo();
    el.cardName.textContent = profile.nickname;
    el.cardLevel.textContent = `Level ${info.level}`;
    el.cardXp.textContent = info.atCap ? 'MAX' : `${formatNumber(info.into)} / ${formatNumber(info.span)} XP`;
    el.cardFill.style.width = fillPercent(info);
  }

  function renderProfile() {
    const info = profile.levelInfo();
    el.name.textContent = profile.nickname;
    el.level.textContent = String(info.level);
    el.fill.style.width = fillPercent(info);
    el.xpText.textContent = info.atCap ? 'MAX LEVEL' : `${formatNumber(info.into)} / ${formatNumber(info.span)} XP`;
    el.xpNext.textContent = info.atCap ? '' : `${formatNumber(info.remaining)} XP to level ${info.level + 1}`;
    const s = profile.stats;
    STATS.forEach(([, get], i) => { statValues[i].textContent = get(s); });
    const skin = getSkinById(profile.selectedSkin);
    renderSkinPreview(el.skinPreview, skin);
    el.skinName.textContent = `${skin.emoji} ${skin.name}`;
    const recent = profile.recentUnlock();
    if (recent) {
      const r = getSkinById(recent);
      el.recent.textContent = `New: ${r.emoji} ${r.name} unlocked`;
      el.recent.classList.remove('hidden');
    } else {
      el.recent.classList.add('hidden');
    }
  }

  function refresh() {
    renderCard();
    menuPicker.refresh();
    profilePicker.refresh();
    if (!$('profileScreen').classList.contains('hidden')) renderProfile();
  }
  profile.on('change', refresh);

  // --- navigation ----------------------------------------------------------------------------------------------------
  function showView(name) {
    el.main.classList.toggle('hidden', name !== 'main');
    el.skinsView.classList.toggle('hidden', name !== 'skins');
    (name === 'main' ? el.editBtn : el.skinsBack).focus({ preventScroll: true });
  }
  function closeNameForm() {
    el.form.classList.add('hidden');
    el.main.classList.remove('is-editing');
    el.actions.classList.remove('hidden');
    el.error.textContent = '';
  }
  function open() {
    closeNameForm();
    showView('main');
    renderProfile();
    showScreen('profile');
  }
  function close() {
    closeNameForm();
    showScreen('start');
  }

  el.card.addEventListener('click', open);
  el.backBtn.addEventListener('click', close);
  el.skinsBtn.addEventListener('click', () => { profilePicker.refresh(); showView('skins'); });
  el.skinsBack.addEventListener('click', () => showView('main'));
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('profileScreen').classList.contains('hidden')) return;
    if (!el.form.classList.contains('hidden')) closeNameForm();
    else if (!el.skinsView.classList.contains('hidden')) showView('main');
    else close();
  });

  // --- name editing ------------------------------------------------------------------------------------------------------
  el.input.maxLength = NICKNAME.max;
  el.editBtn.addEventListener('click', () => {
    el.input.value = profile.nickname;
    el.actions.classList.add('hidden');
    el.main.classList.add('is-editing'); // frees vertical room on small phones
    el.form.classList.remove('hidden');
    el.error.textContent = '';
    el.input.focus();
    el.input.select();
  });
  el.cancel.addEventListener('click', () => { closeNameForm(); el.editBtn.focus({ preventScroll: true }); });
  el.input.addEventListener('input', () => { el.error.textContent = ''; });
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const check = validateNickname(el.input.value);
    if (!check.ok) { el.error.textContent = check.error; el.input.focus(); return; }
    profile.setNickname(check.value); // 'change' -> refresh() repaints the card and the screen
    closeNameForm();
    toast(check.changed ? `Saved as "${check.value}" (some characters are not allowed in names).` : 'Nickname saved.');
    el.editBtn.focus({ preventScroll: true });
  });

  refresh();
  return { refresh, open, close, toast };
}
