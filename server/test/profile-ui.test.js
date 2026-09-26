import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Real-browser checks of the profile UI (headless Chrome over the DevTools protocol). If no
// Chrome / Chromium / Edge is installed the whole file is skipped, so `npm test` still runs anywhere.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.json': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let web; let proc; let userDir; let port; let webPort;

class Page {
  constructor(ws) {
    this.ws = ws; this.n = 0; this.pending = new Map(); this.errors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    });
  }
  send(method, params = {}) { const id = ++this.n; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

async function openPage({ w, h, mobile = true, seed }) {
  const target = await new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/json/new?about:blank', method: 'PUT' }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej); req.end();
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  const page = new Page(ws);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  // Tabs of one Chrome profile share localStorage, so every tab starts from a known state - once per tab (a reload must keep what the page saved).
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); ${seed ? `localStorage.setItem('snakeEaters.profile.v1', ${JSON.stringify(JSON.stringify(seed))})` : `localStorage.removeItem('snakeEaters.profile.v1')`}; } } catch (e) {}` });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${webPort}/` });
  await sleep(700);
  page.close = () => { ws.close(); };
  return page;
}

before(async () => {
  if (!CHROME) return;
  web = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/$/, '/index.html'));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  webPort = web.address().port;
  port = 9400 + Math.floor(Math.random() * 400);
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-ui-'));
  proc = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await new Promise((res, rej) => http.get(`http://127.0.0.1:${port}/json/version`, (r) => { r.resume(); r.on('end', res); }).on('error', rej)); break; } catch { await sleep(200); }
  }
});

after(async () => {
  if (proc) proc.kill();
  if (web) await new Promise((r) => web.close(r));
  if (userDir) { try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const SEED = { version: 1, nickname: 'SnakeMaster', xp: 1420, stats: { gamesPlayed: 42, gamesWon: 17, kills: 86, foodEaten: 1234, highestScore: 1540, longestSnake: 58, totalPlayTime: 5423, multiplayerGames: 12, multiplayerWins: 4 }, unlockedSkins: ['classic'], selectedSkin: 'inferno', createdAt: 1, updatedAt: 1 };
const VIEWPORTS = [[320, 568], [375, 667], [390, 844], [430, 932], [568, 320], [667, 375], [844, 390], [932, 430]];

const LAYOUT = `(() => {
  const screen = [...document.querySelectorAll('.screen')].find((s) => !s.classList.contains('hidden'));
  const bad = [...screen.querySelectorAll('button, input')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && getComputedStyle(e).visibility !== 'hidden' && (r.height < 43.5 || r.width < 43.5); }).map((e) => (e.id || e.className) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height));
  const off = [...screen.querySelectorAll('button, input')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1); }).map((e) => e.id || e.className);
  return { id: screen.id, hOverflow: document.documentElement.scrollWidth > innerWidth + 1, scrollPx: screen.scrollHeight - screen.clientHeight, small: bad, off };
})()`;

test('profile UI: menu card, open/close, stats, skins, name editing (real browser)', { skip: !CHROME && 'no Chrome/Chromium/Edge found' }, async () => {
  const page = await openPage({ w: 390, h: 844, seed: SEED });
  try {
    const card = await page.eval(`document.getElementById('profileCard').innerText.replace(/\\s+/g, ' ')`);
    assert.match(card, /SnakeMaster/);
    assert.match(card, /Level 7/);
    assert.match(card, /70 \/ 400 XP/);

    await page.eval(`document.getElementById('profileCard').click()`);
    assert.equal(await page.eval(`!document.getElementById('profileScreen').classList.contains('hidden')`), true, 'profile opens');
    assert.equal(await page.eval(`document.getElementById('startScreen').classList.contains('hidden')`), true);
    const text = await page.eval(`document.getElementById('profileMain').innerText`);
    for (const label of ['SnakeMaster', 'Level', '70 / 400 XP', '330 XP to level 8', '1,540', 'HIGH SCORE', 'Inferno']) assert.ok(text.includes(label), `profile shows ${label}`);

    // name editing: blank rejected, markup neutralised, valid saved and persisted
    await page.eval(`document.getElementById('profileEditBtn').click()`);
    await page.eval(`(() => { const i = document.getElementById('profileNameInput'); i.value = '   '; document.getElementById('profileNameForm').requestSubmit(); })()`);
    assert.equal(await page.eval(`document.getElementById('profileNameError').textContent`), 'Please enter a nickname.');
    await page.eval(`(() => { const i = document.getElementById('profileNameInput'); i.value = '<img src=x onerror=alert(1)>Ace'; document.getElementById('profileNameForm').requestSubmit(); })()`);
    const shown = await page.eval(`({ text: document.getElementById('profileName').textContent, html: document.getElementById('profileName').innerHTML, images: document.querySelectorAll('#profileMain img[src="x"]').length })`);
    assert.ok(!/[<>]/.test(shown.text) && !/[<>]/.test(shown.html.replace(/&lt;|&gt;/g, '')), `no markup in "${shown.text}"`);
    assert.equal(shown.images, 0, 'nothing was injected');
    assert.equal(await page.eval(`document.getElementById('cardName').textContent`), shown.text, 'the menu card follows the edit');
    await sleep(700); // saves are debounced (never per change)
    assert.equal(await page.eval(`JSON.parse(localStorage.getItem('snakeEaters.profile.v1')).nickname`), shown.text, 'persisted');

    // skins: level 7 -> golden is open, shadow (9) and jungle (12) are locked and say why
    await page.eval(`document.getElementById('profileSkinsBtn').click()`);
    const cards = await page.eval(`[...document.querySelectorAll('#profileSkinGrid .skin-card')].map((c) => ({ id: c.dataset.skinId, locked: c.classList.contains('locked'), sel: c.classList.contains('selected'), lock: c.querySelector('.skin-lock').textContent }))`);
    assert.deepEqual(cards.filter((c) => c.locked).map((c) => `${c.id}:${c.lock}`), ['shadow:🔒 Level 9', 'jungle:🔒 Level 12']);
    assert.equal(cards.find((c) => c.sel).id, 'inferno');
    await page.eval(`document.querySelector('#profileSkinGrid .skin-card[data-skin-id="shadow"]').click()`);
    assert.equal(await page.eval(`document.querySelector('#profileSkinGrid .skin-card.selected').dataset.skinId`), 'inferno', 'a locked skin cannot be selected');
    assert.match(await page.eval(`document.getElementById('profileToast').textContent`), /Shadow unlocks at level 9/);
    await page.eval(`document.querySelector('#profileSkinGrid .skin-card[data-skin-id="frost"]').click()`);
    await sleep(700);
    assert.equal(await page.eval(`JSON.parse(localStorage.getItem('snakeEaters.profile.v1')).selectedSkin`), 'frost', 'an unlocked skin can be selected (saved)');

    // close: back to the menu; the menu skin picker agrees
    await page.eval(`document.getElementById('profileSkinsBack').click(); document.getElementById('profileBackBtn').click()`);
    assert.equal(await page.eval(`!document.getElementById('startScreen').classList.contains('hidden')`), true, 'profile closes');
    assert.equal(await page.eval(`document.querySelector('#skinPicker .skin-card.selected').dataset.skinId`), 'frost');
    assert.deepEqual(page.errors, [], 'no console errors');
  } finally { page.close(); }
});

test('profile UI: reload keeps the profile (nickname, XP, selected skin)', { skip: !CHROME && 'no Chrome/Chromium/Edge found' }, async () => {
  const page = await openPage({ w: 390, h: 844, seed: SEED });
  try {
    await page.eval(`document.getElementById('profileCard').click(); document.getElementById('profileSkinsBtn').click(); document.querySelector('#profileSkinGrid .skin-card[data-skin-id="toxic"]').click()`);
    await sleep(600); // let the debounced save run
    await page.send('Page.reload');
    await sleep(800);
    assert.equal(await page.eval(`document.getElementById('cardName').textContent`), 'SnakeMaster');
    assert.match(await page.eval(`document.getElementById('cardLevel').textContent`), /Level 7/);
    assert.equal(await page.eval(`document.querySelector('#skinPicker .skin-card.selected').dataset.skinId`), 'toxic');
  } finally { page.close(); }
});

test('profile UI: a corrupted stored profile does not break the page', { skip: !CHROME && 'no Chrome/Chromium/Edge found' }, async () => {
  const page = await openPage({ w: 390, h: 844, seed: null });
  try {
    await page.eval(`localStorage.setItem('snakeEaters.profile.v1', '{not json')`);
    await page.send('Page.reload');
    await sleep(800);
    assert.match(await page.eval(`document.getElementById('cardName').textContent`), /^Snake\d{4}$/);
    assert.match(await page.eval(`document.getElementById('cardLevel').textContent`), /Level 1/);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test('profile UI: no horizontal overflow, no scrolling, every control >= 44px, on every phone size (portrait + landscape)', { skip: !CHROME && 'no Chrome/Chromium/Edge found', timeout: 90000 }, async () => {
  for (const [w, h] of VIEWPORTS) {
    const page = await openPage({ w, h, seed: SEED });
    try {
      const menu = await page.eval(LAYOUT);
      assert.equal(menu.hOverflow, false, `${w}x${h} menu overflows horizontally`);
      assert.deepEqual(menu.small, [], `${w}x${h} menu: controls under 44px`);
      assert.deepEqual(menu.off, [], `${w}x${h} menu: controls off screen`);

      await page.eval(`document.getElementById('profileCard').click()`);
      const prof = await page.eval(LAYOUT);
      assert.equal(prof.id, 'profileScreen');
      assert.equal(prof.hOverflow, false, `${w}x${h} profile overflows horizontally`);
      assert.equal(prof.scrollPx, 0, `${w}x${h} profile needs ${prof.scrollPx}px of scrolling`);
      assert.deepEqual(prof.small, [], `${w}x${h} profile: controls under 44px`);
      assert.deepEqual(prof.off, [], `${w}x${h} profile: controls off screen`);

      await page.eval(`document.getElementById('profileEditBtn').click()`);
      const edit = await page.eval(LAYOUT);
      assert.equal(edit.scrollPx, 0, `${w}x${h} name editor needs scrolling`);
      assert.deepEqual(edit.small, [], `${w}x${h} name editor: controls under 44px`);
      await page.eval(`document.getElementById('profileNameCancel').click(); document.getElementById('profileSkinsBtn').click()`);
      const skins = await page.eval(LAYOUT);
      assert.equal(skins.hOverflow, false, `${w}x${h} skins overflow horizontally`);
      assert.deepEqual(skins.small, [], `${w}x${h} skins: controls under 44px`);
      assert.deepEqual(page.errors, [], `${w}x${h} console errors`);
    } finally { page.close(); }
  }
});
