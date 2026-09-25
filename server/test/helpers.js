// Shared harness for the end-to-end tests: an in-process server on a random port and
// a tiny promise-based WebSocket client. Each test FILE runs in its own Node process,
// so the short lifecycle timers below can safely be set via env here. Every test gets
// a FRESH server (call h.hooks() once per file) so lobby state can never leak between tests.
import { beforeEach, afterEach } from 'node:test';
import WebSocket from 'ws';

process.env.COUNTDOWN_MS ||= '300';
process.env.RECONNECT_GRACE_MS ||= '1200';
const { createServer } = await import('../index.js');
export const { PROTOCOL_VERSION } = await import('../protocol.js');
export { CONFIG } from '../../js/config.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A server that never auto-starts a match (lobby / capacity / roster / chat tests)...
export const IDLE = { startDelayMs: 600000, fullStartDelayMs: 600000 };
// ...and one that auto-starts quickly (match-flow tests).
export const FAST = { startDelayMs: 400, fullStartDelayMs: 150 };

export function harness(serverOptions = FAST) {
  const h = { server: null, url: null, open: [], options: serverOptions };

  class Client {
    constructor(name) {
      this.name = name;
      this.msgs = [];
      this.waiters = [];
      this.closed = false;
      this.closeCode = null;
    }

    static async connect(name, opts = {}) {
      const c = new Client(name);
      c.ws = new WebSocket(h.url, opts);
      c.ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        c.msgs.push(m);
        c.waiters = c.waiters.filter((w) => !w.try(m));
      });
      c.ws.on('close', (code) => { c.closed = true; c.closeCode = code; });
      await new Promise((res, rej) => { c.ws.on('open', res); c.ws.on('error', rej); });
      h.open.push(c);
      return c;
    }

    send(obj) { this.ws.send(JSON.stringify(obj)); }

    // Next message (already received, or future) whose type is in `types` and matches `pred`.
    waitAny(types, pred = () => true, timeout = 4000) {
      const list = Array.isArray(types) ? types : [types];
      const hit = this.msgs.find((m) => list.includes(m.t) && pred(m));
      if (hit) { this.msgs.splice(this.msgs.indexOf(hit), 1); return Promise.resolve(hit); }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${this.name}: timed out waiting for ${list.join('|')}`)), timeout);
        this.waiters.push({
          try: (m) => {
            if (list.includes(m.t) && pred(m)) {
              clearTimeout(timer);
              this.msgs.splice(this.msgs.indexOf(m), 1);
              resolve(m);
              return true;
            }
            return false;
          },
        });
      });
    }

    waitFor(type, pred, timeout) { return this.waitAny([type], pred, timeout); }
    latest(type) { return [...this.msgs].reverse().find((m) => m.t === type); }
    all(type) { return this.msgs.filter((m) => m.t === type); }
    has(type, pred = () => true) { return this.msgs.some((m) => m.t === type && pred(m)); }

    // --- protocol conveniences ---------------------------------------------------------
    async browse() {
      this.send({ t: 'lobbies', v: PROTOCOL_VERSION });
      return this.waitFor('lobbies');
    }

    // Sends a join request; resolves with the 'joined' message or rejects with the server error.
    async join(lobby, name = this.name, skin = 'classic') {
      this.send({ t: 'join', v: PROTOCOL_VERSION, lobby, name, skin });
      const m = await this.waitAny(['joined', 'error']);
      if (m.t === 'error') throw Object.assign(new Error(m.code), m);
      this.joined = m;
      return m;
    }

    async leave() {
      this.send({ t: 'leave' });
      return this.waitFor('left');
    }
  }

  h.Client = Client;
  h.connect = (name, opts) => Client.connect(name, opts);
  h.lobby = (id = 'lobby-1') => h.server.manager.lobbies.get(id);

  // A connected client that has joined `lobby`.
  h.enter = async (name, { lobby = 'lobby-1', skin = 'classic' } = {}) => {
    const c = await Client.connect(name);
    await c.join(lobby, name, skin);
    return c;
  };

  // Two players in lobby-1 with the match already running (needs the FAST server config).
  h.startedMatch = async ({ lobby = 'lobby-1', hostSkin = 'classic', guestSkin = 'inferno' } = {}) => {
    const host = await h.enter('Alice', { lobby, skin: hostSkin });
    const guest = await h.enter('Bob', { lobby, skin: guestSkin });
    await Promise.all([host.waitFor('match'), guest.waitFor('match')]);
    return { host, guest, hostId: host.joined.you.id, guestId: guest.joined.you.id, lobby };
  };

  h.start = async (opts = {}) => {
    h.server = createServer({
      port: 0,
      allowedOrigins: ['https://kavibz26.github.io', '*localhost'],
      maxConnsPerIp: 500,
      ...h.options,
      ...opts,
    });
    const port = await h.server.listen();
    h.url = `ws://127.0.0.1:${port}`;
    return h;
  };

  h.stop = async () => {
    for (const c of h.open) c.ws.terminate();
    h.open = [];
    if (h.server) await h.server.close();
    h.server = null;
  };

  // Fresh server for every test in the file.
  h.hooks = () => {
    beforeEach(() => h.start());
    afterEach(() => h.stop());
  };
  return h;
}
