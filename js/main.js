import { Game } from './game.js';
import { Hud } from './hud.js';
import { InputManager } from './input.js';
import { SKINS, loadSavedSkin, saveSkin } from './skins.js';
import { renderSkinPreview } from './snakeRender.js';
import { NetGame } from './net/netgame.js';
import { initMultiplayer } from './net/mpui.js';

const screens = {
  start: document.getElementById('startScreen'),
  game: document.getElementById('gameScreen'),
  gameover: document.getElementById('gameOverScreen'),
  mpMenu: document.getElementById('mpMenuScreen'),
  lobby: document.getElementById('lobbyScreen'),
  mpResults: document.getElementById('mpResultsScreen'),
};

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('hidden', key !== name);
  }
}

const canvas = document.getElementById('gameCanvas');
const dpad = document.getElementById('dpad');
const pausedOverlay = document.getElementById('pausedOverlay');
const skinPicker = document.getElementById('skinPicker');
const youBadge = document.querySelector('.you-badge');
const youDot = document.querySelector('.you-dot');

const hud = new Hud({
  score: document.getElementById('hudScore'),
  length: document.getElementById('hudLength'),
  eliminations: document.getElementById('hudEliminations'),
  remaining: document.getElementById('hudRemaining'),
  status: document.getElementById('hudStatus'),
  boostBtn: document.getElementById('boostBtn'),
});

const game = new Game(canvas, hud);
// Online multiplayer reuses the same canvas/HUD; `active` decides which one input drives.
const netGame = new NetGame(canvas, hud);
let active = game;

// --- skin selection ---------------------------------------------------

let selectedSkin = loadSavedSkin();

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

function applySkin(skin) {
  selectedSkin = skin;
  saveSkin(skin.id);
  game.setPlayerSkin(skin);
  setYouBadge(skin);
  skinPicker.querySelectorAll('.skin-card').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.skinId === skin.id);
  });
}

for (const skin of SKINS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'skin-card';
  btn.dataset.skinId = skin.id;
  btn.title = skin.name;
  btn.setAttribute('aria-label', skin.name);

  const preview = document.createElement('canvas');
  preview.className = 'skin-preview';
  preview.width = 140;
  preview.height = 100;
  renderSkinPreview(preview, skin);

  const label = document.createElement('span');
  label.className = 'skin-card-name';
  label.textContent = `${skin.emoji} ${skin.name}`;

  btn.appendChild(preview);
  btn.appendChild(label);
  btn.addEventListener('click', () => applySkin(skin));
  skinPicker.appendChild(btn);
}
applySkin(selectedSkin);

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

game.onGameOver = (result) => {
  document.getElementById('gameOverTitle').textContent = result.victory ? 'Victory!' : 'Game Over';
  document.getElementById('finalScore').textContent = result.score;
  document.getElementById('finalLength').textContent = result.length;
  document.getElementById('finalEliminations').textContent = result.eliminations;
  showScreen('gameover');
};

function beginRun() {
  active = game;
  pausedOverlay.classList.add('hidden');
  game.setPlayerSkin(selectedSkin);
  setYouBadge(selectedSkin);
  showScreen('game');
  game.restart();
}

document.getElementById('playBtn').addEventListener('click', beginRun);
document.getElementById('restartBtn').addEventListener('click', beginRun);
document.getElementById('pauseBtn').addEventListener('click', () => (active === game ? togglePause() : netGame.togglePause()));
document.getElementById('boostBtn').addEventListener('click', triggerBoost);

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
});

showScreen('start');
