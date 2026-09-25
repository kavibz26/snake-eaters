# Snake Eaters multiplayer server

Authoritative WebSocket game server with **public lobbies**. The frontend (GitHub Pages)
only sends `input` / `chat` intents; this server simulates every match with the same
`js/` modules single-player uses (`config`, `snake`, `collision`, `food`, `skins`).

```
server/index.js     HTTP /health + WebSocket entry, origin check, rate limits, message router
server/lobbies.js   LobbyManager + Lobby: fixed public lobbies, atomic join, auto-start, reconnect grace, chat
server/match.js     MatchSim: the authoritative tick (port of Game.tick()), delta snapshots, leaderboard
server/protocol.js  constants (lobby count / capacity / timers), nickname + chat sanitising
```

## Lobbies

- `LOBBY_COUNT` (default 6) fixed public lobbies, each holding at most `MAX_PLAYERS_PER_LOBBY`
  (default 6, never more than the number of skins). Both live in `server/protocol.js` and can be
  overridden with environment variables.
- Join is one synchronous check-and-insert on the server, so simultaneous joins can never exceed
  the limit. Capacity is never taken from the client.
- 2+ connected players start an automatic countdown (`LOBBY_START_DELAY_MS`, 10 s; shortened to
  `LOBBY_FULL_START_DELAY_MS` when the lobby is full). Fewer than 2 cancels it. Once a match starts
  the lobby is locked until it ends; then everyone is released and the lobby is free again.
- The lobby browser subscribes once (`lobbies`) and receives compact pushes
  (`{t:'lu', id, p, m, s}`) - no polling. Chat and rosters are scoped to the lobby you are in.

## Run locally

```bash
cd server && npm install && npm start      # ws://localhost:8787
npm test                                   # rules, prediction, lobbies, match flow, chat
```

Serve the frontend on `localhost` (e.g. `node dev-server.js 8090`); it connects to
`ws://localhost:8787` automatically.

## Deploy (Render, free tier)

1. Render dashboard -> **New -> Blueprint** -> pick this GitHub repo (it reads `render.yaml`).
2. Set `PRODUCTION_SERVER_URL` in `js/net/config.js` to `wss://<your-service>.onrender.com`.

Free instances sleep after ~15 min idle; the first connect can take up to a minute
(the UI says so). Any Node host with WebSocket support works (`node server/index.js`, `PORT` env).

Env vars: `PORT`, `ALLOWED_ORIGINS` (comma list, added to `https://kavibz26.github.io`),
`TRUST_PROXY=1` behind a proxy, `LOBBY_COUNT`, `MAX_PLAYERS_PER_LOBBY`, `LOBBY_START_DELAY_MS`,
`LOBBY_FULL_START_DELAY_MS`, `COUNTDOWN_MS`, `RECONNECT_GRACE_MS`.
