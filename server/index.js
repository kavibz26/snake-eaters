import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager, send } from './rooms.js';
import {
  PROTOCOL_VERSION, DIRECTION_NAMES, normalizeCode, isValidCodeFormat,
} from './protocol.js';

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

export function createServer({ port = 8787, allowedOrigins, trustProxy = false, maxRooms, maxConnsPerIp = DEFAULT_MAX_CONNS_PER_IP } = {}) {
  const origins = allowedOrigins || DEFAULT_ORIGINS;
  const manager = new RoomManager({ maxRooms });
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
    ws.ctx = null; // { room, player }
    ws.bucket = { tokens: 40, last: Date.now(), dropped: 0 };
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => onMessage(ws, data));
    ws.on('close', () => {
      const n = (connsByIp.get(ws.ip) || 1) - 1;
      if (n <= 0) connsByIp.delete(ws.ip); else connsByIp.set(ws.ip, n);
      const ctx = ws.ctx;
      if (ctx && ctx.player.ws === ws) ctx.room.handleDisconnect(ctx.player);
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
      case 'create':
      case 'join':
      case 'rejoin':
        if (ctx) return fail(ws, 'bad_state', 'You are already in a room.');
        if (msg.v !== PROTOCOL_VERSION) {
          return fail(ws, 'bad_version', 'Your game is out of date. Refresh the page and try again.');
        }
        return handleEntry(ws, msg);

      case 'start': {
        if (!ctx) return;
        const err = ctx.room.start(ctx.player.id);
        if (err) fail(ws, err.code, err.message);
        return;
      }
      case 'dir': {
        if (!ctx || ctx.room.state !== 'playing' || !ctx.room.match) return;
        if (!DIRECTION_NAMES.has(msg.d)) return;
        ctx.room.match.setDirection(ctx.player.id, msg.d);
        return;
      }
      case 'boost': {
        if (!ctx || ctx.room.state !== 'playing' || !ctx.room.match) return;
        ctx.room.match.activateBoost(ctx.player.id);
        return;
      }
      case 'leave': {
        if (!ctx) return;
        const { room, player } = ctx;
        ws.ctx = null;
        room.removePlayer(player.id, 'leave');
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
    if (msg.t === 'create') {
      const res = manager.createRoom(ws, msg.name, msg.skin);
      if (res.error) return fail(ws, res.error.code, res.error.message);
      ws.ctx = { room: res.room, player: res.player };
      send(ws, res.room.joinedMessage(res.player));
      return;
    }

    const code = normalizeCode(msg.code);
    if (msg.t === 'join') {
      if (!isValidCodeFormat(code)) return fail(ws, 'invalid_room', 'That is not a valid room code.');
      const res = manager.joinRoom(ws, code, msg.name, msg.skin);
      if (res.error) return fail(ws, res.error.code, res.error.message);
      ws.ctx = { room: res.room, player: res.player };
      send(ws, res.room.joinedMessage(res.player));
      res.room.broadcastLobby();
      return;
    }

    // rejoin: id + secret token must both match the seat we kept for them.
    const room = manager.rooms.get(code);
    const player = room && room.players.get(String(msg.id));
    if (!player || typeof msg.token !== 'string' || player.token !== msg.token) {
      return fail(ws, 'invalid_session', 'Your seat in that room has expired.');
    }
    ws.ctx = { room, player };
    room.reconnect(player, ws);
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
