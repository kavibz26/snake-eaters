import { randomInt } from 'node:crypto';
import { CONFIG } from '../js/config.js';

// Bump when the wire format changes incompatibly; the server rejects clients
// on a different version so a stale cached frontend gets a clear "refresh" error.
export const PROTOCOL_VERSION = 1;

export const MAX_PLAYERS = 8; // one per skin
export const MIN_PLAYERS_TO_START = 2;
export const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS) || 3000;
export const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 20000;
export const MATCH_MAX_TICKS = Math.round((5 * 60 * 1000) / CONFIG.TICK_MS); // hard 5-minute cap
export const LOBBY_IDLE_MS = 30 * 60 * 1000;

export const ROOM_CODE_LENGTH = 5;
// No 0/O/1/I/L - codes get read aloud and typed on phones.
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const NAME_MAX = 14;

export const DIRECTION_NAMES = new Set(['up', 'down', 'left', 'right']);

export function generateRoomCode() {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

export function isValidCodeFormat(code) {
  return typeof code === 'string' && code.length === ROOM_CODE_LENGTH
    && [...code].every((ch) => ROOM_CODE_ALPHABET.includes(ch));
}

// Nicknames are rendered on canvas and via textContent (never innerHTML), but
// strip control / invisible / bidi-override characters anyway so nobody can
// spoof another player's label or break the layout.
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Player';
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/[^\p{L}\p{N} _.\-!]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const limited = Array.from(cleaned).slice(0, NAME_MAX).join('').trim();
  return limited || 'Player';
}
