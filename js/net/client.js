// Thin WebSocket client for the multiplayer server: connection state machine, the
// public lobby browser (server-pushed updates), joining a lobby, and automatic
// token-based reconnect.
// It carries intents up and authoritative state down - it never simulates.
import {
  SERVER_URL, PROTOCOL_VERSION, CONNECT_TIMEOUT_MS, WAKING_HINT_AFTER_MS, MAX_RECONNECT_ATTEMPTS,
  PING_INTERVAL_MS,
} from './config.js';

// status: idle | connecting | connected | reconnecting | disconnected | unavailable
export class NetClient {
  constructor(url = SERVER_URL) {
    this.url = url;
    this.ws = null;
    this.status = 'idle';
    this.handlers = new Map();
    this.session = null; // { lobby, id, token } - lets a dropped socket reclaim its slot
    this.lobby = null; // the lobby we are inside (server-provided roster/state)
    this.you = null;
    this.pending = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.rtt = null; // smoothed round trip in ms, measured from real ping/pong messages
    this.rttLast = null;
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.handlers.get(event).delete(fn);
  }

  _emit(event, data, extra) {
    const set = this.handlers.get(event);
    if (set) for (const fn of [...set]) fn(data, extra);
  }

  _setStatus(status, detail) {
    this.status = status;
    this._emit('status', { status, detail });
  }

  get configured() {
    return Boolean(this.url);
  }

  // --- opening the socket -------------------------------------------------------

  _open() {
    return new Promise((resolve, reject) => {
      if (!this.url) {
        reject({ code: 'not_configured', message: 'Online multiplayer is not available yet - the game server has not been set up.' });
        return;
      }
      let settled = false;
      const ws = new WebSocket(this.url);
      const wakingTimer = setTimeout(() => {
        if (!settled) this._emit('status', { status: 'connecting', detail: 'waking' });
      }, WAKING_HINT_AFTER_MS);
      const timeout = setTimeout(() => fail('timeout'), CONNECT_TIMEOUT_MS);
      const finish = () => { settled = true; clearTimeout(wakingTimer); clearTimeout(timeout); };
      const fail = (why) => {
        if (settled) return;
        finish();
        try { ws.close(); } catch { /* already closing */ }
        reject({ code: 'server_unavailable', message: 'Cannot reach the multiplayer server right now. Please try again in a moment.', why });
      };
      ws.onopen = () => {
        if (settled) return;
        finish();
        this._attach(ws);
        resolve();
      };
      ws.onerror = () => fail('error');
      ws.onclose = () => fail('closed');
    });
  }

  _attach(ws) {
    this.ws = ws;
    ws.onmessage = (ev) => this._onMessage(ev);
    ws.onclose = () => this._onClose(ws);
    ws.onerror = () => {};
  }

  async _ensureOpen() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this._setStatus('connecting');
    try {
      await this._open();
    } catch (err) {
      this._setStatus('unavailable', err.code);
      throw err;
    }
    this._setStatus('connected');
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // --- requests ---------------------------------------------------------------------

  // One outstanding request at a time; `expect` is the reply type that completes it.
  _request(msg, expect) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, expect };
      this._send({ ...msg, v: PROTOCOL_VERSION });
    });
  }

  // Opens the connection if needed and subscribes to the lobby list. Resolves with the
  // full list once; from then on the server PUSHES compact changes ('lobby_update').
  async browseLobbies() {
    await this._ensureOpen();
    return this._request({ t: 'lobbies' }, 'lobbies');
  }

  stopBrowsing() {
    this._send({ t: 'unbrowse' });
  }

  async joinLobby(lobbyId, name, skin) {
    await this._ensureOpen();
    return this._request({ t: 'join', lobby: lobbyId, name, skin }, 'joined');
  }

  // Sequenced gameplay input: { seq, dir } or { seq, boost: true }. Sent the instant
  // it happens (never batched per frame) - the server queues it on our own snake only.
  sendInput(input) { this._send({ t: 'input', ...input }); }
  sendChat(text) { this._send({ t: 'chat', m: text }); }
  requestSync() { this._send({ t: 'sync' }); }

  // --- latency measurement (informational + drives the prediction lead) ---------------

  _startPing() {
    this._stopPing();
    const ping = () => this._send({ t: 'ping', c: performance.now() });
    ping();
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }

  _stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  _onPong(msg) {
    if (typeof msg.c !== 'number') return;
    const sample = performance.now() - msg.c;
    if (!(sample >= 0 && sample < 10000)) return;
    this.rttLast = sample;
    this.rtt = this.rtt === null ? sample : this.rtt * 0.7 + sample * 0.3;
    this._emit('latency', { rtt: this.rtt, sample });
  }

  // Leave the lobby but keep the connection (back to the lobby browser).
  leave() {
    clearTimeout(this.reconnectTimer);
    this._send({ t: 'leave' });
    this._clearLobbySession();
  }

  // Close the connection entirely (leaving the multiplayer section).
  disconnect() {
    clearTimeout(this.reconnectTimer);
    this._clearLobbySession();
    const ws = this.ws;
    this.ws = null;
    this.pending = null;
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    this._setStatus('idle');
  }

  _clearLobbySession() {
    this.session = null;
    this.lobby = null;
    this.you = null;
    this._stopPing();
    this.rtt = null;
  }

  // --- incoming ---------------------------------------------------------------------------

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    // Real arrival time of the packet (not when our handler got to it) - the
    // prediction's tick-phase estimate depends on this being accurate.
    const recvAt = typeof ev.timeStamp === 'number' && ev.timeStamp > 0 ? ev.timeStamp : performance.now();
    switch (msg.t) {
      case 'pong':
        this._onPong(msg);
        break;
      case 'chat':
        this._emit('chat', msg);
        break;
      case 'chat_error':
        this._emit('chat_error', msg);
        break;
      case 'lobbies': // the full list (reply to browseLobbies)
        if (this.pending && this.pending.expect === 'lobbies') {
          const p = this.pending;
          this.pending = null;
          p.resolve(msg);
        } else {
          this._emit('lobbies', msg);
        }
        break;
      case 'lu': // compact push: one lobby's count/state changed
        this._emit('lobby_update', msg);
        break;
      case 'joined': {
        this.you = msg.you;
        this.lobby = msg.lobby;
        this.session = { lobby: msg.lobby.id, id: msg.you.id, token: msg.you.token };
        this._startPing();
        this._emit('chathistory', msg.chat || []);
        if (this.pending && this.pending.expect === 'joined') {
          const p = this.pending;
          this.pending = null;
          p.resolve(msg);
        } else if (this.status === 'reconnecting') {
          this.reconnectAttempt = 0;
          this._setStatus('connected', 'rejoined');
          this._emit('rejoined', msg);
        }
        break;
      }
      case 'lobby': // roster / state / countdown of the lobby we are in
        this.lobby = msg.lobby;
        this._emit('lobby', msg.lobby);
        break;
      case 'snap':
        this._emit('snap', msg, recvAt);
        break;
      case 'match':
        this._emit('match', msg);
        break;
      case 'over':
        // The server releases everyone from the lobby when a match ends: there is no
        // slot left to reconnect to, and we are free to browse lobbies again.
        this._clearLobbySession();
        this._emit('over', msg);
        break;
      case 'error': {
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          p.reject({ code: msg.code, message: msg.message, sv: msg.sv });
        } else if (this.status === 'reconnecting' && msg.code === 'invalid_session') {
          this._giveUpReconnecting('session_expired');
        } else {
          this._emit('error', { code: msg.code, message: msg.message });
        }
        break;
      }
      default:
    }
  }

  _onClose(ws) {
    if (ws !== this.ws) return;
    this.ws = null;
    this._stopPing();
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject({ code: 'server_unavailable', message: 'Lost connection to the multiplayer server.' });
    }
    if (this.session) {
      this._setStatus('reconnecting');
      this._scheduleReconnect();
    } else {
      this._setStatus('disconnected');
    }
  }

  // --- reconnect ------------------------------------------------------------------------------

  _scheduleReconnect() {
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this._giveUpReconnecting('unreachable');
      return;
    }
    const delay = Math.min(500 * (this.reconnectAttempt + 1), 2500);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this._tryReconnect(), delay);
  }

  async _tryReconnect() {
    if (!this.session) return;
    try {
      await this._open();
    } catch {
      if (this.status === 'reconnecting') this._scheduleReconnect();
      return;
    }
    if (!this.session) {
      try { this.ws.close(); } catch { /* ignore */ }
      return;
    }
    this._send({ t: 'rejoin', v: PROTOCOL_VERSION, lobby: this.session.lobby, id: this.session.id, token: this.session.token });
  }

  _giveUpReconnecting(reason) {
    clearTimeout(this.reconnectTimer);
    this._clearLobbySession();
    this.reconnectAttempt = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    this._setStatus('disconnected', reason);
    this._emit('lost', { reason });
  }
}
