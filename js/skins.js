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

  // --- progression skins (Level 1-10 unlock ladder, see js/profile/config.js SKIN_UNLOCK_LEVELS) ---
  // 50 skins, 5 per level, common -> legendary. Reuses the same 8 render patterns above (no new
  // drawing code): rarity reads through colour richness, glow intensity and pattern density
  // (patternPeriod narrows from 3 to 2 as the tier rises), never a gameplay difference.

  // Level 1 - common
  { id: 'neon_lime', name: 'Neon Lime', emoji: '🟢', base: '#3ddc47', baseShade: '#1f8a28', accent: '#eaffb0', accent2: '#0a2e0f', pattern: 'diamond', patternPeriod: 3, glow: 2, ui: '#3ddc47' },
  { id: 'ocean_blue', name: 'Ocean Blue', emoji: '🌊', base: '#1f7bd6', baseShade: '#124a82', accent: '#cdeaff', accent2: '#0e3a5c', pattern: 'crystal', patternPeriod: 3, glow: 2, ui: '#3fa8ff' },
  { id: 'ruby_red', name: 'Ruby Red', emoji: '🔴', base: '#c41f3d', baseShade: '#7a1026', accent: '#ffd0da', accent2: '#4a0512', pattern: 'crack', patternPeriod: 3, glow: 2, ui: '#ff2f55' },
  { id: 'purple_pulse', name: 'Purple Pulse', emoji: '💜', base: '#7b2fe0', baseShade: '#481a8a', accent: '#d9baff', accent2: '#2c0e5c', pattern: 'stars', patternPeriod: 3, glow: 3, ui: '#a35bff' },
  { id: 'arctic_white', name: 'Arctic White', emoji: '⚪', base: '#eef6fb', baseShade: '#c3d8e2', accent: '#ffffff', accent2: '#6fb8dc', pattern: 'metallic', patternPeriod: 3, glow: 1, ui: '#dff1fb' },

  // Level 2 - common+
  { id: 'lava_core', name: 'Lava Core', emoji: '🌋', base: '#2a1008', baseShade: '#160804', accent: '#ff6a00', accent2: '#ffcf3d', pattern: 'crack', patternPeriod: 3, glow: 5, ui: '#ff6a00' },
  { id: 'electric_blue', name: 'Electric Blue', emoji: '🔷', base: '#0a1a33', baseShade: '#050d1a', accent: '#29d3ff', accent2: '#eafcff', pattern: 'crack', patternPeriod: 3, glow: 6, ui: '#29d3ff' },
  { id: 'emerald_venom', name: 'Emerald Venom', emoji: '☣️', base: '#0d3d24', baseShade: '#062015', accent: '#1fffa3', accent2: '#0aff55', pattern: 'toxic', patternPeriod: 3, glow: 5, ui: '#1fffa3' },
  { id: 'pink_plasma', name: 'Pink Plasma', emoji: '🩷', base: '#3d0d2a', baseShade: '#1f0616', accent: '#ff4fc3', accent2: '#ffe0f5', pattern: 'stars', patternPeriod: 3, glow: 6, ui: '#ff4fc3' },
  { id: 'solar_orange', name: 'Solar Orange', emoji: '🟠', base: '#4d2400', baseShade: '#2b1400', accent: '#ffb020', accent2: '#fff3c4', pattern: 'metallic', patternPeriod: 3, glow: 4, ui: '#ffb020' },

  // Level 3 - rare (tech)
  { id: 'cyber_snake', name: 'Cyber Snake', emoji: '🤖', base: '#0a1420', baseShade: '#050a10', accent: '#00fff2', accent2: '#ff00e5', pattern: 'crack', patternPeriod: 2, glow: 7, ui: '#00fff2' },
  { id: 'digital_glitch', name: 'Digital Glitch', emoji: '🟪', base: '#10101a', baseShade: '#08080e', accent: '#ff2079', accent2: '#20ffea', pattern: 'crack', patternPeriod: 2, glow: 7, ui: '#ff2079' },
  { id: 'holographic', name: 'Holographic', emoji: '🔮', base: '#241a33', baseShade: '#140e1f', accent: '#a685ff', accent2: '#6affe0', pattern: 'crystal', patternPeriod: 2, glow: 7, ui: '#c9a6ff' },
  { id: 'chrome', name: 'Chrome', emoji: '⚙️', base: '#b9c2cc', baseShade: '#7a838c', accent: '#ffffff', accent2: '#3a4550', pattern: 'metallic', patternPeriod: 2, glow: 4, ui: '#d8e0e8' },
  { id: 'carbon_fiber', name: 'Carbon Fiber', emoji: '⬛', base: '#17191c', baseShade: '#0a0b0c', accent: '#3d4750', accent2: '#8a97a3', pattern: 'camo', patternPeriod: 2, glow: 2, ui: '#8a97a3' },

  // Level 4 - rare (elemental)
  { id: 'deep_ocean', name: 'Deep Ocean', emoji: '🫧', base: '#052038', baseShade: '#02101c', accent: '#0fd8ff', accent2: '#003a5c', pattern: 'crystal', patternPeriod: 2, glow: 7, ui: '#0fd8ff' },
  { id: 'volcanic_rock', name: 'Volcanic Rock', emoji: '🪨', base: '#1a0d08', baseShade: '#0d0604', accent: '#ff4500', accent2: '#ffae00', pattern: 'crack', patternPeriod: 2, glow: 8, ui: '#ff4500' },
  { id: 'toxic_reactor', name: 'Toxic Reactor', emoji: '☢️', base: '#0d1a05', baseShade: '#060d02', accent: '#c6ff00', accent2: '#00ff66', pattern: 'toxic', patternPeriod: 2, glow: 8, ui: '#c6ff00' },
  { id: 'plasma_storm', name: 'Plasma Storm', emoji: '🌩️', base: '#150633', baseShade: '#0a031a', accent: '#b026ff', accent2: '#26e0ff', pattern: 'crack', patternPeriod: 2, glow: 8, ui: '#b026ff' },
  { id: 'frozen_crystal', name: 'Frozen Crystal', emoji: '🧊', base: '#d0f0ff', baseShade: '#9fd8f0', accent: '#ffffff', accent2: '#4fc3ff', pattern: 'crystal', patternPeriod: 2, glow: 7, ui: '#4fc3ff' },

  // Level 5 - epic (cosmic)
  { id: 'galaxy', name: 'Galaxy', emoji: '🪐', base: '#140a2e', baseShade: '#0a0518', accent: '#8a5cff', accent2: '#ff6ec7', pattern: 'stars', patternPeriod: 2, glow: 7, ui: '#8a5cff' },
  { id: 'nebula', name: 'Nebula', emoji: '🌠', base: '#1f0a3d', baseShade: '#10051f', accent: '#ff8ad1', accent2: '#6ee7ff', pattern: 'stars', patternPeriod: 2, glow: 8, ui: '#ff8ad1' },
  { id: 'starfire', name: 'Starfire', emoji: '🌟', base: '#331a05', baseShade: '#1a0d02', accent: '#ffcf3d', accent2: '#ff6a00', pattern: 'stars', patternPeriod: 2, glow: 8, ui: '#ffcf3d' },
  { id: 'black_hole', name: 'Black Hole', emoji: '⚫', base: '#050505', baseShade: '#000000', accent: '#6a3dff', accent2: '#ffffff', pattern: 'shadow', patternPeriod: 2, glow: 9, ui: '#6a3dff' },
  { id: 'astral', name: 'Astral', emoji: '✨', base: '#0a1433', baseShade: '#05091a', accent: '#7dfcff', accent2: '#d9b3ff', pattern: 'stars', patternPeriod: 2, glow: 8, ui: '#7dfcff' },

  // Level 6 - epic (mythic warriors)
  { id: 'samurai', name: 'Samurai', emoji: '⚔️', base: '#7d0a1a', baseShade: '#400510', accent: '#e8c34a', accent2: '#1a1a1a', pattern: 'diamond', patternPeriod: 2, glow: 4, ui: '#e8c34a' },
  { id: 'ninja', name: 'Ninja', emoji: '🥷', base: '#101010', baseShade: '#050505', accent: '#8a0000', accent2: '#cfcfcf', pattern: 'shadow', patternPeriod: 2, glow: 3, ui: '#cfcfcf' },
  { id: 'dragon', name: 'Dragon', emoji: '🐉', base: '#0a3d1a', baseShade: '#05200d', accent: '#ffcf3d', accent2: '#ff4500', pattern: 'crack', patternPeriod: 2, glow: 7, ui: '#ff8a00' },
  { id: 'phoenix', name: 'Phoenix', emoji: '🦅', base: '#3d0a05', baseShade: '#1f0502', accent: '#ff8a00', accent2: '#ffe066', pattern: 'crack', patternPeriod: 2, glow: 9, ui: '#ff8a00' },
  { id: 'oni', name: 'Oni', emoji: '👹', base: '#7d0a0a', baseShade: '#400505', accent: '#1a1a1a', accent2: '#ffcf3d', pattern: 'diamond', patternPeriod: 2, glow: 6, ui: '#ff2020' },

  // Level 7 - epic/legendary (royal gems)
  { id: 'golden_dragon', name: 'Golden Dragon', emoji: '🐲', base: '#7a5a00', baseShade: '#4a3600', accent: '#fff3c4', accent2: '#ff8a00', pattern: 'metallic', patternPeriod: 2, glow: 8, ui: '#ffd23f' },
  { id: 'royal_emerald', name: 'Royal Emerald', emoji: '💚', base: '#064d33', baseShade: '#032b1c', accent: '#2effb0', accent2: '#d4f8e8', pattern: 'crystal', patternPeriod: 2, glow: 9, ui: '#2effb0' },
  { id: 'royal_sapphire', name: 'Royal Sapphire', emoji: '💙', base: '#052a5c', baseShade: '#03162f', accent: '#4fb3ff', accent2: '#d0ecff', pattern: 'crystal', patternPeriod: 2, glow: 9, ui: '#4fb3ff' },
  { id: 'royal_ruby', name: 'Royal Ruby', emoji: '❤️', base: '#5c0518', baseShade: '#2f020c', accent: '#ff2f55', accent2: '#ffd0da', pattern: 'crystal', patternPeriod: 2, glow: 9, ui: '#ff2f55' },
  { id: 'royal_amethyst', name: 'Royal Amethyst', emoji: '🟣', base: '#3d0566', baseShade: '#1f0333', accent: '#b366ff', accent2: '#ecd6ff', pattern: 'crystal', patternPeriod: 2, glow: 9, ui: '#b366ff' },

  // Level 8 - legendary (dark)
  { id: 'shadow_flame', name: 'Shadow Flame', emoji: '🖤', base: '#0d0508', baseShade: '#050203', accent: '#7d1aff', accent2: '#ff4500', pattern: 'crack', patternPeriod: 2, glow: 10, ui: '#7d1aff' },
  { id: 'void', name: 'Void', emoji: '🕳️', base: '#030305', baseShade: '#000000', accent: '#3d0a66', accent2: '#7d3dff', pattern: 'shadow', patternPeriod: 2, glow: 9, ui: '#7d3dff' },
  { id: 'blood_moon', name: 'Blood Moon', emoji: '🌕', base: '#2e0505', baseShade: '#150202', accent: '#ff0000', accent2: '#ff8a8a', pattern: 'shadow', patternPeriod: 2, glow: 10, ui: '#ff2020' },
  { id: 'eclipse', name: 'Eclipse', emoji: '🌒', base: '#08080d', baseShade: '#030305', accent: '#ffcf3d', accent2: '#3d3d4d', pattern: 'shadow', patternPeriod: 2, glow: 8, ui: '#ffcf3d' },
  { id: 'dark_matter', name: 'Dark Matter', emoji: '🌀', base: '#05040a', baseShade: '#020103', accent: '#9d3dff', accent2: '#3dfff0', pattern: 'stars', patternPeriod: 2, glow: 10, ui: '#9d3dff' },

  // Level 9 - legendary (gods)
  { id: 'lightning_god', name: 'Lightning God', emoji: '⚡', base: '#0a0a1a', baseShade: '#05050d', accent: '#fff700', accent2: '#29d3ff', pattern: 'crack', patternPeriod: 2, glow: 11, ui: '#fff700' },
  { id: 'ice_god', name: 'Ice God', emoji: '🥶', base: '#e8f8ff', baseShade: '#b8e0f5', accent: '#ffffff', accent2: '#29c9ff', pattern: 'crystal', patternPeriod: 2, glow: 10, ui: '#29c9ff' },
  { id: 'fire_god', name: 'Fire God', emoji: '☄️', base: '#330a00', baseShade: '#1a0500', accent: '#ff4500', accent2: '#ffd23f', pattern: 'crack', patternPeriod: 2, glow: 11, ui: '#ff4500' },
  { id: 'storm_god', name: 'Storm God', emoji: '🌪️', base: '#0a1a2e', baseShade: '#050d17', accent: '#7dd3ff', accent2: '#ffffff', pattern: 'crack', patternPeriod: 2, glow: 10, ui: '#7dd3ff' },
  { id: 'cosmic_god', name: 'Cosmic God', emoji: '👁️', base: '#0a0520', baseShade: '#050310', accent: '#ff6ec7', accent2: '#6affea', pattern: 'stars', patternPeriod: 2, glow: 11, ui: '#ff6ec7' },

  // Level 10 - ultimate (maximum prestige)
  { id: 'ancient_king', name: 'Ancient King', emoji: '🗿', base: '#3d2a05', baseShade: '#1f1503', accent: '#ffd23f', accent2: '#fff3c4', pattern: 'metallic', patternPeriod: 2, glow: 9, ui: '#ffd23f' },
  { id: 'immortal', name: 'Immortal', emoji: '⚜️', base: '#0d1f1a', baseShade: '#06100d', accent: '#3dffd0', accent2: '#ffffff', pattern: 'crystal', patternPeriod: 2, glow: 11, ui: '#3dffd0' },
  { id: 'celestial', name: 'Celestial', emoji: '😇', base: '#1a1033', baseShade: '#0d081a', accent: '#ffe680', accent2: '#b3d9ff', pattern: 'stars', patternPeriod: 2, glow: 12, ui: '#ffe680' },
  { id: 'infinity', name: 'Infinity', emoji: '♾️', base: '#05050a', baseShade: '#020205', accent: '#ff00ff', accent2: '#00ffff', pattern: 'stars', patternPeriod: 2, glow: 12, ui: '#ff00ff' },
  { id: 'ultimate_venom', name: 'Ultimate Venom', emoji: '💀', base: '#061006', baseShade: '#030803', accent: '#39ff14', accent2: '#000000', pattern: 'toxic', patternPeriod: 2, glow: 12, ui: '#39ff14' },
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
