import { CONFIG } from '../js/config.js';

// Bump when the wire format changes incompatibly; the server rejects clients
// on a different version so a stale cached frontend gets a clear "refresh" error.
export const PROTOCOL_VERSION = 5; // v5: maps + obstacles (lobby `map`, match `map` / `mh`); v4: power-ups / special food (snapshot `e`, `sp`/`spa`/`spr`, events `pu`/`shield`, results `powerups`/`mega`); v3: public lobbies; v2: sequenced inputs + acks, delta snapshots, chat

// --- public lobbies: the ONE place these numbers live (env-overridable) -----------------
export const LOBBY_COUNT = Number(process.env.LOBBY_COUNT) || 6;
export const MAX_PLAYERS_PER_LOBBY = Number(process.env.MAX_PLAYERS_PER_LOBBY) || 6;
export const MIN_PLAYERS_TO_START = 2;
// Auto-start: once 2+ players are connected the lobby counts down so others can still
// join; if it fills up the wait is cut short. Nobody has to press "start".
export const LOBBY_START_DELAY_MS = Number(process.env.LOBBY_START_DELAY_MS) || 10000;
export const LOBBY_FULL_START_DELAY_MS = Number(process.env.LOBBY_FULL_START_DELAY_MS) || 3000;
export const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS) || 3000;
export const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 20000;
export const MATCH_MAX_TICKS = Math.round((5 * 60 * 1000) / CONFIG.TICK_MS); // hard 5-minute cap

// Each public lobby is played on ONE configured map (deterministic, not player-chosen). Two lobbies per map by
// default; override with LOBBY_MAPS="classic,classic,blocks,blocks,arena,arena". Unknown ids fall back to Classic.
import { DEFAULT_MAP_ID, isKnownMap } from '../js/maps/maps.js';
const DEFAULT_LOBBY_MAPS = ['classic', 'classic', 'blocks', 'blocks', 'arena', 'arena'];
const CONFIGURED_MAPS = (process.env.LOBBY_MAPS || '').split(',').map((s) => s.trim()).filter(Boolean);
export function mapForLobby(index) {
  const list = CONFIGURED_MAPS.length ? CONFIGURED_MAPS : DEFAULT_LOBBY_MAPS;
  const id = list[(index - 1) % list.length];
  return isKnownMap(id) ? id : DEFAULT_MAP_ID;
}

export const NAME_MAX = 14;
export const CHAT_MAX = 140;
export const CHAT_HISTORY = 30;
// Chat token bucket per player: bursts of 5, then one message per 2 seconds.
export const CHAT_BUCKET = { capacity: 5, refillPerSec: 0.5 };

export const DIRECTION_NAMES = new Set(['up', 'down', 'left', 'right']);

// Nicknames are rendered on canvas and via textContent (never innerHTML), but
// strip control / invisible / bidi-override characters anyway so nobody can
// spoof another player's label or break the layout.
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Player';
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[^\p{L}\p{N} _.\-!]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const limited = Array.from(cleaned).slice(0, NAME_MAX).join('').trim();
  return limited || 'Player';
}

// Chat is plain text only (the client renders it with textContent, never
// innerHTML). Strip control / invisible / bidi-override characters so nobody
// can spoof another player's line or hide text, collapse whitespace, cap length.
export function sanitizeChat(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, CHAT_MAX).join('').trim();
}
