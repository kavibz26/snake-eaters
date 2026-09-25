// Public lobbies. The server owns a FIXED set of lobbies (LOBBY_COUNT, each holding
// at most MAX_PLAYERS_PER_LOBBY players); players just pick one - no room codes,
// no player-created rooms. Everything here is authoritative: capacity, who is
// inside, when a match starts, and which lobbies can currently be joined.
//
// Lobby state:  waiting -> countdown -> running -> (match ends) -> waiting
//   waiting    fewer than 2 connected players
//   countdown  2+ connected; auto-starts when the timer ends (others may still join)
//   running    match in progress (locked - nobody can join)
// When a match ends everyone is released from the lobby (their results screen is
// already on its way) and it is immediately free for new players.
import { randomBytes } from 'node:crypto';
import { CONFIG } from '../js/config.js';
import { SKINS, DEFAULT_SKIN_ID } from '../js/skins.js';
import { MatchSim } from './match.js';
import {
  LOBBY_COUNT, MAX_PLAYERS_PER_LOBBY, MIN_PLAYERS_TO_START, LOBBY_START_DELAY_MS,
  LOBBY_FULL_START_DELAY_MS, COUNTDOWN_MS, RECONNECT_GRACE_MS, CHAT_BUCKET, CHAT_HISTORY,
  sanitizeName, sanitizeChat,
} from './protocol.js';

const OPEN = 1;

export function send(ws, msg) {
  if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(msg));
}

export class Lobby {
  constructor(index, manager, maxPlayers) {
    this.index = index;
    this.id = `lobby-${index}`;
    this.name = `Lobby ${index}`;
    this.manager = manager;
    this.max = maxPlayers;
    this.players = new Map(); // id -> player, in join order
    this.state = 'waiting'; // waiting | countdown | running
    this.phase = null; // while running: 'starting' (3-2-1) | 'playing'
    this.startAt = 0; // when the lobby countdown ends
    this.startsAt = 0; // when the in-match "get ready" countdown ends
    this.match = null;
    this.countdownTimer = null;
    this.startTimer = null;
    this.tickTimer = null;
    this.chatLog = []; // recent messages, replayed to players who join or reconnect
  }

  // --- occupancy -------------------------------------------------------------------

  // Slots in use (includes players inside their reconnect grace period).
  get count() {
    return this.players.size;
  }

  get connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  get joinable() {
    return this.state !== 'running' && this.players.size < this.max;
  }

  summary() {
    return { id: this.id, name: this.name, p: this.count, m: this.max, s: this.state };
  }

  publicInfo() {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      max: this.max,
      min: MIN_PLAYERS_TO_START,
      startsInMs: this.state === 'countdown' ? Math.max(0, this.startAt - Date.now()) : 0,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, skinId: p.skinId, connected: p.connected,
      })),
    };
  }

  // --- roster ------------------------------------------------------------------------

  // Called only by LobbyManager.join after it has verified the lobby is joinable.
  addPlayer(ws, rawName, rawSkin) {
    const id = 'p_' + randomBytes(4).toString('hex');
    const player = {
      id,
      token: randomBytes(16).toString('hex'),
      name: this._uniqueName(sanitizeName(rawName)),
      skinId: this._freeSkin(rawSkin),
      ws,
      connected: true,
      dcTimer: null,
      chatBucket: { tokens: CHAT_BUCKET.capacity, last: Date.now() },
    };
    this.players.set(id, player);
    return player;
  }

  // Duplicate skins would make two snakes indistinguishable, so a taken skin
  // is swapped for the first free one (the client is told which it got).
  _freeSkin(requested) {
    const taken = new Set([...this.players.values()].map((p) => p.skinId));
    const valid = SKINS.some((s) => s.id === requested) ? requested : DEFAULT_SKIN_ID;
    if (!taken.has(valid)) return valid;
    return (SKINS.find((s) => !taken.has(s.id)) || SKINS[0]).id;
  }

  _uniqueName(name) {
    const names = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    if (!names.has(name.toLowerCase())) return name;
    for (let n = 2; n < 100; n++) {
      const candidate = `${name.slice(0, 12)} ${n}`;
      if (!names.has(candidate.toLowerCase())) return candidate;
    }
    return name;
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws && p.ws.readyState === OPEN) p.ws.send(data);
    }
  }

  broadcastLobby() {
    this.broadcast({ t: 'lobby', lobby: this.publicInfo() });
  }

  // Everything that follows any roster/state change, in one place.
  _changed() {
    this._evaluateStart();
    this.broadcastLobby();
    this.manager.lobbyChanged(this);
  }

  // --- auto-start ------------------------------------------------------------------------

  // Decides whether the lobby should be counting down. Called after every change to who
  // is inside, so a lobby can never sit waiting forever with 2+ players in it.
  _evaluateStart() {
    if (this.state === 'running') return;
    const enough = this.connectedCount >= MIN_PLAYERS_TO_START;
    if (this.state === 'waiting' && enough) {
      this.state = 'countdown';
      this._scheduleStart(this.count >= this.max ? this.manager.fullStartDelayMs : this.manager.startDelayMs);
    } else if (this.state === 'countdown') {
      if (!enough) {
        clearTimeout(this.countdownTimer);
        this.countdownTimer = null;
        this.state = 'waiting';
      } else if (this.count >= this.max && this.startAt - Date.now() > this.manager.fullStartDelayMs) {
        this._scheduleStart(this.manager.fullStartDelayMs); // full house: no reason to keep waiting
      }
    }
  }

  _scheduleStart(delayMs) {
    clearTimeout(this.countdownTimer);
    this.startAt = Date.now() + delayMs;
    this.countdownTimer = setTimeout(() => this._startMatch(), delayMs);
  }

  // --- connection lifecycle ------------------------------------------------------------------

  // Socket dropped (or was closed) without an explicit leave: keep the slot and the
  // snake for the grace period so the player can reconnect to the same lobby/match.
  handleDisconnect(player) {
    if (!this.players.has(player.id) || !player.connected) return;
    player.connected = false;
    player.ws = null;
    if (this.state === 'running' && this.match) this.match.setFrozen(player.id, true);
    player.dcTimer = setTimeout(() => this.removePlayer(player.id), RECONNECT_GRACE_MS);
    this._changed();
  }

  reconnect(player, ws) {
    if (player.dcTimer) clearTimeout(player.dcTimer);
    player.dcTimer = null;
    if (player.ws && player.ws !== ws) player.ws.close(4000, 'replaced');
    player.ws = ws;
    player.connected = true;
    if (this.match) this.match.setFrozen(player.id, false);
    send(ws, this.joinedMessage(player));
    if (this.state === 'running' && this.match) send(ws, this.matchMessage(player, true));
    this._changed();
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    if (player.dcTimer) clearTimeout(player.dcTimer);
    this.players.delete(id);
    if (this.state === 'running' && this.match) this.match.forfeit(id);
    if (this.players.size === 0) this.chatLog = []; // an empty lobby starts with a clean chat
    this._changed();
  }

  // --- messages ----------------------------------------------------------------------------------

  joinedMessage(player) {
    return {
      t: 'joined',
      you: { id: player.id, token: player.token }, // the token goes ONLY to its owner, in this one message
      lobby: this.publicInfo(),
      chat: this.chatLog,
    };
  }

  // Lobby chat: plain text relayed by the server to the players inside THIS lobby only.
  // Sanitised, length-capped and rate limited per player; the sender's name is ours.
  chat(player, raw) {
    const text = sanitizeChat(raw);
    if (!text) return { code: 'chat_empty', message: 'Type a message first.' };
    const bucket = player.chatBucket;
    const now = Date.now();
    bucket.tokens = Math.min(CHAT_BUCKET.capacity, bucket.tokens + ((now - bucket.last) / 1000) * CHAT_BUCKET.refillPerSec);
    bucket.last = now;
    if (bucket.tokens < 1) return { code: 'chat_rate', message: 'You are sending messages too quickly.' };
    bucket.tokens -= 1;
    const msg = { t: 'chat', id: player.id, name: player.name, m: text, ts: now };
    this.chatLog.push(msg);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();
    this.broadcast(msg);
    return null;
  }

  matchMessage(player, resumed = false) {
    return {
      t: 'match',
      resumed,
      startsInMs: this.phase === 'starting' ? Math.max(0, this.startsAt - Date.now()) : 0,
      tickMs: CONFIG.TICK_MS,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, skinId: p.skinId })),
      you: player.id,
      snap: this.match.snapshot({ full: true }), // complete state; per-tick snapshots are deltas
    };
  }

  // --- match lifecycle -------------------------------------------------------------------------------

  _startMatch() {
    this.countdownTimer = null;
    // Anyone still in grace-period limbo is dropped; the match is for connected players.
    for (const p of [...this.players.values()]) {
      if (!p.connected) {
        clearTimeout(p.dcTimer);
        this.players.delete(p.id);
      }
    }
    if (this.connectedCount < MIN_PLAYERS_TO_START) {
      this.state = 'waiting';
      this._changed();
      return;
    }
    this.match = new MatchSim([...this.players.values()].map((p) => ({ id: p.id, name: p.name, skinId: p.skinId })));
    this.state = 'running'; // locked from this moment
    this.phase = 'starting';
    this.startsAt = Date.now() + COUNTDOWN_MS;
    for (const p of this.players.values()) {
      if (p.ws) send(p.ws, this.matchMessage(p));
    }
    this.broadcastLobby();
    this.manager.lobbyChanged(this);
    this.startTimer = setTimeout(() => this._beginPlaying(), COUNTDOWN_MS);
  }

  _beginPlaying() {
    if (!this.match) return;
    this.phase = 'playing';
    this.tickTimer = setInterval(() => this._tick(), CONFIG.TICK_MS);
  }

  _tick() {
    if (!this.match) return;
    this.match.tick();
    const snap = JSON.stringify(this.match.snapshot());
    for (const p of this.players.values()) {
      const ws = p.ws;
      if (ws && ws.readyState === OPEN && ws.bufferedAmount < 512 * 1024) ws.send(snap);
    }
    if (this.match.over) this._endMatch();
  }

  _endMatch() {
    clearInterval(this.tickTimer);
    clearTimeout(this.startTimer);
    this.tickTimer = null;
    const match = this.match;
    this.broadcast({
      t: 'over',
      winnerId: match.winnerId,
      reason: match.endReason,
      results: match.results(),
    });
    this._release();
  }

  // The match is over: everyone leaves the lobby (their sockets stay open so they can
  // go straight back to the lobby browser) and the lobby is free again.
  _release() {
    for (const p of this.players.values()) {
      if (p.dcTimer) clearTimeout(p.dcTimer);
      if (p.ws && p.ws.ctx && p.ws.ctx.player === p) p.ws.ctx = null;
    }
    this.players.clear();
    this.chatLog = [];
    this.match = null;
    this.phase = null;
    this.state = 'waiting';
    this.manager.lobbyChanged(this);
  }

  dispose() {
    clearInterval(this.tickTimer);
    clearTimeout(this.startTimer);
    clearTimeout(this.countdownTimer);
    for (const p of this.players.values()) if (p.dcTimer) clearTimeout(p.dcTimer);
    this.players.clear();
    this.match = null;
  }
}

export class LobbyManager {
  constructor({
    lobbyCount = LOBBY_COUNT, maxPlayers = MAX_PLAYERS_PER_LOBBY,
    startDelayMs = LOBBY_START_DELAY_MS, fullStartDelayMs = LOBBY_FULL_START_DELAY_MS,
  } = {}) {
    this.startDelayMs = startDelayMs;
    this.fullStartDelayMs = fullStartDelayMs;
    // One skin per player, so a lobby can never hold more players than there are skins.
    this.maxPlayers = Math.max(MIN_PLAYERS_TO_START, Math.min(maxPlayers, SKINS.length));
    this.lobbies = new Map();
    for (let i = 1; i <= lobbyCount; i++) this.lobbies.set(`lobby-${i}`, new Lobby(i, this, this.maxPlayers));
    this.browsers = new Set(); // sockets currently looking at the lobby list (push updates go here)
    this.lastSent = new Map(); // lobby id -> "p/s" last pushed, to skip no-op updates
  }

  // --- lobby browser (server push, no polling) -------------------------------------------------------

  list() {
    return {
      t: 'lobbies',
      max: this.maxPlayers,
      min: MIN_PLAYERS_TO_START,
      lobbies: [...this.lobbies.values()].map((l) => l.summary()),
    };
  }

  subscribe(ws) {
    this.browsers.add(ws);
    send(ws, this.list());
  }

  unsubscribe(ws) {
    this.browsers.delete(ws);
  }

  // Compact push: just what changed for one lobby.
  lobbyChanged(lobby) {
    const s = lobby.summary();
    const key = `${s.p}/${s.s}`;
    if (this.lastSent.get(lobby.id) === key) return;
    this.lastSent.set(lobby.id, key);
    const data = JSON.stringify({ t: 'lu', id: s.id, p: s.p, m: s.m, s: s.s });
    for (const ws of this.browsers) {
      if (ws.readyState === OPEN) ws.send(data);
    }
  }

  // --- joining ------------------------------------------------------------------------------------------

  // The ONLY way into a lobby. The check and the insert happen in the same synchronous
  // step, so two simultaneous joins can never both take the last slot - the second one
  // sees a full lobby. Capacity is never something the client tells us.
  join(ws, lobbyId, name, skin) {
    const lobby = typeof lobbyId === 'string' ? this.lobbies.get(lobbyId) : undefined;
    if (!lobby) return { error: { code: 'invalid_lobby', message: 'That lobby does not exist.' } };
    if (lobby.state === 'running') return { error: { code: 'match_in_progress', message: 'That lobby is in the middle of a match.' } };
    if (lobby.count >= lobby.max) return { error: { code: 'lobby_full', message: 'That lobby is full.' } };
    this.browsers.delete(ws);
    const player = lobby.addPlayer(ws, name, skin);
    return { lobby, player };
  }

  stats() {
    let players = 0;
    let running = 0;
    for (const l of this.lobbies.values()) {
      players += l.connectedCount;
      if (l.state === 'running') running++;
    }
    return { lobbies: this.lobbies.size, running, players };
  }

  shutdown() {
    for (const l of this.lobbies.values()) l.dispose();
    this.browsers.clear();
  }
}
