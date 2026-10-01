// Game Profile: a branding/progression screen for Snake Eaters itself (icon, name, tagline),
// plus the player's overall level progression and how much of the skin collection is unlocked.
// Reuses the same Profile/skin data and the shared skin-picker component as the player Profile
// screen (js/profile/ui.js) - it does not introduce a second level or skin system.
import { SKINS } from '../skins.js';
import { createSkinPicker } from './skinPicker.js';
import { formatNumber } from './ui.js';

const $ = (id) => document.getElementById(id);

export function initGameProfile({ profile, showScreen, applySkin, onPlay, toast }) {
  const el = {
    openBtn: $('gameProfileBtn'),
    screen: $('gameProfileScreen'),
    level: $('gameProfileLevel'),
    fill: $('gameProfileXpFill'),
    xpText: $('gameProfileXpText'),
    xpNext: $('gameProfileXpNext'),
    skinCount: $('gameProfileSkinCount'),
    skinGrid: $('gameProfileSkinGrid'),
    playBtn: $('gameProfilePlayBtn'),
    backBtn: $('gameProfileBackBtn'),
  };

  const onLocked = (skin, level) => {
    if (toast) toast(`${skin.name} unlocks at level ${level}${profile.level < level ? ` - you are level ${profile.level}` : ''}.`);
  };
  const picker = createSkinPicker(el.skinGrid, { profile, onSelect: applySkin, onLocked });

  function renderLevel() {
    const info = profile.levelInfo();
    el.level.textContent = String(info.level);
    el.fill.style.width = `${Math.round(info.progress * 100)}%`;
    el.xpText.textContent = info.atCap ? 'MAX LEVEL' : `${formatNumber(info.into)} / ${formatNumber(info.span)} XP`;
    el.xpNext.textContent = info.atCap ? '' : `${formatNumber(info.remaining)} XP to level ${info.level + 1}`;
  }

  function renderSkinCount() {
    const unlocked = SKINS.filter((s) => profile.isSkinUnlocked(s.id)).length;
    el.skinCount.textContent = `Snakes Collected: ${unlocked} / ${SKINS.length}`;
  }

  function refresh() {
    renderLevel();
    renderSkinCount();
    picker.refresh();
  }
  profile.on('change', refresh);

  function open() {
    refresh();
    showScreen('gameProfile');
  }
  function close() {
    showScreen('start');
  }

  el.openBtn.addEventListener('click', open);
  el.backBtn.addEventListener('click', close);
  el.playBtn.addEventListener('click', () => onPlay());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.screen.classList.contains('hidden')) close();
  });

  refresh();
  return { refresh, open, close };
}
