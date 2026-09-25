import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { LobbyManager, send } from './lobbies.js';
import { PROTOCOL_VERSION, DIRECTION_NAMES } from './protocol.js';

const DEFAULT_ORIGINS = ['https://kavibz26.github.io'];
const DEFAULT_MAX_CONNS_PER_IP = 20;
const HEARTBEAT_MS = 20000;

// Browsers always send an Origin on WebSocket handshakes, so we can refuse
// pages we don't know. Non-browser clients (tests, curl) send none and pass.
function isOriginAllowed(origin, allowed) {
  if (!origin) return true;
  if (allowed.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && allowed.includes('*localhost');
}

export function createServer({
  port = 8787, allowedOrigins, trustProxy = false, lobbyCount, maxPlayers, startDelayMs, fullStartDelayMs,
  maxConnsPerIp = DEFAULT_MAX_CONNS_PER_IP,
} = {}) {
  const origins = allowedOrigins || DEFAULT_ORIGINS;
  const manager = new LobbyManager({ lobbyCount, maxPlayers, startDelayMs, fullStartDelayMs });
  const connsByIp = new Map();

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, service: 'snake-eaters', protocol: PROTOCOL_VERSION, ...manager.stats() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    if (!isOriginAllowed(req.headers.origin, origins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const fwd = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    const ip = fwd || req.socket.remoteAddress || 'unknown';
    if ((connsByIp.get(ip) || 0) >= maxConnsPerIp) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.ip = ip;
      connsByIp.set(ip, (connsByIp.get(ip) || 0) + 1);
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.ctx = null; // { lobby, player } while inside a lobby
    ws.bucket = { tokens: 40, last: Date.now(), dropped: 0 };
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => onMessage(ws, data));
    ws.on('close', () => {
      const n = (connsByIp.get(ws.ip) || 1) - 1;
      if (n <= 0) connsByIp.delete(ws.ip); else connsByIp.set(ws.ip, n);
      manager.unsubscribe(ws);
      const ctx = ws.ctx;
      if (ctx && ctx.player.ws === ws) ctx.lobby.handleDisconnect(ctx.player);
    });
    ws.on('error', () => {});
  });

  // Token bucket: ~30 msgs/sec sustained, bursts up to 40. Swipes/D-pad taps
  // never come close; a flooding client gets dropped, then disconnected.
  function allow(ws) {
    const b = ws.bucket;
    const now = Date.now();
    b.tokens = Math.min(40, b.tokens + ((now - b.last) / 1000) * 30);
    b.last = now;
    if (b.tokens < 1) {
      if (++b.dropped > 200) ws.close(1008, 'rate limit');
      return false;
    }
    b.tokens -= 1;
    return true;
  }

  function fail(ws, code, message) {
    send(ws, { t: 'error', code, message });
  }

  function versionOk(ws, msg) {
    if (msg.v === PROTOCOL_VERSION) return true;
    send(ws, { t: 'error', code: 'bad_version', sv: PROTOCOL_VERSION, message: 'Your game is out of date. Refresh the page and try again.' });
    return false;
  }

  function onMessage(ws, data) {
    if (!allow(ws)) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    const ctx = ws.ctx;

    switch (msg.t) {
      // --- lobby browser: subscribe once, then the server pushes changes ('lu') ------------
      case 'lobbies':
        if (ctx) return fail(ws, 'bad_state', 'Leave your lobby first.');
        if (!versionOk(ws, msg)) return;
        manager.subscribe(ws);
        return;
      case 'unbrowse':
        manager.unsubscribe(ws);
        return;

      case 'join':
      case 'rejoin':
        if (ctx) return fail(ws, 'bad_state', 'You are already in a lobby.');
        if (!versionOk(ws, msg)) return;
        return handleEntry(ws, msg);

      // Sequenced gameplay input. The server only ever queues an *intent* on the
      // sender's own snake; seq lets the client match snapshot acks to its
      // predicted inputs. Everything is validated - nothing here can move a
      // snake, score, or touch another player's state.
      case 'input': {
        if (!ctx || !ctx.lobby.match || ctx.lobby.phase !== 'playing') return;
        const seq = msg.seq;
        if (!Number.isSafeInteger(seq) || seq <= 0) return;
        const input = {};
        if (msg.dir !== undefined) {
          if (!DIRECTION_NAMES.has(msg.dir)) return;
          input.dir = msg.dir;
        }
        if (msg.boost !== undefined) {
          if (msg.boost !== true) return;
          input.boost = true;
        }
        if (input.dir === undefined && input.boost === undefined) return;
        ctx.lobby.match.applyInput(ctx.player.id, seq, input);
        return;
      }
      case 'chat': {
        if (!ctx) return;
        const err = ctx.lobby.chat(ctx.player, msg.m);
        if (err) send(ws, { t: 'chat_error', code: err.code, message: err.message });
        return;
      }
      case 'sync': {
        // Client noticed a gap in its delta stream: send it the full state once.
        if (!ctx || !ctx.lobby.match || ctx.lobby.state !== 'running') return;
        send(ws, ctx.lobby.match.snapshot({ full: true }));
        return;
      }
      case 'leave': {
        if (!ctx) return;
        const { lobby, player } = ctx;
        ws.ctx = null;
        lobby.removePlayer(player.id);
        send(ws, { t: 'left' });
        return;
      }
      case 'ping':
        send(ws, { t: 'pong', c: msg.c });
        return;
      default:
    }
  }

  function handleEntry(ws, msg) {
    if (msg.t === 'join') {
      const res = manager.join(ws, msg.lobby, msg.name, msg.skin);
      if (res.error) return fail(ws, res.error.code, res.error.message);
      ws.ctx = { lobby: res.lobby, player: res.player };
      send(ws, res.lobby.joinedMessage(res.player)); // the joiner hears 'joined' first...
      res.lobby._changed(); // ...then everyone (incl. lobby-browser viewers) hears the new roster
      return;
    }

    // rejoin: lobby id + player id + secret token must all match the slot we kept for them.
    const lobby = typeof msg.lobby === 'string' ? manager.lobbies.get(msg.lobby) : undefined;
    const player = lobby && lobby.players.get(String(msg.id));
    if (!player || typeof msg.token !== 'string' || player.token !== msg.token) {
      return fail(ws, 'invalid_session', 'Your slot in that lobby has expired.');
    }
    manager.unsubscribe(ws);
    ws.ctx = { lobby, player };
    lobby.reconnect(player, ws);
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    manager,
    httpServer,
    listen: () => new Promise((resolve) => httpServer.listen(port, () => resolve(httpServer.address().port))),
    close: () => new Promise((resolve) => {
      clearInterval(heartbeat);
      manager.shutdown();
      for (const ws of wss.clients) ws.terminate();
      httpServer.close(() => resolve());
    }),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT) || 8787;
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const server = createServer({
    port,
    allowedOrigins: [...DEFAULT_ORIGINS, '*localhost', ...allowed],
    trustProxy: process.env.TRUST_PROXY === '1',
  });
  server.listen().then((p) => console.log(`Snake Eaters server listening on :${p}`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close().then(() => process.exit(0)));
}
