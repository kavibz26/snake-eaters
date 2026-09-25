// Multiplayer screens: menu (nickname / create / join), lobby, results, plus
// user-friendly connection-state messages. Pure DOM glue between the existing
// start screen, NetClient (transport) and NetGame (in-match view).
import { NetClient } from './client.js';
import { getSkinById } from '../skins.js';
import { renderSkinPreview } from '../snakeRender.js';

const NICK_KEY = 'snakeEatersNick';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

const FRIENDLY = {
  not_configured: 'Online multiplayer is not available yet - the game server has not been set up.',
  server_unavailable: "Can't reach the multiplayer server right now. Please try again in a moment.",
  invalid_room: 'No room with that code. Check the code and try again.',
  room_full: 'That room is full.',
  match_in_progress: 'That match has already started. Ask the host to finish it, then join again.',
  bad_version: 'Your game is out of date. Refresh the page and try again.',
  server_busy: 'The server is busy right now. Try again in a minute.',
  need_players: 'You need at least 2 players to start.',
  not_host: 'Only the host can start the match.',
};

function friendly(err) {
  return FRIENDLY[err && err.code] || (err && err.message) || 'Something went wrong. Please try again.';
}

export function initMultiplayer({ showScreen, netGame, getSelectedSkin, activate, deactivate, setYouBadge }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    openBtn: $('multiplayerBtn'),
    menuStatus: $('mpMenuStatus'),
    nick: $('mpNick'),
    skinPreview: $('mpSkinPreview'),
    skinName: $('mpSkinName'),
    createBtn: $('mpCreateBtn'),
    joinToggle: $('mpJoinToggleBtn'),
    joinForm: $('mpJoinForm'),
    code: $('mpCode'),
    joinBtn: $('mpJoinBtn'),
    backBtn: $('mpBackBtn'),
    roomCode: $('roomCode'),
    copyBtn: $('copyCodeBtn'),
    lobbyStatus: $('lobbyStatus'),
    playerList: $('playerList'),
    startBtn: $('startMatchBtn'),
    leaveRoomBtn: $('leaveRoomBtn'),
    resultTitle: $('mpResultTitle'),
    resultSub: $('mpResultSub'),
    standings: $('standings'),
    backToLobbyBtn: $('backToLobbyBtn'),
    resultsLeaveBtn: $('resultsLeaveBtn'),
    banner: $('mpBanner'),
    leaveOverlay: $('mpLeaveOverlay'),
    stayBtn: $('mpStayBtn'),
    leaveBtn: $('mpLeaveBtn'),
  };

  const net = new NetClient();
  netGame.attach(net);

  let screen = 'start'; // which MP screen is showing, for routing async events
  let busy = false;
  let copyTimer = null;
  let resultReason = '';

  const go = (name) => { screen = name; showScreen(name); };

  // --- helpers ----------------------------------------------------------------------------------

  function setStatus(node, text, kind) {
    node.textContent = text || '';
    node.classList.toggle('error', kind === 'error');
    node.classList.toggle('ok', kind === 'ok');
  }

  function cleanNick(raw) {
    const nick = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 14);
    return nick || 'Player';
  }

  function setBusy(value) {
    busy = value;
    for (const b of [el.createBtn, el.joinToggle, el.joinBtn, el.backBtn]) b.disabled = value;
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

  // --- menu ------------------------------------------------------------------------------------------

  function openMenu(message, kind) {
    try { el.nick.value = localStorage.getItem(NICK_KEY) || ''; } catch { /* storage unavailable */ }
    const skin = getSelectedSkin();
    renderSkinPreview(el.skinPreview, skin);
    el.skinName.textContent = `${skin.emoji} ${skin.name}`;
    el.joinForm.classList.add('hidden');
    setBusy(false);
    setStatus(el.menuStatus, message || '', kind);
    go('mpMenu');
  }

  async function enterRoom(action) {
    if (busy) return;
    const nick = cleanNick(el.nick.value);
    try { localStorage.setItem(NICK_KEY, nick); } catch { /* ignore */ }
    setBusy(true);
    setStatus(el.menuStatus, 'Connecting to server...');
    try {
      const joined = await action(nick, getSelectedSkin().id);
      onJoined(joined);
    } catch (err) {
      setStatus(el.menuStatus, friendly(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  el.openBtn.addEventListener('click', () => openMenu());
  el.backBtn.addEventListener('click', () => go('start'));
  el.createBtn.addEventListener('click', () => enterRoom((n, s) => net.createRoom(n, s)));
  el.joinToggle.addEventListener('click', () => {
    el.joinForm.classList.toggle('hidden');
    if (!el.joinForm.classList.contains('hidden')) el.code.focus();
  });
  el.code.addEventListener('input', () => {
    el.code.value = [...el.code.value.toUpperCase()].filter((c) => CODE_ALPHABET.includes(c)).join('').slice(0, CODE_LENGTH);
  });
  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = el.code.value;
    if (code.length !== CODE_LENGTH) {
      setStatus(el.menuStatus, `Room codes are ${CODE_LENGTH} characters long.`, 'error');
      return;
    }
    enterRoom((n, s) => net.joinRoom(code, n, s));
  });

  // --- lobby -------------------------------------------------------------------------------------------

  function onJoined(msg) {
    const me = msg.room.players.find((p) => p.id === msg.you.id);
    const selected = getSelectedSkin();
    let note = '';
    if (me && me.skinId !== selected.id) {
      const assigned = getSkinById(me.skinId);
      setYouBadge(assigned);
      note = `${selected.name} was already taken - you are playing as ${assigned.name}.`;
    } else {
      setYouBadge(selected);
    }
    renderLobby(msg.room, note);
    go('lobby');
  }

  function renderLobby(room, note) {
    el.roomCode.textContent = room.code;
    const you = net.you && net.you.id;
    const isHost = room.hostId === you;
    const connected = room.players.filter((p) => p.connected).length;

    el.playerList.textContent = '';
    for (const p of room.players) {
      const li = document.createElement('li');
      li.className = 'player-row' + (p.connected ? '' : ' player-row--dc');
      li.appendChild(miniSkin(p.skinId));
      const name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = p.name;
      li.appendChild(name);
      const tags = [];
      if (p.id === room.hostId) tags.push(['HOST', 'tag--host']);
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

    el.startBtn.classList.toggle('hidden', !isHost);
    el.startBtn.disabled = room.state !== 'lobby' || connected < room.min;

    let text;
    let kind;
    if (room.state === 'starting') { text = 'Game starting...'; kind = 'ok'; }
    else if (connected < room.min) text = `Waiting for players... (${connected}/${room.max})`;
    else if (isHost) { text = `${connected} players ready - start whenever you like.`; kind = 'ok'; }
    else text = 'Waiting for the host to start the match...';
    setStatus(el.lobbyStatus, note ? `${note} ${text}` : text, kind);
  }

  el.startBtn.addEventListener('click', () => net.startMatch());
  el.leaveRoomBtn.addEventListener('click', () => leaveRoom());
  el.resultsLeaveBtn.addEventListener('click', () => leaveRoom());
  el.backToLobbyBtn.addEventListener('click', () => {
    if (net.room) { renderLobby(net.room); go('lobby'); } else openMenu();
  });

  async function copyCode() {
    const code = el.roomCode.textContent;
    let ok = false;
    try {
      await navigator.clipboard.writeText(code);
      ok = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    el.copyBtn.textContent = ok ? 'Copied!' : 'Press and hold the code to copy';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { el.copyBtn.textContent = 'Copy Code'; }, 1800);
  }
  el.copyBtn.addEventListener('click', copyCode);

  function leaveRoom(message, kind) {
    net.leave();
    netGame.stop();
    el.leaveOverlay.classList.add('hidden');
    deactivate();
    openMenu(message, kind);
  }

  // --- in-match --------------------------------------------------------------------------------------------

  netGame.onBanner = (text) => {
    el.banner.textContent = text || '';
    el.banner.classList.toggle('hidden', !text);
    el.banner.classList.toggle('mp-banner--big', Boolean(text) && /^(Get ready|GO)/.test(text));
  };

  netGame.onPauseRequest = () => el.leaveOverlay.classList.toggle('hidden');
  el.stayBtn.addEventListener('click', () => el.leaveOverlay.classList.add('hidden'));
  el.leaveBtn.addEventListener('click', () => leaveRoom());

  // --- network events -----------------------------------------------------------------------------------------

  net.on('room', (room) => {
    if (screen === 'lobby') renderLobby(room);
  });

  net.on('match', (msg) => {
    const me = msg.players.find((p) => p.id === msg.you);
    if (me) setYouBadge(getSkinById(me.skinId));
    netGame.setConnectionText(null);
    netGame.beginMatch(msg);
    el.leaveOverlay.classList.add('hidden');
    activate();
    go('game');
  });

  net.on('snap', (snap) => netGame.applySnapshot(snap));

  net.on('over', (msg) => {
    netGame.finish();
    el.leaveOverlay.classList.add('hidden');
    showResults(msg);
  });

  net.on('error', (err) => {
    if (screen === 'lobby') setStatus(el.lobbyStatus, friendly(err), 'error');
  });

  net.on('status', ({ status, detail }) => {
    if (busy && screen === 'mpMenu') {
      if (status === 'connecting') {
        setStatus(el.menuStatus, detail === 'waking'
          ? 'Waking the server up - the first connection can take up to a minute...'
          : 'Connecting to server...');
      } else if (status === 'connected') {
        setStatus(el.menuStatus, 'Connected!', 'ok');
      }
    }
    if (status === 'reconnecting') {
      if (screen === 'game') netGame.setConnectionText('Connection lost - reconnecting...');
      else if (screen === 'lobby') setStatus(el.lobbyStatus, 'Connection lost - reconnecting...', 'error');
      else if (screen === 'mpResults') setStatus(el.resultSub, 'Connection lost - reconnecting...', 'error');
    } else if (status === 'connected' && detail === 'rejoined') {
      netGame.setConnectionText(null);
      if (screen === 'lobby' && net.room) renderLobby(net.room, 'Reconnected.');
      else if (screen === 'mpResults') setStatus(el.resultSub, resultReason, '');
    }
  });

  net.on('lost', () => {
    netGame.stop();
    deactivate();
    openMenu('Disconnected from the server, and your seat in the room has expired.', 'error');
  });

  // --- results ---------------------------------------------------------------------------------------------------------

  function showResults(msg) {
    const you = net.you && net.you.id;
    const winner = msg.results.find((r) => r.id === msg.winnerId);
    if (msg.winnerId === you) el.resultTitle.textContent = 'Victory!';
    else if (!winner) el.resultTitle.textContent = 'Draw';
    else el.resultTitle.textContent = `${winner.name} wins!`;
    const reasons = { last_standing: 'Last snake standing.', draw: 'Nobody survived.', time_limit: 'Time limit reached - the biggest snake wins.' };
    resultReason = reasons[msg.reason] || '';
    setStatus(el.resultSub, resultReason);

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
      const stats = document.createElement('span');
      stats.className = 'standing-stats';
      stats.textContent = `${r.score} pts - ${r.kills} kills`;
      li.appendChild(stats);
      el.standings.appendChild(li);
    }
    go('mpResults');
  }

  return { get net() { return net; } };
}
