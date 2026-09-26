import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Real-browser checks that match-event toasts and the results list render cleanly on phones and desktop.
// Skipped when no Chrome / Chromium / Edge is installed.
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

async function booted(page) {
  for (let i = 0; i < 80; i++) {
    try { if (await page.eval(`!!document.getElementById('cardName') && document.getElementById('cardName').textContent.length > 0`)) return; } catch { /* navigating */ }
    await sleep(100);
  }
}

async function openPage({ w, h, mobile = true }) {
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
  await page.send('Page.navigate', { url: `http://127.0.0.1:${webPort}/` });
  await booted(page);
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
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-ev-'));
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

const VIEWPORTS = [[320, 568, true], [390, 844, true], [568, 320, true], [844, 390, true], [1366, 768, false]];

const RECT = `(s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, h: r.height }; }`;

test('event toasts: readable, inside the arena, no overlap with the controls, no scrolling - major and minor, on every size', { skip: !CHROME && 'no Chrome/Chromium/Edge found', timeout: 120000 }, async () => {
  for (const [w, h, mobile] of VIEWPORTS) {
    const page = await openPage({ w, h, mobile });
    try {
      await page.eval(`document.getElementById('playBtn').click()`);
      await sleep(300);
      // a toaster on the real #eventToast element, fed with deliberately long names
      const res = await page.eval(`(async () => {
        const { createEventToaster } = await import('/js/events/ui.js');
        const toaster = createEventToaster(document.getElementById('eventToast'), document.getElementById('gameCanvas'));
        const rect = ${RECT};
        const names = (id) => (id === 'a' ? 'AVeryLongPlayerNm' : 'AnotherVeryLongNm');
        const out = {};
        for (const [label, ev] of [['major', { k: 'first_blood', id: 'a', v: 'b' }], ['minor', { k: 'food_hunter', id: 'a', n: 12 }]]) {
          toaster.show(ev, names, { mine: label === 'major' });
          await new Promise((r) => setTimeout(r, 350));
          const t = document.getElementById('eventToast');
          const tr = rect('#eventToast'), cv = rect('#gameCanvas'), boost = rect('#boostBtn'), dpad = rect('#dpad'), hud = rect('.hud');
          const ov = (a, b) => a && b && a.x < b.r - 0.5 && a.r > b.x + 0.5 && a.y < b.b - 0.5 && a.b > b.y + 0.5;
          out[label] = { visible: !t.classList.contains('hidden'), text: t.innerText.replace(/\\s+/g, ' '), inCanvasX: tr.x >= cv.x - 1 && tr.r <= cv.r + 1, inViewport: tr.x >= 0 && tr.r <= innerWidth && tr.y >= 0 && tr.b <= innerHeight, overlaps: { boost: ov(tr, boost), dpad: ov(tr, dpad), hud: ov(tr, hud) }, h: Math.round(tr.h) };
          toaster.clear();
        }
        const de = document.documentElement;
        out.hOverflow = de.scrollWidth > innerWidth + 1;
        out.vScroll = de.scrollHeight - innerHeight;
        return out;
      })()`);
      const tag = `${w}x${h}`;
      for (const kind of ['major', 'minor']) {
        assert.equal(res[kind].visible, true, `${tag} ${kind}: shown`);
        assert.ok(res[kind].inViewport, `${tag} ${kind}: inside the viewport`);
        assert.ok(res[kind].inCanvasX, `${tag} ${kind}: within the arena width`);
        assert.deepEqual(res[kind].overlaps, { boost: false, dpad: false, hud: false }, `${tag} ${kind}: does not cover the controls or the HUD`);
      }
      assert.match(res.major.text, /FIRST BLOOD/i);
      assert.ok(res.major.h >= res.minor.h, 'the major toast is at least as prominent as a routine one');
      assert.equal(res.hOverflow, false, `${tag}: no horizontal overflow`);
      assert.equal(res.vScroll, 0, `${tag}: no scrolling during play`);
      assert.deepEqual(page.errors, [], `${tag}: console errors`);
    } finally { page.close(); }
  }
});

test('event toasts are paced: a burst never becomes a wall of banners (one at a time, short queue, majors survive)', { skip: !CHROME && 'no Chrome/Chromium/Edge found' }, async () => {
  const page = await openPage({ w: 390, h: 844 });
  try {
    await page.eval(`document.getElementById('playBtn').click()`);
    const res = await page.eval(`(async () => {
      const { createEventToaster } = await import('/js/events/ui.js');
      const { EVENT_TOAST } = await import('/js/events/config.js');
      const el = document.getElementById('eventToast');
      const toaster = createEventToaster(el);
      const name = () => 'P';
      const shownTitles = [];
      const obs = new MutationObserver(() => { const t = el.querySelector('.event-toast-title'); if (t && shownTitles[shownTitles.length - 1] !== t.textContent) shownTitles.push(t.textContent); });
      obs.observe(el, { childList: true, subtree: true });
      // eight events at once: 5 routine + First Blood + Giant Snake + Comeback
      for (const k of ['food_hunter', 'power_collector', 'survivor', 'food_hunter', 'survivor']) toaster.show({ k, id: 'a' }, name);
      toaster.show({ k: 'first_blood', id: 'a', v: 'b' }, name);
      toaster.show({ k: 'giant_snake', id: 'a', n: 25 }, name);
      toaster.show({ k: 'comeback', id: 'a' }, name);
      const simultaneous = document.querySelectorAll('#eventToast').length;
      await new Promise((r) => setTimeout(r, EVENT_TOAST.minorMs * 2 + EVENT_TOAST.majorMs * 3 + 800));
      obs.disconnect();
      // final events are never toasted
      const finalShown = toaster.show({ k: 'most_food', id: 'a', n: 9 }, name) || toaster.show({ k: 'longest_snake', id: 'a', n: 20 }, name);
      return { simultaneous, shownTitles, maxQueue: EVENT_TOAST.maxQueue, finalShown, childrenNow: el.children.length };
    })()`);
    assert.equal(res.simultaneous, 1, 'one toast element, one message at a time');
    assert.ok(res.shownTitles.length <= 1 + res.maxQueue, `at most the current + ${res.maxQueue} queued were shown: ${res.shownTitles.join(', ')}`);
    for (const major of ['First Blood', 'Giant Snake', 'Comeback']) assert.ok(res.shownTitles.some((t) => t.toLowerCase() === major.toLowerCase()), `${major} was not dropped for routine ones`);
    assert.equal(res.finalShown, false, 'end-of-match events are only listed in the results');
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test('results: the events list renders cleanly on every size (chips wrap, nothing overflows, players identified, mine highlighted)', { skip: !CHROME && 'no Chrome/Chromium/Edge found', timeout: 120000 }, async () => {
  for (const [w, h, mobile] of VIEWPORTS) {
    const page = await openPage({ w, h, mobile });
    try {
      const res = await page.eval(`(async () => {
        const { renderEventSummary } = await import('/js/events/ui.js');
        document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
        document.getElementById('mpResultsScreen').classList.remove('hidden');
        const names = { me: 'You', p2: 'AVeryLongPlayerNm', p3: 'Bob' };
        const events = [
          { k: 'first_blood', id: 'p2', v: 'me' }, { k: 'food_hunter', id: 'me', n: 12 }, { k: 'power_collector', id: 'p3', n: 3 }, { k: 'giant_snake', id: 'p2', n: 25 },
          { k: 'survivor', id: 'me', n: 60 }, { k: 'longest_snake', id: 'p2', n: 27 }, { k: 'most_food', id: 'me', n: 15 }, { k: 'comeback', id: 'p3', from: 6 },
        ];
        const box = document.getElementById('mpEvents');
        const count = renderEventSummary(box, events, { nameOf: (id) => names[id] || '?', myId: 'me' });
        const de = document.documentElement;
        const br = box.getBoundingClientRect();
        const chips = [...box.querySelectorAll('.event-chip')];
        return { count, hOverflow: de.scrollWidth > innerWidth + 1, boxInside: br.x >= 0 && br.right <= innerWidth + 1, chipsInside: chips.every((c) => { const r = c.getBoundingClientRect(); return r.right <= br.right + 1 && r.x >= br.x - 1; }), mine: chips.filter((c) => c.classList.contains('event-chip--mine')).length, majors: chips.filter((c) => c.classList.contains('event-chip--major')).length, text: box.innerText.replace(/\\s+/g, ' '), hidden: box.classList.contains('hidden') };
      })()`);
      const tag = `${w}x${h}`;
      assert.equal(res.hidden, false);
      assert.equal(res.count, 8, `${tag}: all events listed`);
      assert.equal(res.hOverflow, false, `${tag}: no horizontal overflow`);
      assert.ok(res.boxInside && res.chipsInside, `${tag}: chips stay inside their card`);
      assert.equal(res.mine, 3, `${tag}: the local player's events are highlighted`);
      assert.equal(res.majors, 3);
      assert.match(res.text, /AVeryLongPlayerNm/, 'the player involved is named');
      assert.deepEqual(page.errors, [], `${tag}: console errors`);
      // an empty list hides the card
      const hidden = await page.eval(`(async () => { const { renderEventSummary } = await import('/js/events/ui.js'); const b = document.getElementById('mpEvents'); renderEventSummary(b, [], { nameOf: () => '?', myId: 'x' }); return b.classList.contains('hidden'); })()`);
      assert.equal(hidden, true, 'no events: nothing is shown');
    } finally { page.close(); }
  }
});

test('event text is written as text: a hostile player name cannot inject markup', { skip: !CHROME && 'no Chrome/Chromium/Edge found' }, async () => {
  const page = await openPage({ w: 390, h: 844 });
  try {
    const res = await page.eval(`(async () => {
      const { renderEventSummary, createEventToaster } = await import('/js/events/ui.js');
      const evil = '<img src=x onerror=window.__pwned=1>';
      const box = document.getElementById('mpEvents');
      renderEventSummary(box, [{ k: 'first_blood', id: 'e', v: 'e' }], { nameOf: () => evil, myId: 'x' });
      createEventToaster(document.getElementById('eventToast')).show({ k: 'giant_snake', id: 'e', n: 25 }, () => evil);
      await new Promise((r) => setTimeout(r, 300));
      return { imgs: document.querySelectorAll('#mpEvents img, #eventToast img').length, pwned: window.__pwned === 1, shown: document.getElementById('eventToast').innerText.includes('<img') };
    })()`);
    assert.equal(res.imgs, 0);
    assert.equal(res.pwned, false);
    assert.equal(res.shown, true, 'displayed literally, as text');
  } finally { page.close(); }
});
