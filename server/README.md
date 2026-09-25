# Snake Eaters multiplayer server

Authoritative WebSocket game server. The frontend (GitHub Pages) only sends
`dir` / `boost` intents; this server simulates every match with the same
`js/` modules single-player uses (`config`, `snake`, `collision`, `food`, `skins`).

```
server/index.js   HTTP /health + WebSocket entry, origin check, rate limits
server/rooms.js   rooms, lobby, host, reconnect grace, match lifecycle
server/match.js   MatchSim: the authoritative tick (port of Game.tick())
server/protocol.js constants, room codes, nickname sanitising
```

## Run locally

```bash
cd server && npm install && npm start      # ws://localhost:8787
npm test                                   # rule-parity + end-to-end tests
```

Serve the frontend on `localhost` (e.g. `node dev-server.js 8090`); it connects to
`ws://localhost:8787` automatically.

## Deploy (Render, free tier)

1. Render dashboard -> **New -> Blueprint** -> pick this GitHub repo (it reads `render.yaml`).
2. When it is live, copy the service URL (`https://<name>.onrender.com`).
3. Set `PRODUCTION_SERVER_URL = 'wss://<name>.onrender.com'` in `js/net/config.js`, commit, push.

Free instances sleep after ~15 min idle; the first connect can take up to a minute
(the UI says so). Any Node host with WebSocket support works (`node server/index.js`, `PORT` env).

Env vars: `PORT`, `ALLOWED_ORIGINS` (comma list, added to `https://kavibz26.github.io`),
`TRUST_PROXY=1` behind a proxy.
