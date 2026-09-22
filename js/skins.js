// Player-selectable visual skins. Each skin is a full "real snake" identity
// rather than a flat color: a base scale color + a darker shade for scale
// texture, an accent pair for its signature markings/eyes, a pattern type
// (drawn by js/snakeRender.js), how often that pattern repeats down the
// body, an optional glow amount, and a bright "ui" color used for HUD chrome
// (the YOU badge, kill-feedback particles) where a legible accent is needed.
export const SKINS = [
  {
    id: 'classic',
    name: 'Classic Venom',
    emoji: '🐍',
    base: '#2f7d3f',
    baseShade: '#1c4d26',
    accent: '#e8c34a',
    accent2: '#141414',
    pattern: 'diamond',
    patternPeriod: 3,
    glow: 0,
    ui: '#e8c34a',
  },
  {
    id: 'inferno',
    name: 'Inferno',
    emoji: '🔥',
    base: '#241014',
    baseShade: '#130a0c',
    accent: '#ff5a1f',
    accent2: '#ff1f3d',
    pattern: 'crack',
    patternPeriod: 2,
    glow: 9,
    ui: '#ff5a1f',
  },
  {
    id: 'frost',
    name: 'Frost',
    emoji: '❄️',
    base: '#bfe4f5',
    baseShade: '#8fc7e0',
    accent: '#ffffff',
    accent2: '#5fd0ff',
    pattern: 'crystal',
    patternPeriod: 3,
    glow: 7,
    ui: '#5fd0ff',
  },
  {
    id: 'toxic',
    name: 'Toxic',
    emoji: '☠️',
    base: '#16241a',
    baseShade: '#0c160f',
    accent: '#aaff1f',
    accent2: '#39ff88',
    pattern: 'toxic',
    patternPeriod: 2,
    glow: 10,
    ui: '#aaff1f',
  },
  {
    id: 'cosmic',
    name: 'Cosmic',
    emoji: '🌌',
    base: '#241a3d',
    baseShade: '#140f26',
    accent: '#c9a6ff',
    accent2: '#6fe0ff',
    pattern: 'stars',
    patternPeriod: 2,
    glow: 6,
    ui: '#c9a6ff',
  },
  {
    id: 'golden',
    name: 'Golden King',
    emoji: '👑',
    base: '#d8a92b',
    baseShade: '#a8791a',
    accent: '#181818',
    accent2: '#fff3c4',
    pattern: 'metallic',
    patternPeriod: 3,
    glow: 5,
    ui: '#e8b923',
  },
  {
    id: 'shadow',
    name: 'Shadow',
    emoji: '🌑',
    base: '#0e0b13',
    baseShade: '#000000',
    accent: '#5a3d8a',
    accent2: '#8a63c4',
    pattern: 'shadow',
    patternPeriod: 3,
    glow: 4,
    ui: '#8a63c4',
  },
  {
    id: 'jungle',
    name: 'Jungle',
    emoji: '🌿',
    base: '#3d5a2c',
    baseShade: '#26391b',
    accent: '#5a3d20',
    accent2: '#233d1a',
    pattern: 'camo',
    patternPeriod: 2,
    glow: 0,
    ui: '#7bbf4a',
  },
];

export const DEFAULT_SKIN_ID = 'classic';

export function getSkinById(id) {
  return SKINS.find((s) => s.id === id) || SKINS.find((s) => s.id === DEFAULT_SKIN_ID);
}

const STORAGE_KEY = 'snakeEatersSkin';

export function loadSavedSkin() {
  try {
    const id = localStorage.getItem(STORAGE_KEY);
    return getSkinById(id);
  } catch {
    return getSkinById(DEFAULT_SKIN_ID);
  }
}

export function saveSkin(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage unavailable (private mode etc.) - selection just won't persist
  }
}
