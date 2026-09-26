// Multiplayer screens: lobby browser -> waiting room -> match -> results, plus the
// user-friendly connection-state messages, live leaderboard, chat and connection
// indicator. Pure DOM glue between the existing start screen, NetClient (transport)
// and NetGame (in-match view). The server decides which lobbies exist, how many
// players are in them and who may join - this file only displays that.
import { NetClient } from './client.js';
import { PROTOCOL_VERSION, MAX_RECONNECT_ATTEMPTS } from './config.js';
import { getSkinById } from '../skins.js';
import { renderSkinPreview } from '../snakeRender.js';
import { createChat } from './chat.js';
import { createBoard } from './board.js';


// Connection-quality thresholds. They apply to the MEDIAN of the last few real pings and only
// once enough samples exist, so one noisy measurement can never flag a connection as bad.
const FAIR_RTT_MS = 120;
const SLOW_RTT_MS = 250;
const MIN_PING_SAMPLES = 3;

const TOAST_MS = 2600;

const FRIENDLY = {
  not_configured: 'Online multiplayer is not available yet - the game server has not been set up.',
  server_unavailable: "Can't reach the multiplayer server right now. Please try again in a moment.",
  lobby_full: 'That lobby just filled up. Pick another one.',
  match_in_progress: 'That lobby just started a match. Pick another one.',
  invalid_lobby: 'That lobby is no longer available. Pick another one.',
  server_busy: 'The server is busy right now. Try again in a minute.',
  bad_state: 'You are already in a lobby.',
};

// Errors that mean "the list you were looking at was out of date".
const STALE_LIST_ERRORS = new Set(['lobby_full', 'match_in_progress', 'invalid_lobby']);

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

// `progress` connects multiplayer to the player's profile (see js/main.js):
//   nickname() / setNickname(raw) -> the profile's validated name; onMatchStart(msg); onMatchOver(msg, myId).
export function initMultiplayer({ showScreen, netGame, getSelectedSkin, activate, deactivate, setYouBadge, progress }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    openBtn: $('multiplayerBtn'),
    gameScreen: $('gameScreen'),
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
    countdown: $('lobbyCountdown'),
    countdownNum: $('lobbyCountdownNum'),
    progress: $('lobbyProgress'),
    playerList: $('playerList'),
    leaveLobbyBtn: $('leaveRoomBtn'),
    resultTitle: $('mpResultTitle'),
    resultSub: $('mpResultSub'),
    standings: $('standings'),
    backToLobbiesBtn: $('backToLobbyBtn'),
    banner: $('mpBanner'),
    toast: $('mpToast'),
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
  for (const pill of pills) {
    // label + ms live in separate spans so narrow screens can drop the word and keep the number
    const text = pill.querySelector('.mp-conn-text');
    text.textContent = '';
    const label = document.createElement('span');
    label.className = 'mp-conn-label';
    const ms = document.createElement('span');
    ms.className = 'mp-conn-ms';
    text.append(label, ms);
  }

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
  let countdownTimer = null;
  let countdownEndsAt = 0;
  let countdownTotalMs = 1;
  let toastTimer = null;
  let roster = null; // id -> { name, connected } of the lobby we are in, to announce joins/leaves
  const cards = new Map(); // lobby id -> { li, count, state, btn, pips, data }

  const go = (name) => { screen = name; showScreen(name); updateConn(); };

  // --- small helpers ---------------------------------------------------------------------------------

  function setStatus(node, text, kind) {
    node.textContent = text || '';
    node.classList.toggle('error', kind === 'error');
    node.classList.toggle('ok', kind === 'ok');
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

  // --- connection indicator ------------------------------------------------------------------------------
  // States: Connecting / Connected / Reconnecting (n/max) / Disconnected. While connected it shows the
  // MEDIAN of the last few real ping round trips, coloured only once there are enough samples.

  function connState() {
    const status = net.status;
    if (status === 'connecting') return { cls: 'pending', label: 'Connecting...', ms: '' };
    if (status === 'reconnecting') {
      const n = net.reconnectAttempt;
      return { cls: 'pending', label: n > 0 ? `Reconnecting... ${n}/${MAX_RECONNECT_ATTEMPTS}` : 'Reconnecting...', ms: '' };
    }
    if (status === 'disconnected' || status === 'unavailable') return { cls: 'bad', label: 'Disconnected', ms: '' };
    if (status === 'idle') return null;
    const median = net.rttMedian;
    if (median === null) return { cls: 'neutral', label: 'Connected', ms: '' };
    const ms = `${Math.round(median)} ms`;
    if (net.rttWindow.length < MIN_PING_SAMPLES) return { cls: 'neutral', label: 'Connected', ms };
    if (median >= SLOW_RTT_MS) return { cls: 'bad', label: 'Slow connection', ms };
    if (median >= FAIR_RTT_MS) return { cls: 'warn', label: 'Connected', ms };
    return { cls: 'ok', label: 'Connected', ms };
  }

  function updateConn() {
    const st = connState();
    const forScreen = { browser: pills[0], lobby: pills[1], mpResults: pills[2], game: inMatch ? pills[3] : null }[screen];
    for (const pill of pills) {
      const active = pill === forScreen && st !== null;
      pill.classList.toggle('hidden', !active);
      if (!active) continue;
      pill.className = `mp-conn mp-conn--${st.cls}`;
      pill.querySelector('.mp-conn-label').textContent = st.label;
      pill.querySelector('.mp-conn-ms').textContent = st.ms ? `· ${st.ms}` : '';
      pill.title = st.ms ? 'Round-trip time to the game server (median of your last 5 pings)' : '';
    }
  }
  net.on('latency', updateConn);

  // --- lobby browser ---------------------------------------------------------------------------------------

  function openBrowser(message, kind) {
    el.nick.value = progress.nickname();
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
      renderLobbyList(list.lobbies);
      if (!keepMessage) setStatus(el.browserStatus, '');
    } catch (err) {
      if (screen !== 'browser') return;
      setStatus(el.browserStatus, friendly(err), 'error');
      el.retryBtn.classList.remove('hidden');
    }
  }

  // Silent re-sync of the list (used when a join was refused because our view was stale).
  async function refreshLobbies() {
    try {
      const list = await net.browseLobbies();
      if (screen === 'browser') renderLobbyList(list.lobbies);
    } catch { /* the status line already explains the failed join */ }
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
      cards.set(l.id, { li, count, state, btn, pips, data: null });
      updateCard(l);
    }
  }

  // Compact server push ({id, p, m, s}) -> update just that card, in place.
  function updateCard(u) {
    const c = cards.get(u.id);
    if (!c) return;
    const full = u.p >= u.m;
    const running = u.s === 'running';
    const unavailable = full || running;
    c.count.textContent = `🐍 ${u.p}/${u.m} players`;
    c.state.textContent = full ? 'Full' : running ? 'In game' : u.s === 'countdown' ? 'Starting' : 'Waiting';
    if (!c.btn.classList.contains('is-joining')) c.btn.textContent = full ? 'FULL' : running ? 'IN GAME' : 'JOIN';
    c.btn.disabled = unavailable || joining;
    c.btn.setAttribute('aria-label', `${full ? 'Full' : running ? 'In game' : 'Join'} ${(c.data && c.data.name) || u.name || u.id}, ${u.p} of ${u.m} players`);
    c.btn.classList.toggle('btn-secondary', unavailable);
    c.btn.classList.toggle('btn-primary', !unavailable);
    c.li.classList.toggle('lobby-card--full', unavailable);
    c.li.dataset.state = full ? 'full' : u.s;
    [...c.pips.children].forEach((pip, i) => pip.classList.toggle('on', i < u.p));
    c.pips.title = `${u.p} of ${u.m} slots taken`;
    c.data = { ...u, name: u.name || (c.data && c.data.name) };
  }

  net.on('lobby_update', (u) => { if (screen === 'browser') updateCard(u); });

  function setJoining(value, id) {
    joining = value;
    for (const [cid, c] of cards) {
      c.btn.classList.toggle('is-joining', value && cid === id);
      if (c.data) updateCard(c.data);
      if (value && cid === id) c.btn.textContent = 'JOINING';
    }
  }

  async function joinLobby(id) {
    if (joining) return; // double-click / double-tap safe: the flag is set before anything async
    const check = progress.setNickname(el.nick.value);
    if (!check.ok) {
      setStatus(el.browserStatus, check.error, 'error');
      el.nick.focus();
      return;
    }
    const nick = check.value;
    el.nick.value = nick;
    setJoining(true, id);
    setStatus(el.browserStatus, 'Joining...');
    try {
      const joined = await net.joinLobby(id, nick, getSelectedSkin().id);
      onJoined(joined);
    } catch (err) {
      setStatus(el.browserStatus, friendly(err), 'error');
      if (err.code === 'server_unavailable') el.retryBtn.classList.remove('hidden');
      else if (STALE_LIST_ERRORS.has(err.code)) refreshLobbies(); // make sure what we show matches the server
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
    roster = null; // first render of this lobby: nothing to announce yet
    renderLobby(msg.lobby, note);
    go('lobby');
  }

  // Compares the roster with the previous one and tells the player, quietly, what changed.
  function announceRosterChanges(l) {
    const next = new Map(l.players.map((p) => [p.id, { name: p.name, connected: p.connected }]));
    const you = net.you && net.you.id;
    const added = [];
    if (roster) {
      for (const [id, p] of next) {
        if (id === you) continue;
        const before = roster.get(id);
        if (!before) { added.push(id); notify(`${p.name} joined`, 'join'); }
        else if (before.connected && !p.connected) notify(`${p.name} lost connection`, 'warn');
        else if (!before.connected && p.connected) notify(`${p.name} reconnected`, 'join');
      }
      for (const [id, p] of roster) if (id !== you && !next.has(id)) notify(`${p.name} left`, 'leave');
    }
    roster = next;
    return added;
  }

  // In the waiting room: a line in the chat log. In a match: a short toast that never blocks input.
  function notify(text) {
    if (screen === 'lobby') {
      lobbyChat.notice(text);
      return;
    }
    if (screen !== 'game') return;
    gameChat.notice(text);
    el.toast.textContent = text;
    el.toast.classList.remove('hidden');
    el.toast.style.animation = 'none';
    void el.toast.offsetWidth; // restart the entrance animation for back-to-back toasts
    el.toast.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), TOAST_MS);
  }

  function renderLobby(l, note) {
    const you = net.you && net.you.id;
    el.lobbyTitle.textContent = l.name;
    el.lobbyCount.textContent = `${l.players.length}/${l.max}`;
    const added = new Set(announceRosterChanges(l));

    el.playerList.textContent = '';
    for (const p of l.players) {
      const li = document.createElement('li');
      li.className = 'player-row' + (p.connected ? '' : ' player-row--dc') + (p.id === you ? ' player-row--me' : '') + (added.has(p.id) ? ' player-row--new' : '');
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
    const counting = l.state === 'countdown';
    el.countdown.classList.toggle('hidden', !counting);
    if (counting) {
      countdownEndsAt = performance.now() + l.startsInMs;
      countdownTotalMs = Math.max(l.startsInMs, 1000);
    }
    const paint = () => {
      let text;
      let kind;
      if (counting) {
        const left = Math.max(0, countdownEndsAt - performance.now());
        const secs = Math.ceil(left / 1000);
        el.countdownNum.textContent = String(secs);
        el.progress.style.width = `${Math.max(0, Math.min(100, (left / countdownTotalMs) * 100))}%`;
        text = `Match starts in ${secs}s - more players can still join.`;
        kind = 'ok';
      } else if (l.state === 'running') { text = 'Game starting...'; kind = 'ok'; }
      else if (connected < l.min) text = 'Waiting for more players...';
      else text = 'Get ready...';
      setStatus(el.lobbyStatus, note ? `${note} ${text}` : text, kind);
    };
    if (counting) countdownTimer = setInterval(paint, 250);
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
    roster = null;
    deactivate();
    openBrowser(message, kind);
  }

  net.on('lobby', (l) => {
    if (screen === 'lobby') renderLobby(l);
    else if (screen === 'game') announceRosterChanges(l); // quiet toast for players who drop / return mid-match
  });

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

  // Big 3 / 2 / 1 / GO! numerals for the countdown; ordinary text for connection / spectating messages.
  netGame.onBanner = (text) => {
    const b = el.banner;
    const isCount = Boolean(text) && /^(\d|GO!)$/.test(text);
    b.textContent = text || '';
    b.classList.toggle('hidden', !text);
    b.classList.remove('mp-banner--count', 'mp-banner--go');
    if (isCount) {
      void b.offsetWidth; // restart the pop animation for every new numeral
      b.classList.add('mp-banner--count');
      if (text === 'GO!') b.classList.add('mp-banner--go');
    }
  };

  // Live leaderboard: order, scores and alive flags all come from the server's snapshots.
  netGame.onBoard = (rows) => board.update(rows);

  netGame.onPauseRequest = () => el.leaveOverlay.classList.toggle('hidden');
  el.stayBtn.addEventListener('click', () => el.leaveOverlay.classList.add('hidden'));
  el.leaveBtn.addEventListener('click', () => leaveLobby());

  function startMatchUi() {
    inMatch = true;
    el.gameScreen.classList.add('mp-mode');
    board.clear();
    el.board.classList.remove('hidden');
    el.chatToggle.classList.remove('hidden');
    unread = 0;
    el.chatBadge.classList.add('hidden');
    el.toast.classList.add('hidden');
  }

  function stopMatchUi() {
    inMatch = false;
    el.gameScreen.classList.remove('mp-mode');
    clearTimeout(toastTimer);
    board.clear();
    el.board.classList.add('hidden');
    el.chatToggle.classList.add('hidden');
    el.chatBadge.classList.add('hidden');
    el.chatDrawer.classList.add('hidden');
    el.leaveOverlay.classList.add('hidden');
    el.toast.classList.add('hidden');
    el.hudConn.classList.add('hidden');
  }

  // --- network events -----------------------------------------------------------------------------------------------

  net.on('match', (msg) => {
    clearInterval(countdownTimer);
    const me = msg.players.find((p) => p.id === msg.you);
    if (me) setYouBadge(getSkinById(me.skinId));
    netGame.setConnectionText(null);
    progress.onMatchStart(msg);
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
    progress.onMatchOver(msg, netGame.myId); // rewards from the server's results, applied once
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
    // The connection died while browsing (not inside a lobby): say so and offer a retry.
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
    roster = null;
    openBrowser('Disconnected from the server, and your slot in the lobby has expired.', 'error');
  });

  // --- results (order, winner and survival all decided by the server) -------------------------------------------------

  const MEDALS = ['🥇', '🥈', '🥉'];

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
      li.className = 'player-row' + (r.id === you ? ' player-row--me' : '') + (r.id === msg.winnerId ? ' player-row--winner' : '');
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = r.id === msg.winnerId && r.rank === 1 ? MEDALS[0] : (r.rank <= 3 ? MEDALS[r.rank - 1] : `#${r.rank}`);
      rank.title = `Rank ${r.rank}`;
      li.appendChild(rank);
      li.appendChild(miniSkin(r.skinId, 42, 30));
      const main = document.createElement('span');
      main.className = 'standing-main';
      const name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = r.id === you ? `${r.name} (you)` : r.name;
      const stats = document.createElement('span');
      stats.className = 'standing-stats';
      // Only figures the server actually reports: score, kills and final length.
      stats.textContent = `${r.score} pts · ${r.kills} ${r.kills === 1 ? 'kill' : 'kills'} · length ${r.length}`;
      main.append(name, stats);
      li.appendChild(main);
      const status = document.createElement('span');
      status.className = 'tag ' + (r.survived ? 'tag--you' : 'tag--dc');
      status.textContent = r.survived ? 'SURVIVED' : 'ELIMINATED';
      li.appendChild(status);
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
    roster = null;
    openBrowser();
  });

  return { get net() { return net; } };
}
