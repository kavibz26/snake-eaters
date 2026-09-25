// Multiplayer screens: lobby browser -> waiting room -> match -> results, plus the
// user-friendly connection-state messages, live leaderboard, chat and connection
// indicator. Pure DOM glue between the existing start screen, NetClient (transport)
// and NetGame (in-match view). The server decides which lobbies exist, how many
// players are in them and who may join - this file only displays that.
import { NetClient } from './client.js';
import { PROTOCOL_VERSION } from './config.js';
import { getSkinById } from '../skins.js';
import { renderSkinPreview } from '../snakeRender.js';
import { createChat } from './chat.js';
import { createBoard } from './board.js';

const NICK_KEY = 'snakeEatersNick';

const FRIENDLY = {
  not_configured: 'Online multiplayer is not available yet - the game server has not been set up.',
  server_unavailable: "Can't reach the multiplayer server right now. Please try again in a moment.",
  lobby_full: 'That lobby just filled up. Pick another one.',
  match_in_progress: 'That lobby is in the middle of a match. Pick another one.',
  invalid_lobby: 'That lobby is no longer available. Pick another one.',
  server_busy: 'The server is busy right now. Try again in a minute.',
  bad_state: 'You are already in a lobby.',
};

function friendly(err) {
  if (err && err.code === 'bad_version') {
    // sv = the server's protocol version. Newer than ours: our cached page is stale.
    // Older (or unknown): the server has not finished deploying the update yet.
    return err.sv && err.sv > PROTOCOL_VERSION
      ? 'Your game is out of date. Refresh the page and try again.'
      : 'The game server is being updated. Please try again in a minute or two.';
  }
  return FRIENDLY[err && err.code] || (err && err.message) || 'Something went wrong. Please try again.';
}

export function initMultiplayer({ showScreen, netGame, getSelectedSkin, activate, deactivate, setYouBadge }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    openBtn: $('multiplayerBtn'),
    browserStatus: $('browserStatus'),
    nick: $('mpNick'),
    skinPreview: $('mpSkinPreview'),
    skinName: $('mpSkinName'),
    lobbyList: $('lobbyList'),
    retryBtn: $('browserRetryBtn'),
    backBtn: $('mpBackBtn'),
    lobbyTitle: $('lobbyTitle'),
    lobbyCount: $('lobbyCount'),
    lobbyStatus: $('lobbyStatus'),
    playerList: $('playerList'),
    leaveLobbyBtn: $('leaveRoomBtn'),
    resultTitle: $('mpResultTitle'),
    resultSub: $('mpResultSub'),
    standings: $('standings'),
    backToLobbiesBtn: $('backToLobbyBtn'),
    banner: $('mpBanner'),
    leaveOverlay: $('mpLeaveOverlay'),
    stayBtn: $('mpStayBtn'),
    leaveBtn: $('mpLeaveBtn'),
    board: $('mpBoard'),
    chatToggle: $('chatToggleBtn'),
    chatBadge: $('chatBadge'),
    chatDrawer: $('chatDrawer'),
    chatClose: $('chatCloseBtn'),
    hudConn: $('hudConn'),
  };
  const pills = [$('browserConn'), $('lobbyConn'), $('resultsConn'), el.hudConn];

  const net = new NetClient();
  netGame.attach(net);

  const board = createBoard(el.board);
  const lobbyChat = createChat({
    log: $('lobbyChatLog'), form: $('lobbyChatForm'), input: $('lobbyChatInput'), onSend: (t) => net.sendChat(t),
  });
  const gameChat = createChat({
    log: $('gameChatLog'), form: $('gameChatForm'), input: $('gameChatInput'),
    onSend: (t) => { net.sendChat(t); closeChatDrawer(); },
  });

  let screen = 'start'; // which MP screen is showing, for routing async events
  let joining = false;
  let unread = 0;
  let inMatch = false;
  let maxPlayers = 6; // replaced by what the server reports; never used to decide capacity
  let countdownTimer = null;
  let countdownEndsAt = 0;
  const cards = new Map(); // lobby id -> { li, count, state, btn, pips }

  const go = (name) => { screen = name; showScreen(name); updateConn(); };

  // --- small helpers ---------------------------------------------------------------------------------

  function setStatus(node, text, kind) {
    node.textContent = text || '';
    node.classList.toggle('error', kind === 'error');
    node.classList.toggle('ok', kind === 'ok');
  }

  function cleanNick(raw) {
    const nick = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 14);
    return nick || 'Player';
  }

  function miniSkin(skinId, w = 56, h = 40) {
    const canvas = document.createElement('canvas');
    canvas.width = 84;
    canvas.height = 60;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    renderSkinPreview(canvas, getSkinById(skinId));
    return canvas;
  }

  // --- connection indicator (informational; the ms figure is a REAL measured ping) ------------------------

  function updateConn() {
    const status = net.status;
    let text = 'Connected';
    let cls = 'ok';
    if (status === 'reconnecting') { text = 'Reconnecting...'; cls = 'warn'; }
    else if (status === 'connecting') { text = 'Connecting...'; cls = 'warn'; }
    else if (status === 'disconnected' || status === 'unavailable') { text = 'Disconnected'; cls = 'bad'; }
    else if (status === 'idle') { text = ''; }
    else if (net.rtt !== null) text = `Connected · ${Math.round(net.rtt)} ms`;

    const forScreen = { browser: pills[0], lobby: pills[1], mpResults: pills[2], game: inMatch ? pills[3] : null }[screen];
    for (const pill of pills) {
      const active = pill === forScreen && text !== '';
      pill.classList.toggle('hidden', !active);
      if (!active) continue;
      pill.className = `mp-conn mp-conn--${cls}`;
      pill.querySelector('.mp-conn-text').textContent = text;
    }
  }
  net.on('latency', updateConn);

  // --- lobby browser ---------------------------------------------------------------------------------------

  function openBrowser(message, kind) {
    try { el.nick.value = localStorage.getItem(NICK_KEY) || ''; } catch { /* storage unavailable */ }
    const skin = getSelectedSkin();
    renderSkinPreview(el.skinPreview, skin);
    el.skinName.textContent = `${skin.emoji} ${skin.name}`;
    setStatus(el.browserStatus, message || '', kind);
    go('browser');
    loadLobbies(Boolean(message));
  }

  // Connects, subscribes, and shows the list. After this the server PUSHES changes; we never poll.
  async function loadLobbies(keepMessage) {
    el.retryBtn.classList.add('hidden');
    el.lobbyList.textContent = '';
    cards.clear();
    if (!keepMessage) setStatus(el.browserStatus, 'Connecting to server...');
    try {
      const list = await net.browseLobbies();
      if (screen !== 'browser') return;
      maxPlayers = list.max;
      renderLobbyList(list.lobbies);
      if (!keepMessage) setStatus(el.browserStatus, '');
    } catch (err) {
      if (screen !== 'browser') return;
      setStatus(el.browserStatus, friendly(err), 'error');
      el.retryBtn.classList.remove('hidden');
    }
  }

  function renderLobbyList(list) {
    el.lobbyList.textContent = '';
    cards.clear();
    for (const l of list) {
      const li = document.createElement('li');
      li.className = 'lobby-card';
      const info = document.createElement('div');
      info.className = 'lobby-info';
      const name = document.createElement('span');
      name.className = 'lobby-name';
      name.textContent = l.name;
      const meta = document.createElement('span');
      meta.className = 'lobby-meta';
      const count = document.createElement('span');
      count.className = 'lobby-players';
      const state = document.createElement('span');
      state.className = 'lobby-state';
      meta.append(count, state);
      const pips = document.createElement('span');
      pips.className = 'lobby-pips';
      pips.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < l.m; i++) pips.appendChild(document.createElement('i'));
      info.append(name, meta, pips);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary lobby-join';
      btn.addEventListener('click', () => joinLobby(l.id));
      li.append(info, btn);
      el.lobbyList.appendChild(li);
      cards.set(l.id, { li, count, state, btn, pips, name: l.name });
      updateCard(l);
    }
  }

  // Compact server push ({id, p, m, s}) -> update just that card, in place.
  function updateCard(u) {
    const c = cards.get(u.id);
    if (!c) return;
    const full = u.p >= u.m;
    const running = u.s === 'running';
    c.count.textContent = `🐍 ${u.p}/${u.m} players`;
    c.state.textContent = full ? 'Full' : running ? 'Match in progress' : u.s === 'countdown' ? 'Starting soon' : 'Waiting for players';
    c.btn.textContent = full ? 'FULL' : running ? 'IN MATCH' : 'JOIN';
    c.btn.disabled = full || running || joining;
    c.btn.classList.toggle('btn-secondary', full || running);
    c.btn.classList.toggle('btn-primary', !(full || running));
    c.li.classList.toggle('lobby-card--full', full || running);
    c.li.dataset.state = full ? 'full' : u.s;
    [...c.pips.children].forEach((pip, i) => pip.classList.toggle('on', i < u.p));
    c.pips.title = `${u.p} of ${u.m} slots taken`;
    c.data = u;
  }

  net.on('lobby_update', (u) => { if (screen === 'browser') updateCard(u); });

  function setJoining(value) {
    joining = value;
    for (const c of cards.values()) if (c.data) updateCard(c.data);
  }

  async function joinLobby(id) {
    if (joining) return;
    const nick = cleanNick(el.nick.value);
    try { localStorage.setItem(NICK_KEY, nick); } catch { /* ignore */ }
    setJoining(true);
    setStatus(el.browserStatus, 'Joining...');
    try {
      const joined = await net.joinLobby(id, nick, getSelectedSkin().id);
      onJoined(joined);
    } catch (err) {
      // The list on screen is kept current by server pushes, so it already reflects why we were refused.
      setStatus(el.browserStatus, friendly(err), 'error');
      if (err.code === 'server_unavailable') el.retryBtn.classList.remove('hidden');
    } finally {
      setJoining(false);
    }
  }

  el.openBtn.addEventListener('click', () => openBrowser());
  el.retryBtn.addEventListener('click', () => loadLobbies(false));
  el.backBtn.addEventListener('click', () => {
    net.disconnect();
    go('start');
  });

  // --- waiting room ---------------------------------------------------------------------------------------

  function onJoined(msg) {
    const me = msg.lobby.players.find((p) => p.id === msg.you.id);
    const selected = getSelectedSkin();
    let note = '';
    if (me && me.skinId !== selected.id) {
      const assigned = getSkinById(me.skinId);
      setYouBadge(assigned);
      note = `${selected.name} was already taken - you are playing as ${assigned.name}.`;
    } else {
      setYouBadge(selected);
    }
    setStatus(el.browserStatus, '');
    renderLobby(msg.lobby, note);
    go('lobby');
  }

  function renderLobby(l, note) {
    const you = net.you && net.you.id;
    el.lobbyTitle.textContent = l.name;
    el.lobbyCount.textContent = `${l.players.length}/${l.max}`;

    el.playerList.textContent = '';
    for (const p of l.players) {
      const li = document.createElement('li');
      li.className = 'player-row' + (p.connected ? '' : ' player-row--dc') + (p.id === you ? ' player-row--me' : '');
      li.appendChild(miniSkin(p.skinId));
      const name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = p.name;
      li.appendChild(name);
      const tags = [];
      if (p.id === you) tags.push(['YOU', 'tag--you']);
      if (!p.connected) tags.push(['RECONNECTING', 'tag--dc']);
      for (const [text, cls] of tags) {
        const tag = document.createElement('span');
        tag.className = `tag ${cls}`;
        tag.textContent = text;
        li.appendChild(tag);
      }
      el.playerList.appendChild(li);
    }

    // Waiting for a second player / counting down to an automatic start / starting.
    clearInterval(countdownTimer);
    const connected = l.players.filter((p) => p.connected).length;
    const paint = () => {
      let text;
      let kind;
      if (l.state === 'countdown') {
        const secs = Math.max(0, Math.ceil((countdownEndsAt - performance.now()) / 1000));
        text = `Match starts in ${secs}s - more players can still join.`;
        kind = 'ok';
      } else if (l.state === 'running') { text = 'Game starting...'; kind = 'ok'; }
      else if (connected < l.min) text = 'Waiting for more players...';
      else text = 'Get ready...';
      setStatus(el.lobbyStatus, note ? `${note} ${text}` : text, kind);
    };
    if (l.state === 'countdown') {
      countdownEndsAt = performance.now() + l.startsInMs;
      countdownTimer = setInterval(paint, 250);
    }
    paint();
  }

  el.leaveLobbyBtn.addEventListener('click', () => leaveLobby());

  // Back to the lobby browser without dropping the connection.
  function leaveLobby(message, kind) {
    clearInterval(countdownTimer);
    if (net.session) net.leave();
    netGame.stop();
    stopMatchUi();
    lobbyChat.clear();
    gameChat.clear();
    deactivate();
    openBrowser(message, kind);
  }

  net.on('lobby', (l) => { if (screen === 'lobby') renderLobby(l); });

  // --- chat (scoped to the lobby we are in; the server only sends it to its members) ----------------------

  net.on('chathistory', (msgs) => {
    lobbyChat.clear();
    gameChat.clear();
    for (const m of msgs) { lobbyChat.add(m, net.you && net.you.id); gameChat.add(m, net.you && net.you.id); }
  });

  net.on('chat', (m) => {
    const me = net.you && net.you.id;
    lobbyChat.add(m, me);
    gameChat.add(m, me);
    if (screen === 'game' && el.chatDrawer.classList.contains('hidden') && m.id !== me) {
      unread++;
      el.chatBadge.textContent = unread > 9 ? '9+' : String(unread);
      el.chatBadge.classList.remove('hidden');
    }
  });

  net.on('chat_error', (e) => {
    lobbyChat.notice(e.message);
    gameChat.notice(e.message);
  });

  function openChatDrawer() {
    el.chatDrawer.classList.remove('hidden');
    unread = 0;
    el.chatBadge.classList.add('hidden');
    gameChat.focus();
  }

  function closeChatDrawer() {
    el.chatDrawer.classList.add('hidden');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  el.chatToggle.addEventListener('click', () => (el.chatDrawer.classList.contains('hidden') ? openChatDrawer() : closeChatDrawer()));
  el.chatClose.addEventListener('click', closeChatDrawer);
  gameChat.input.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChatDrawer(); });
  // Enter opens the chat during a match (desktop); typing there never steers the snake.
  window.addEventListener('keydown', (e) => {
    if (screen !== 'game' || !inMatch || e.key !== 'Enter') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    openChatDrawer();
  });

  // --- in-match ------------------------------------------------------------------------------------------------

  netGame.onBanner = (text) => {
    el.banner.textContent = text || '';
    el.banner.classList.toggle('hidden', !text);
    el.banner.classList.toggle('mp-banner--big', Boolean(text) && /^(Get ready|GO)/.test(text));
  };

  // Live leaderboard: order, scores and alive flags all come from the server's snapshots.
  netGame.onBoard = (rows) => board.update(rows);

  netGame.onPauseRequest = () => el.leaveOverlay.classList.toggle('hidden');
  el.stayBtn.addEventListener('click', () => el.leaveOverlay.classList.add('hidden'));
  el.leaveBtn.addEventListener('click', () => leaveLobby());

  function startMatchUi() {
    inMatch = true;
    board.clear();
    el.board.classList.remove('hidden');
    el.chatToggle.classList.remove('hidden');
    unread = 0;
    el.chatBadge.classList.add('hidden');
  }

  function stopMatchUi() {
    inMatch = false;
    board.clear();
    el.board.classList.add('hidden');
    el.chatToggle.classList.add('hidden');
    el.chatBadge.classList.add('hidden');
    el.chatDrawer.classList.add('hidden');
    el.leaveOverlay.classList.add('hidden');
    el.hudConn.classList.add('hidden');
  }

  // --- network events -----------------------------------------------------------------------------------------------

  net.on('match', (msg) => {
    clearInterval(countdownTimer);
    const me = msg.players.find((p) => p.id === msg.you);
    if (me) setYouBadge(getSkinById(me.skinId));
    netGame.setConnectionText(null);
    netGame.beginMatch(msg);
    el.leaveOverlay.classList.add('hidden');
    startMatchUi();
    activate();
    go('game');
  });

  net.on('snap', (snap, recvAt) => netGame.applySnapshot(snap, recvAt));

  net.on('over', (msg) => {
    netGame.finish();
    stopMatchUi();
    showResults(msg);
  });

  net.on('error', (err) => {
    if (screen === 'lobby') setStatus(el.lobbyStatus, friendly(err), 'error');
  });

  net.on('status', ({ status, detail }) => {
    updateConn();
    if (status === 'reconnecting') {
      netGame.connectionLost();
      if (screen === 'game') netGame.setConnectionText('Connection lost - reconnecting...');
      else if (screen === 'lobby') setStatus(el.lobbyStatus, 'Connection lost - reconnecting...', 'error');
    } else if (status === 'connected' && detail === 'rejoined') {
      netGame.setConnectionText(null);
      if (screen === 'lobby' && net.lobby) renderLobby(net.lobby, 'Reconnected.');
    } else if (status === 'connecting' && detail === 'waking' && screen === 'browser') {
      setStatus(el.browserStatus, 'Waking the server up - the first connection can take up to a minute...');
    }
  });

  // The connection died while browsing (not inside a lobby): say so and offer a retry.
  net.on('status', ({ status }) => {
    if (screen === 'browser' && (status === 'disconnected' || status === 'unavailable') && !joining) {
      setStatus(el.browserStatus, 'Lost connection to the server.', 'error');
      el.retryBtn.classList.remove('hidden');
      el.lobbyList.textContent = '';
      cards.clear();
    }
  });

  net.on('lost', () => {
    netGame.stop();
    stopMatchUi();
    deactivate();
    openBrowser('Disconnected from the server, and your slot in the lobby has expired.', 'error');
  });

  // --- results (order, winner and survival all decided by the server) -------------------------------------------------

  function showResults(msg) {
    const you = msg.results.find((r) => r.id === netGame.myId) ? netGame.myId : null;
    const winner = msg.results.find((r) => r.id === msg.winnerId);
    if (msg.winnerId && msg.winnerId === you) el.resultTitle.textContent = 'Victory!';
    else if (!winner) el.resultTitle.textContent = 'Draw';
    else el.resultTitle.textContent = `${winner.name} wins!`;
    const reasons = { last_standing: 'Last snake standing.', draw: 'Nobody survived.', time_limit: 'Time limit reached - the biggest snake wins.' };
    setStatus(el.resultSub, reasons[msg.reason] || '');

    el.standings.textContent = '';
    for (const r of msg.results) {
      const li = document.createElement('li');
      li.className = 'player-row' + (r.id === you ? ' player-row--me' : '');
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = `#${r.rank}`;
      li.appendChild(rank);
      li.appendChild(miniSkin(r.skinId, 42, 30));
      const name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = r.id === you ? `${r.name} (you)` : r.name;
      li.appendChild(name);
      const status = document.createElement('span');
      status.className = 'tag ' + (r.survived ? 'tag--you' : 'tag--dc');
      status.textContent = r.survived ? 'SURVIVED' : 'ELIMINATED';
      li.appendChild(status);
      const stats = document.createElement('span');
      stats.className = 'standing-stats';
      stats.textContent = `${r.score} pts - ${r.kills} kills`;
      li.appendChild(stats);
      el.standings.appendChild(li);
    }
    go('mpResults');
  }

  // The server already released us from the lobby when the match ended.
  el.backToLobbiesBtn.addEventListener('click', () => {
    netGame.stop();
    deactivate();
    lobbyChat.clear();
    gameChat.clear();
    openBrowser();
  });

  return { get net() { return net; } };
}
