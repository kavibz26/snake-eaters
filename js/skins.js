// Player-selectable visual styles. Each skin only needs a color - the
// existing render code (body fill, head highlight, glow marker) already
// derives everything else from snake.color, so adding a skin never touches
// rendering logic, only which color the player's snake is built with.
export const SKINS = [
  { id: 'classic', name: 'Classic Green', color: '#3ee08a' },
  { id: 'cyan', name: 'Neon Cyan', color: '#4de0ff' },
  { id: 'crimson', name: 'Crimson', color: '#ff4d6a' },
  { id: 'violet', name: 'Royal Violet', color: '#b06bff' },
  { id: 'gold', name: 'Solar Gold', color: '#ffcf4d' },
  { id: 'arctic', name: 'Arctic White', color: '#e8edf3' },
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
