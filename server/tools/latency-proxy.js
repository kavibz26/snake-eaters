// Development tool: a WebSocket proxy that delays every message (each direction) by
// `delay` ms plus random 0..`jitter` ms, keeping message order (like TCP does), so real
// browser clients can be tested under simulated network latency.
//
//   node server/tools/latency-proxy.js --listen 9001 --target ws://localhost:8787 --delay 50 --jitter 20
//   (browser, localhost only:  http://localhost:8090/?mpServer=ws://localhost:9001 )
//
// Change the latency while running:  GET http://localhost:9001/set?delay=100&jitter=10
// (delay is ONE-WAY, so round-trip added latency = 2 * delay).
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

export function startProxy({ listen = 9001, target = 'ws://localhost:8787', delay = 0, jitter = 0 } = {}) {
  const state = { delay, jitter };
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/set') {
      if (url.searchParams.has('delay')) state.delay = Math.max(0, Number(url.searchParams.get('delay')) || 0);
      if (url.searchParams.has('jitter')) state.jitter = Math.max(0, Number(url.searchParams.get('jitter')) || 0);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(state));
  });
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (client, req) => {
    const upstream = new WebSocket(target, { headers: { Origin: req.headers.origin || '' } });
    const queues = { up: { last: 0, pending: [] }, down: { last: 0, pending: [] } };

    // FIFO with a random delay per message: a later message never overtakes an earlier one.
    const relay = (queue, from, to) => (data, isBinary) => {
      const now = Date.now();
      const due = Math.max(queue.last, now + state.delay + Math.random() * state.jitter);
      queue.last = due;
      setTimeout(() => { if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary }); }, due - now);
    };

    const opened = new Promise((res) => upstream.on('open', res));
    client.on('message', (data, isBinary) => {
      const forward = relay(queues.up, client, upstream);
      opened.then(() => forward(data, isBinary));
    });
    upstream.on('message', relay(queues.down, upstream, client));
    const closeBoth = () => {
      setTimeout(() => { try { client.close(); } catch { /* */ } try { upstream.close(); } catch { /* */ } }, state.delay + state.jitter + 20);
    };
    client.on('close', closeBoth);
    upstream.on('close', closeBoth);
    client.on('error', () => {});
    upstream.on('error', () => { try { client.close(); } catch { /* */ } });
  });

  return new Promise((resolve) => httpServer.listen(listen, () => resolve({ state, close: () => new Promise((r) => { wss.close(); httpServer.close(r); }) })));
}

if (process.argv[1] && process.argv[1].endsWith('latency-proxy.js')) {
  const listen = Number(arg('listen', 9001));
  startProxy({
    listen,
    target: arg('target', 'ws://localhost:8787'),
    delay: Number(arg('delay', 0)),
    jitter: Number(arg('jitter', 0)),
  }).then(() => console.log(`latency proxy on :${listen} -> ${arg('target', 'ws://localhost:8787')} (one-way delay ${arg('delay', 0)}ms + jitter ${arg('jitter', 0)}ms)`));
}
