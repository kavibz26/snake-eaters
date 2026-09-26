import { Game } from './game.js';
import { Hud } from './hud.js';
import { InputManager } from './input.js';
import { getSkinById } from './skins.js';
import { NetGame } from './net/netgame.js';
import { initMultiplayer } from './net/mpui.js';
import { getProfile } from './profile/profile.js';
import { initProfileUI } from './profile/ui.js';
import { createXpFeed, renderRewards, createLevelUpModal } from './profile/feedback.js';
import { fromSinglePlayer, fromMultiplayer } from './profile/results.js';

const screens = {
  start: document.getElementById('startScreen'),
  game: document.getElementById('gameScreen'),
  gameover: document.getElementById('gameOverScreen'),
  browser: document.getElementById('lobbyBrowserScreen'),
  lobby: document.getElementById('lobbyScreen'),
  mpResults: document.getElementById('mpResultsScreen'),
  profile: document.getElementById('profileScreen'),
};

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('hidden', key !== name);
  }
}

const canvas = document.getElementById('gameCanvas');
const dpad = document.getElementById('dpad');
const pausedOverlay = document.getElementById('pausedOverlay');
const youBadge = document.querySelector('.you-badge');
const youDot = document.querySelector('.you-dot');

const hud = new Hud({
  score: document.getElementById('hudScore'),
  length: document.getElementById('hudLength'),
  eliminations: document.getElementById('hudEliminations'),
  remaining: document.getElementById('hudRemaining'),
  status: document.getElementById('hudStatus'),
  boostBtn: document.getElementById('boostBtn'),
  effects: document.getElementById('fxHud'),
});

const game = new Game(canvas, hud);
// Single player map: Classic by default. A URL parameter (?map=blocks | arena) selects another configured map -
// there is deliberately no map screen yet (see js/maps/maps.js).
game.setMap(new URLSearchParams(location.search).get('map'));
// Online multiplayer reuses the same canvas/HUD; `active` decides which one input drives.
const netGame = new NetGame(canvas, hud);
let active = game;

// --- profile + progression -------------------------------------------------------------------------

const profile = getProfile();
const xpFeed = createXpFeed(document.getElementById('xpFeed'));
const levelUpModal = createLevelUpModal(document.getElementById('levelUpOverlay'));

// Persist on the way out (writes are otherwise debounced and never happen per frame).
window.addEventListener('pagehide', () => profile.flush());
document.addEventListener('visibilitychange', () => { if (document.hidden) profile.flush(); });

// --- skin selection ---------------------------------------------------

let selectedSkin = getSkinById(profile.selectedSkin);

function setYouBadge(skin) {
  youBadge.textContent = '';
  youBadge.appendChild(youDot);
  youBadge.append(`You are the ${skin.name} snake`);
  youBadge.style.color = skin.ui;
  youBadge.style.borderColor = skin.ui;
  youBadge.style.background = skin.ui + '1f';
  youDot.style.background = skin.ui;
  youDot.style.boxShadow = `0 0 8px ${skin.ui}`;
}

// Only skins the player has unlocked can be applied; the profile refuses the rest.
function applySkin(skin) {
  if (!profile.selectSkin(skin.id)) return;
  selectedSkin = skin;
  game.setPlayerSkin(skin);
  setYouBadge(skin);
}

initProfileUI({ profile, showScreen, applySkin });
game.setPlayerSkin(selectedSkin);
setYouBadge(selectedSkin);

// --- controls -----------------------------------------------------------

function togglePause() {
  if (game.state !== 'playing' && game.state !== 'paused') return;
  game.togglePause();
  pausedOverlay.classList.toggle('hidden', game.state !== 'paused');
}

function triggerBoost() {
  active.activateBoost();
}

const input = new InputManager({ canvas, dpad, swipeArea: document.querySelector('.arena-wrap') });
input.onDirection = (dir) => active.setPlayerDirection(dir);
// Space pauses single-player only; in multiplayer there is no pause (the pause button asks to leave instead).
input.onPauseToggle = () => { if (active === game) togglePause(); };
input.onBoost = triggerBoost;
input.onRestart = () => {
  if (game.state === 'gameover') beginRun();
};

// Auto-pause if the tab is backgrounded mid-run, so play never silently
// continues (or the player dies) while they're away.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && active === game && game.state === 'playing') togglePause();
});

// --- single player: run lifecycle + rewards --------------------------------------------------------------
// Each run gets a key; its result is turned into XP once (the key is cleared as it is consumed,
// and the profile also ignores a key it has already seen).
let runKey = null;
let runCounter = 0;

game.onPlayerEvent = (kind) => xpFeed.event(kind);

game.onGameOver = (result) => {
  document.getElementById('gameOverTitle').textContent = result.victory ? 'Victory!' : 'Game Over';
  document.getElementById('finalScore').textContent = result.score;
  document.getElementById('finalLength').textContent = result.length;
  document.getElementById('finalEliminations').textContent = result.eliminations;
  xpFeed.clear();

  const key = runKey;
  runKey = null;
  const summary = key ? profile.applyMatchResult(fromSinglePlayer(result, key)) : null;
  if (key) renderRewards(document.getElementById('spRewards'), summary); // a repeated callback leaves the panel as it is
  showScreen('gameover');
  // A single-player run is over, so a blocking level-up dialog cannot interrupt anything.
  if (summary && summary.xp) levelUpModal.show(summary.xp);
};

function beginRun() {
  levelUpModal.close(); // e.g. R pressed while the level-up dialog is still up
  active = game;
  pausedOverlay.classList.add('hidden');
  game.setPlayerSkin(selectedSkin);
  setYouBadge(selectedSkin);
  runKey = `sp:${++runCounter}:${Date.now()}`;
  xpFeed.reset('single');
  document.getElementById('spRewards').classList.add('hidden');
  showScreen('game');
  game.restart();
}

document.getElementById('playBtn').addEventListener('click', beginRun);
document.getElementById('restartBtn').addEventListener('click', beginRun);
document.getElementById('gameOverMenuBtn').addEventListener('click', () => { levelUpModal.close(); showScreen('start'); });
document.getElementById('pauseBtn').addEventListener('click', () => (active === game ? togglePause() : netGame.togglePause()));
document.getElementById('boostBtn').addEventListener('click', triggerBoost);

// --- multiplayer <-> profile ---------------------------------------------------------------------------------
// The client never reports anything. Rewards are computed from the server's own `over` message, for a
// match this client actually saw start, exactly once (a reconnect resumes the SAME match key).
let mpKey = null;
let mpStartedAt = 0;
let mpCounter = 0;
netGame.onPlayerEvent = (kind) => xpFeed.event(kind);

const progress = {
  nickname: () => profile.nickname,
  setNickname: (raw) => profile.setNickname(raw),
  onMatchStart(msg) {
    if (msg.resumed && mpKey) return; // reconnected into the same match: same key, same start time
    mpKey = `mp:${++mpCounter}:${Date.now()}`;
    mpStartedAt = performance.now() + (msg.startsInMs || 0);
    xpFeed.reset('multiplayer');
    renderRewards(document.getElementById('mpRewards'), null); // hide the previous match's rewards
  },
  onMatchOver(msg, myId) {
    xpFeed.clear();
    const key = mpKey;
    mpKey = null; // consumed: a second `over` for the same match cannot pay out again
    if (!key) return; // duplicate / unknown match: nothing to reward and the shown rewards stay untouched
    const seconds = Math.max(0, Math.round((performance.now() - mpStartedAt) / 1000));
    const result = fromMultiplayer(msg, myId, key, seconds);
    const summary = result ? profile.applyMatchResult(result) : null;
    // Multiplayer never shows a blocking dialog: the level-up is an inline, non-blocking card.
    renderRewards(document.getElementById('mpRewards'), summary, { inlineLevelUp: true });
  },
};

initMultiplayer({
  showScreen,
  netGame,
  getSelectedSkin: () => selectedSkin,
  activate: () => {
    active = netGame;
    pausedOverlay.classList.add('hidden');
  },
  deactivate: () => {
    active = game;
  },
  setYouBadge,
  progress,
});

showScreen('start');
