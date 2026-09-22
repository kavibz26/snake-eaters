import { Game } from './game.js';
import { Hud } from './hud.js';
import { InputManager } from './input.js';
import { SKINS, loadSavedSkin, saveSkin } from './skins.js';
import { renderSkinPreview } from './snakeRender.js';

const screens = {
  start: document.getElementById('startScreen'),
  game: document.getElementById('gameScreen'),
  gameover: document.getElementById('gameOverScreen'),
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

// --- skin selection ---------------------------------------------------

let selectedSkin = loadSavedSkin();

function applySkin(skin) {
  selectedSkin = skin;
  saveSkin(skin.id);
  game.setPlayerSkin(skin);
  youBadge.textContent = '';
  youBadge.appendChild(youDot);
  youBadge.append(`You are the ${skin.name} snake`);
  youBadge.style.color = skin.ui;
  youBadge.style.borderColor = skin.ui;
  youBadge.style.background = skin.ui + '1f';
  youDot.style.background = skin.ui;
  youDot.style.boxShadow = `0 0 8px ${skin.ui}`;
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
  game.activateBoost();
}

const input = new InputManager({ canvas, dpad });
input.onDirection = (dir) => game.setPlayerDirection(dir);
input.onPauseToggle = togglePause;
input.onBoost = triggerBoost;
input.onRestart = () => {
  if (game.state === 'gameover') beginRun();
};

// Auto-pause if the tab is backgrounded mid-run, so play never silently
// continues (or the player dies) while they're away.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.state === 'playing') togglePause();
});

game.onGameOver = (result) => {
  document.getElementById('gameOverTitle').textContent = result.victory ? 'Victory!' : 'Game Over';
  document.getElementById('finalScore').textContent = result.score;
  document.getElementById('finalLength').textContent = result.length;
  document.getElementById('finalEliminations').textContent = result.eliminations;
  showScreen('gameover');
};

function beginRun() {
  pausedOverlay.classList.add('hidden');
  game.setPlayerSkin(selectedSkin);
  showScreen('game');
  game.restart();
}

document.getElementById('playBtn').addEventListener('click', beginRun);
document.getElementById('restartBtn').addEventListener('click', beginRun);
document.getElementById('pauseBtn').addEventListener('click', togglePause);
document.getElementById('boostBtn').addEventListener('click', triggerBoost);

showScreen('start');
