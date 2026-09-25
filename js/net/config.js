// Where the multiplayer WebSocket server lives. The frontend is static (GitHub
// Pages), so the server is deployed separately - see server/README.md.
//
// Not a secret: it's a public endpoint, same as any website's API URL.
// Leave empty until the server is deployed; the UI then reports
// "multiplayer isn't available yet" instead of failing mysteriously.
const PRODUCTION_SERVER_URL = '';

const host = typeof location !== 'undefined' ? location.hostname : '';
const isLocal = host === 'localhost' || host === '127.0.0.1';

export const SERVER_URL = isLocal ? `ws://${host}:8787` : PRODUCTION_SERVER_URL;

// Must match server/protocol.js. A mismatch makes the server answer
// "bad_version" so a stale cached page is told to refresh.
export const PROTOCOL_VERSION = 1;

export const CONNECT_TIMEOUT_MS = 45000; // free hosts can take ~a minute to wake from sleep
export const WAKING_HINT_AFTER_MS = 4000;
export const MAX_RECONNECT_ATTEMPTS = 8;
