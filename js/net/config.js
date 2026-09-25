// Where the multiplayer WebSocket server lives. The frontend is static (GitHub
// Pages), so the server is deployed separately - see server/README.md.
//
// Not a secret: it's a public endpoint, same as any website's API URL.
// If left empty, the UI reports "multiplayer isn't available yet" instead of
// failing mysteriously.
const PRODUCTION_SERVER_URL = 'wss://snake-eaters-server.onrender.com';

const host = typeof location !== 'undefined' ? location.hostname : '';
const isLocal = host === 'localhost' || host === '127.0.0.1';

// Development only: a page served from localhost may point at another local WebSocket
// (e.g. the latency-injecting proxy in server/tools). Ignored on the real site.
const devOverride = isLocal && typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('mpServer')
  : null;
const safeOverride = devOverride && /^ws:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(devOverride) ? devOverride : null;

export const SERVER_URL = safeOverride || (isLocal ? `ws://${host}:8787` : PRODUCTION_SERVER_URL);

// Must match server/protocol.js. A mismatch makes the server answer
// "bad_version" so a stale cached page is told to refresh.
export const PROTOCOL_VERSION = 3;

export const CONNECT_TIMEOUT_MS = 45000; // free hosts can take ~a minute to wake from sleep
export const WAKING_HINT_AFTER_MS = 4000;
export const MAX_RECONNECT_ATTEMPTS = 8;
export const PING_INTERVAL_MS = 2000;
export const RTT_MEDIAN_WINDOW = 5; // pings the connection indicator's median is taken over
