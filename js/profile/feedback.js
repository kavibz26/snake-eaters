// Progression feedback: the grouped "+N XP" feed shown during play, the "XP earned" breakdown on
// result screens, and the level-up presentation. DOM only; the numbers arrive already final.
import { getSkinById } from '../skins.js';
import { renderSkinPreview } from '../snakeRender.js';
import { XP_FEED_GROUP_MS } from './config.js';
import { foodXP, killXP, powerupXP, megaXP } from './rewards.js';
import { getLevelProgress } from './xp.js';

const $ = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

// --- live feed --------------------------------------------------------------------------------------------
// PROVISIONAL feedback while playing: the same per-event amounts the final result uses, grouped so
// three foods in a row read "+6 XP · 3 food" instead of three separate pops. The XP that is
// actually added to the profile comes from the final result, exactly once.
export function createXpFeed(root) {
  let mode = 'single';
  let counts = { food: 0, kill: 0, powerup: 0, mega: 0 };
  let group = null; // { xp, food, kill, powerup, mega }
  let hideTimer = null;
  let raf = 0;

  function paint() {
    raf = 0;
    if (!group) return;
    const parts = [];
    if (group.food) parts.push(`${group.food} food`);
    if (group.kill) parts.push(group.kill === 1 ? '1 kill' : `${group.kill} kills`);
    if (group.powerup) parts.push(group.powerup === 1 ? '1 power-up' : `${group.powerup} power-ups`);
    if (group.mega) parts.push(group.mega === 1 ? '1 mega food' : `${group.mega} mega food`);
    root.textContent = '';
    root.append($('span', 'xp-feed-xp', `+${group.xp} XP`), $('span', 'xp-feed-what', parts.join(' · ')));
    root.classList.remove('hidden');
    root.classList.remove('xp-feed--in');
    void root.offsetWidth; // restart the pop animation
    root.classList.add('xp-feed--in');
  }

  return {
    reset(nextMode) {
      mode = nextMode === 'multiplayer' ? 'multiplayer' : 'single';
      counts = { food: 0, kill: 0, powerup: 0, mega: 0 };
      this.clear();
    },
    clear() {
      clearTimeout(hideTimer);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      group = null;
      root.classList.add('hidden');
      root.textContent = '';
    },
    // kind: 'food' | 'kill' | 'powerup' | 'mega'
    event(kind) {
      const xpFor = { food: foodXP, kill: killXP, powerup: powerupXP, mega: megaXP }[kind];
      if (!xpFor) return;
      const before = xpFor(mode, counts[kind]);
      counts[kind]++;
      const after = xpFor(mode, counts[kind]);
      const xp = after - before;
      if (xp <= 0) return; // per-match cap reached: nothing more to show
      group = group || { xp: 0, food: 0, kill: 0, powerup: 0, mega: 0 };
      group.xp += xp;
      group[kind]++;
      if (!raf) raf = requestAnimationFrame(paint); // at most one repaint per frame, however many events
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => this.clear(), XP_FEED_GROUP_MS);
    },
  };
}

// --- "XP earned" breakdown -----------------------------------------------------------------------------------
// summary: what Profile.applyMatchResult returned. `container` is emptied and refilled.
export function renderRewards(container, summary, { inlineLevelUp = false } = {}) {
  container.textContent = '';
  if (!summary) { container.classList.add('hidden'); return; }
  container.classList.remove('hidden');
  const { rewards, xp } = summary;

  const head = $('div', 'rewards-head');
  head.append($('span', 'rewards-title', 'XP earned'), $('b', 'rewards-total', `+${rewards.total}`));
  container.appendChild(head);

  if (!rewards.items.length) {
    container.appendChild($('p', 'rewards-empty', 'No XP this time - survive at least 10 seconds to earn rewards.'));
    return;
  }
  const list = $('ul', 'rewards-list');
  for (const item of rewards.items) {
    const li = $('li');
    li.append($('span', null, item.count ? `${item.label} ×${item.count}` : item.label), $('b', null, `+${item.xp}`));
    list.appendChild(li);
  }
  container.appendChild(list);
  if (summary.newHighScore) container.appendChild($('div', 'rewards-badge', '★ New personal best!'));

  if (xp) {
    const level = $('div', 'rewards-level');
    const bar = $('div', 'xp-bar');
    const fill = $('i');
    bar.appendChild(fill);
    const label = $('span', 'rewards-level-label', `Level ${xp.levelAfter}`);
    level.append(label, bar);
    container.appendChild(level);
    animateBar(fill, xp);
    if (inlineLevelUp && xp.levelsGained.length) container.appendChild(buildLevelUpBanner(xp));
  }
}

const progressAt = getLevelProgress; // 0..1 fill for a total XP

function animateBar(fill, xp) {
  const levelled = xp.levelsGained.length > 0;
  fill.style.transition = 'none';
  fill.style.width = `${Math.round(progressAt(xp.xpBefore) * 100)}%`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fill.style.transition = 'width 0.7s ease-out';
    fill.style.width = levelled ? '100%' : `${Math.round(progressAt(xp.xpAfter) * 100)}%`;
    if (levelled) {
      setTimeout(() => {
        fill.style.transition = 'none';
        fill.style.width = '0%';
        requestAnimationFrame(() => requestAnimationFrame(() => {
          fill.style.transition = 'width 0.5s ease-out';
          fill.style.width = `${Math.round(progressAt(xp.xpAfter) * 100)}%`;
        }));
      }, 760);
    }
  }));
}

// --- level up ------------------------------------------------------------------------------------------------------
function unlockedSkinsBlock(unlocked) {
  const wrap = $('div', 'levelup-skins');
  for (const u of unlocked) {
    const skin = getSkinById(u.skinId);
    const item = $('div', 'levelup-skin');
    const c = $('canvas', 'levelup-skin-preview');
    c.width = 84;
    c.height = 60;
    renderSkinPreview(c, skin);
    item.append(c, $('span', 'levelup-skin-name', `${skin.emoji} ${skin.name}`));
    wrap.appendChild(item);
  }
  return wrap;
}

function levelUpBody(xp) {
  const frag = document.createDocumentFragment();
  frag.appendChild($('div', 'levelup-title', 'LEVEL UP!'));
  frag.appendChild($('div', 'levelup-number', String(xp.levelAfter)));
  if (xp.levelsGained.length > 1) frag.appendChild($('div', 'levelup-sub', `+${xp.levelsGained.length} levels`));
  if (xp.unlocked.length) {
    frag.appendChild($('div', 'levelup-unlock', xp.unlocked.length === 1 ? 'New skin unlocked!' : 'New skins unlocked!'));
    frag.appendChild(unlockedSkinsBlock(xp.unlocked));
  }
  return frag;
}

// Non-blocking version: an inline card (used on the multiplayer results screen).
export function buildLevelUpBanner(xp) {
  const banner = $('div', 'levelup-banner');
  banner.setAttribute('role', 'status');
  banner.appendChild(levelUpBody(xp));
  return banner;
}

// Blocking version: a modal with an OK button (single-player game over / menu, never during a match).
export function createLevelUpModal(overlay) {
  const card = overlay.querySelector('.levelup-card');
  const content = overlay.querySelector('.levelup-content');
  const ok = overlay.querySelector('.levelup-ok');
  let open = false;
  let opener = null;

  function close() {
    if (!open) return;
    open = false;
    overlay.classList.add('hidden');
    if (opener && opener.focus) opener.focus();
  }
  ok.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } });

  return {
    show(xp) {
      if (!xp || !xp.levelsGained.length) return false;
      content.textContent = '';
      content.appendChild(levelUpBody(xp));
      opener = document.activeElement;
      overlay.classList.remove('hidden');
      open = true;
      card.classList.remove('levelup-card--in');
      void card.offsetWidth;
      card.classList.add('levelup-card--in');
      ok.focus();
      return true;
    },
    close,
    get isOpen() { return open; },
  };
}
