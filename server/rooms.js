import { randomBytes } from 'node:crypto';
import { CONFIG } from '../js/config.js';
import { SKINS, DEFAULT_SKIN_ID } from '../js/skins.js';
import { MatchSim } from './match.js';
import {
  MAX_PLAYERS, MIN_PLAYERS_TO_START, COUNTDOWN_MS, RECONNECT_GRACE_MS, LOBBY_IDLE_MS,
  generateRoomCode, sanitizeName,
} from './protocol.js';

const OPEN = 1;

export function send(ws, msg) {
  if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(msg));
}

export class Room {
  constructor(code, manager) {
    this.code = code;
    this.manager = manager;
    this.players = new Map(); // id -> player, in join order
    this.hostId = null;
    this.state = 'lobby'; // lobby | starting | playing
    this.match = null;
    this.tickTimer = null;
    this.startTimer = null;
    this.lastActivity = Date.now();
  }

  touch() {
    this.lastActivity = Date.now();
  }

  // --- roster ---------------------------------------------------------------

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
    };
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;
    this.touch();
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

  get connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  publicInfo() {
    return {
      code: this.code,
      state: this.state,
      hostId: this.hostId,
      max: MAX_PLAYERS,
      min: MIN_PLAYERS_TO_START,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, skinId: p.skinId, connected: p.connected,
      })),
    };
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws && p.ws.readyState === OPEN) p.ws.send(data);
    }
  }

  broadcastLobby() {
    this.broadcast({ t: 'room', room: this.publicInfo() });
  }

  // --- connection lifecycle --------------------------------------------------

  // Socket dropped (or was closed) without an explicit leave: keep the seat
  // and the snake for the grace period so the player can reconnect.
  handleDisconnect(player) {
    if (!this.players.has(player.id) || !player.connected) return;
    player.connected = false;
    player.ws = null;
    this.touch();
    if (this.match && (this.state === 'playing' || this.state === 'starting')) {
      this.match.setFrozen(player.id, true);
    }
    player.dcTimer = setTimeout(() => this.removePlayer(player.id, 'timeout'), RECONNECT_GRACE_MS);
    this.broadcastLobby();
    this._maybeDispose();
  }

  reconnect(player, ws) {
    if (player.dcTimer) clearTimeout(player.dcTimer);
    player.dcTimer = null;
    if (player.ws && player.ws !== ws) player.ws.close(4000, 'replaced');
    player.ws = ws;
    player.connected = true;
    this.touch();
    if (this.match) this.match.setFrozen(player.id, false);
    send(ws, this.joinedMessage(player));
    if (this.match && this.state !== 'lobby') {
      send(ws, this.matchMessage(player, true));
    }
    this.broadcastLobby();
  }

  removePlayer(id, reason) {
    const player = this.players.get(id);
    if (!player) return;
    if (player.dcTimer) clearTimeout(player.dcTimer);
    this.players.delete(id);
    if (this.match && this.state !== 'lobby') this.match.forfeit(id);
    if (this.hostId === id) {
      const next = [...this.players.values()].find((p) => p.connected) || [...this.players.values()][0];
      this.hostId = next ? next.id : null;
    }
    this.touch();
    if (reason === 'leave' || reason === 'timeout') this.broadcastLobby();
    this._maybeDispose();
  }

  _maybeDispose() {
    if (this.players.size === 0) this.dispose();
  }

  dispose() {
    clearInterval(this.tickTimer);
    clearTimeout(this.startTimer);
    for (const p of this.players.values()) if (p.dcTimer) clearTimeout(p.dcTimer);
    this.players.clear();
    this.match = null;
    this.manager.rooms.delete(this.code);
  }

  // --- messages ---------------------------------------------------------------

  joinedMessage(player) {
    return { t: 'joined', you: { id: player.id, token: player.token }, room: this.publicInfo() };
  }

  matchMessage(player, resumed = false) {
    return {
      t: 'match',
      resumed,
      startsInMs: this.state === 'starting' ? Math.max(0, this.startsAt - Date.now()) : 0,
      tickMs: CONFIG.TICK_MS,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, skinId: p.skinId })),
      you: player.id,
      snap: this.match.snapshot(),
    };
  }

  // --- match lifecycle ----------------------------------------------------------

  start(requesterId) {
    if (requesterId !== this.hostId) return { code: 'not_host', message: 'Only the host can start the match.' };
    if (this.state !== 'lobby') return { code: 'bad_state', message: 'A match is already running.' };
    const entrants = [...this.players.values()].filter((p) => p.connected);
    if (entrants.length < MIN_PLAYERS_TO_START) {
      return { code: 'need_players', message: `Need at least ${MIN_PLAYERS_TO_START} players to start.` };
    }
    // Anyone still in grace-period limbo is dropped; the match is for connected players.
    for (const p of [...this.players.values()]) if (!p.connected) this.removePlayer(p.id, 'timeout');

    this.match = new MatchSim(entrants.map((p) => ({ id: p.id, name: p.name, skinId: p.skinId })));
    this.state = 'starting';
    this.startsAt = Date.now() + COUNTDOWN_MS;
    this.touch();
    for (const p of this.players.values()) {
      if (p.ws) send(p.ws, this.matchMessage(p));
    }
    this.broadcastLobby();
    this.startTimer = setTimeout(() => this._beginPlaying(), COUNTDOWN_MS);
    return null;
  }

  _beginPlaying() {
    if (!this.match) return;
    this.state = 'playing';
    this.broadcastLobby();
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
    this.tickTimer = null;
    const match = this.match;
    this.broadcast({
      t: 'over',
      winnerId: match.winnerId,
      reason: match.endReason,
      results: match.results(),
    });
    this.match = null;
    this.state = 'lobby'; // room persists; host can run another round
    this.touch();
    this.broadcastLobby();
  }
}

export class RoomManager {
  constructor({ maxRooms = 200 } = {}) {
    this.rooms = new Map();
    this.maxRooms = maxRooms;
    this.sweeper = setInterval(() => this.sweep(), 60 * 1000);
    this.sweeper.unref();
  }

  createRoom(ws, name, skin) {
    if (this.rooms.size >= this.maxRooms) return { error: { code: 'server_busy', message: 'The server is full right now. Try again in a minute.' } };
    let code;
    do { code = generateRoomCode(); } while (this.rooms.has(code));
    const room = new Room(code, this);
    this.rooms.set(code, room);
    const player = room.addPlayer(ws, name, skin);
    return { room, player };
  }

  joinRoom(ws, code, name, skin) {
    const room = this.rooms.get(code);
    if (!room) return { error: { code: 'invalid_room', message: 'No room with that code. Check the code and try again.' } };
    if (room.state !== 'lobby') return { error: { code: 'match_in_progress', message: 'That match has already started.' } };
    if (room.players.size >= MAX_PLAYERS) return { error: { code: 'room_full', message: 'That room is full.' } };
    const player = room.addPlayer(ws, name, skin);
    return { room, player };
  }

  // Idle rooms nobody is looking at eventually clean themselves up.
  sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      if (room.state === 'lobby' && now - room.lastActivity > LOBBY_IDLE_MS) room.dispose();
    }
  }

  stats() {
    let players = 0;
    for (const r of this.rooms.values()) players += r.connectedCount;
    return { rooms: this.rooms.size, players };
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const room of [...this.rooms.values()]) room.dispose();
  }
}
