// Thin WebSocket client for the multiplayer server: connection state machine,
// request/response for create/join, and automatic token-based reconnect.
// It carries intents up and authoritative state down - it never simulates.
import {
  SERVER_URL, PROTOCOL_VERSION, CONNECT_TIMEOUT_MS, WAKING_HINT_AFTER_MS, MAX_RECONNECT_ATTEMPTS,
} from './config.js';

// status: idle | connecting | connected | reconnecting | disconnected | unavailable
export class NetClient {
  constructor(url = SERVER_URL) {
    this.url = url;
    this.ws = null;
    this.status = 'idle';
    this.handlers = new Map();
    this.session = null; // { code, id, token } - lets a dropped socket reclaim its seat
    this.room = null;
    this.you = null;
    this.pending = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.handlers.get(event).delete(fn);
  }

  _emit(event, data) {
    const set = this.handlers.get(event);
    if (set) for (const fn of [...set]) fn(data);
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

  _request(msg) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this._send({ ...msg, v: PROTOCOL_VERSION });
    });
  }

  async createRoom(name, skin) {
    await this._ensureOpen();
    return this._request({ t: 'create', name, skin });
  }

  async joinRoom(code, name, skin) {
    await this._ensureOpen();
    return this._request({ t: 'join', code, name, skin });
  }

  startMatch() { this._send({ t: 'start' }); }
  sendDir(d) { this._send({ t: 'dir', d }); }
  sendBoost() { this._send({ t: 'boost' }); }

  leave() {
    clearTimeout(this.reconnectTimer);
    this._send({ t: 'leave' });
    this.session = null;
    this.room = null;
    this.you = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, 150);
    this._setStatus('idle');
  }

  // --- incoming ---------------------------------------------------------------------------

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.t) {
      case 'joined': {
        this.you = msg.you;
        this.room = msg.room;
        this.session = { code: msg.room.code, id: msg.you.id, token: msg.you.token };
        if (this.pending) {
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
      case 'room':
        this.room = msg.room;
        this._emit('room', msg.room);
        break;
      case 'match':
      case 'snap':
      case 'over':
        this._emit(msg.t, msg);
        break;
      case 'error': {
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          p.reject({ code: msg.code, message: msg.message });
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
    this._send({ t: 'rejoin', v: PROTOCOL_VERSION, code: this.session.code, id: this.session.id, token: this.session.token });
  }

  _giveUpReconnecting(reason) {
    clearTimeout(this.reconnectTimer);
    this.session = null;
    this.room = null;
    this.you = null;
    this.reconnectAttempt = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    this._setStatus('disconnected', reason);
    this._emit('lost', { reason });
  }
}
