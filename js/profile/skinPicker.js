// The skin grid, shared by the main menu and the profile screen (one implementation, two mounts).
// Locked skins stay visible with their requirement; tapping one explains how to unlock it.
import { SKINS } from '../skins.js';
import { renderSkinPreview } from '../snakeRender.js';
import { getUnlockLevel } from './profile.js';

export function createSkinPicker(container, { profile, onSelect, onLocked }) {
  const cards = new Map();
  container.textContent = '';
  for (const skin of SKINS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'skin-card';
    btn.dataset.skinId = skin.id;

    const preview = document.createElement('canvas');
    preview.className = 'skin-preview';
    preview.width = 140;
    preview.height = 100;
    renderSkinPreview(preview, skin);

    const label = document.createElement('span');
    label.className = 'skin-card-name';
    label.textContent = `${skin.emoji} ${skin.name}`;

    const lock = document.createElement('span');
    lock.className = 'skin-lock';

    btn.append(preview, label, lock);
    btn.addEventListener('click', () => {
      if (profile.isSkinUnlocked(skin.id)) onSelect(skin);
      else if (onLocked) onLocked(skin, getUnlockLevel(skin.id));
    });
    container.appendChild(btn);
    cards.set(skin.id, { btn, lock });
  }

  function refresh() {
    const recent = profile.recentUnlock();
    for (const skin of SKINS) {
      const { btn, lock } = cards.get(skin.id);
      const unlocked = profile.isSkinUnlocked(skin.id);
      const need = getUnlockLevel(skin.id);
      btn.classList.toggle('locked', !unlocked);
      btn.classList.toggle('selected', unlocked && profile.selectedSkin === skin.id);
      btn.classList.toggle('is-new', unlocked && recent === skin.id);
      btn.setAttribute('aria-disabled', unlocked ? 'false' : 'true');
      btn.setAttribute('aria-pressed', unlocked && profile.selectedSkin === skin.id ? 'true' : 'false');
      btn.title = unlocked ? skin.name : `${skin.name} - reach level ${need} to unlock`;
      btn.setAttribute('aria-label', unlocked ? skin.name : `${skin.name}, locked. Reach level ${need} to unlock.`);
      lock.textContent = unlocked ? (recent === skin.id ? 'NEW' : '') : `🔒 Level ${need}`;
    }
  }
  refresh();
  return { refresh };
}
