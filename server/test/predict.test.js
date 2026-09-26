import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../js/config.js';
import { MatchSim } from '../match.js';
import { LocalPredictor, predictorState } from '../../js/net/predict.js';
import { SnapTracker, DIR_VECS, DIR_NAMES, dirIndex, encodeBodyDelta, applyBodyDelta } from '../../js/net/snapcodec.js';

const UP = DIR_VECS[0];
const LEFT = DIR_VECS[2];
const TICK = CONFIG.TICK_MS;

function makeSim(placeMe = { head: [30, 30], len: 6, dir: 'right' }) {
  const sim = new MatchSim([
    { id: 'me', name: 'Me', skinId: 'classic' },
    { id: 'ot', name: 'Ot', skinId: 'inferno' },
  ]);
  sim.food.items.clear();
  sim.food.target = 0;
  const me = sim.byId.get('me');
  me.body = Array.from({ length: placeMe.len }, (_, i) => ({ x: placeMe.head[0] - i, y: placeMe.head[1] }));
  me.direction = CONFIG.DIRECTIONS[placeMe.dir];
  me.pendingDirection = me.direction;
  me.inputBuffer = [];
  const ot = sim.byId.get('ot');
  ot.body = Array.from({ length: 4 }, (_, i) => ({ x: 70 - i, y: 50 }));
  ot.direction = CONFIG.DIRECTIONS.right;
  ot.pendingDirection = ot.direction;
  sim._commitBaseline();
  return sim;
}

// A predictor that has already received a few per-tick snapshots (so it knows the
// tick phase and the round trip), with the server one tick further along.
function primed({ rtt = 100, dir = 'right' } = {}) {
  const sim = makeSim({ head: [30, 30], len: 6, dir });
  const pred = new LocalPredictor();
  const tracker = new SnapTracker();
  tracker.apply(sim.snapshot({ full: true }));
  let now = 0;
  for (let k = 1; k <= 5; k++) {
    sim.tick();
    const snap = JSON.parse(JSON.stringify(sim.snapshot()));
    tracker.apply(snap);
    now = 1000 + k * TICK + rtt / 2; // arrival = tick time + one-way delay
    pred.noteRtt(rtt);
    pred.noteSnapshot(k, now);
    const s = snap.snakes.find((x) => x.id === 'me');
    pred.onSnapshot(predictorState(snap, s, tracker.bodies.get('me')), tracker.food, now);
  }
  return { sim, pred, tracker, now };
}

// --- unit: what the local snake does the moment you press -----------------------------------------

test('a turn takes effect immediately in the predicted state (no waiting for the server)', () => {
  const { pred, now } = primed({ rtt: 100 });
  const t = now + 40;
  pred.displayCells(t);
  const headBefore = { ...pred.curCells[0] };
  const prevHead = { ...pred.prevCells[0] };
  assert.deepEqual({ x: headBefore.x - prevHead.x, y: headBefore.y - prevHead.y }, { x: 1, y: 0 }, 'gliding right before the press');

  assert.equal(pred.addInput('dir', UP, 1, t), true);
  assert.deepEqual(pred.direction(t), UP, 'predicted heading is already "up"');
  const step = { x: pred.curCells[0].x - pred.prevCells[0].x, y: pred.curCells[0].y - pred.prevCells[0].y };
  assert.deepEqual(step, { x: 0, y: -1 }, 'the step being glided toward now goes up');
});

test('prediction leads the snapshot stream by the round trip time', () => {
  const slow = primed({ rtt: 40 });
  const fast = primed({ rtt: 240 });
  const tSlow = slow.now + 10;
  const tFast = fast.now + 10;
  assert.ok(fast.pred.targetTick(tFast) > slow.pred.targetTick(tSlow), 'higher latency => predict further ahead');
  assert.ok(fast.pred.targetTick(tFast) - fast.pred.baseTick >= 2, '240ms RTT is at least 2 ticks ahead of the last snapshot');
});

test('reversal is rejected in prediction exactly like on the server', () => {
  const { pred, now } = primed({ dir: 'right' });
  pred.addInput('dir', LEFT, 1, now + 20);
  assert.deepEqual(pred.direction(now + 20), CONFIG.DIRECTIONS.right, 'still heading right');
});

test('several turns between ticks are all kept, in order (chained swipe / D-pad taps)', () => {
  const { pred, now } = primed({ rtt: 60 });
  const t = now + 30;
  pred.addInput('dir', UP, 1, t);
  pred.addInput('dir', LEFT, 2, t + 5);
  // Let two more ticks of the prediction play out.
  pred.displayCells(t + 5 + 2 * TICK);
  assert.deepEqual(pred.direction(t + 5 + 2 * TICK), LEFT, 'ended up heading left');
  const c = pred.curCells;
  assert.equal(c[0].x - c[1].x, -1, 'the head is now to the left of the neck');
  // corner shape: somewhere behind the head the body went up by exactly one row.
  const ys = new Set(c.map((p) => p.y));
  assert.ok(ys.size >= 2, 'the body bends (it turned up before turning left)');
});

test('boost is predicted immediately: extra step, timers running, and no double-trigger', () => {
  const { pred, now } = primed({ rtt: 80 });
  const t = now + 20;
  assert.equal(pred.canBoost(), true);
  pred.addInput('boost', null, 1, t);
  const b = pred.predictedBoost();
  assert.ok(b.ticksLeft > 0 && b.ticksLeft <= CONFIG.BOOST_DURATION_TICKS);
  assert.equal(pred.canBoost(), false);
  const moved = Math.abs(pred.curCells[0].x - pred.prevCells[0].x) + Math.abs(pred.curCells[0].y - pred.prevCells[0].y);
  assert.equal(moved, 2, 'boost step advances two cells');
});

test('acknowledged inputs are dropped; unacknowledged ones are replayed on the fresh state', () => {
  const { sim, pred, tracker, now } = primed({ rtt: 100 });
  const t = now + 30;
  pred.addInput('dir', UP, 1, t);
  assert.equal(pred.inputs.length, 1);

  // Snapshot with ack=0: the server hasn't seen the input yet.
  sim.tick();
  let snap = JSON.parse(JSON.stringify(sim.snapshot()));
  tracker.apply(snap);
  const a1 = now + TICK;
  pred.noteSnapshot(6, a1);
  pred.onSnapshot(predictorState(snap, snap.snakes.find((x) => x.id === 'me'), tracker.bodies.get('me')), tracker.food, a1);
  assert.equal(pred.inputs.length, 1, 'still unacknowledged');
  assert.deepEqual(pred.direction(a1), UP, 'still predicting the turn on top of the new authoritative state');

  // Now the server processes it.
  assert.equal(sim.applyInput('me', 1, { dir: 'up' }), true);
  sim.tick();
  snap = JSON.parse(JSON.stringify(sim.snapshot()));
  tracker.apply(snap);
  const a2 = now + 2 * TICK;
  pred.noteSnapshot(7, a2);
  const me = snap.snakes.find((x) => x.id === 'me');
  assert.equal(me.q, 1, 'snapshot carries the acknowledgement');
  pred.onSnapshot(predictorState(snap, me, tracker.bodies.get('me')), tracker.food, a2);
  assert.equal(pred.inputs.length, 0, 'acknowledged input removed');
  assert.deepEqual(pred.direction(a2), UP);
});

test('an input the server never acknowledges expires instead of being replayed forever', () => {
  const { sim, pred, tracker, now } = primed({ rtt: 100 });
  pred.addInput('dir', UP, 1, now + 10);
  const later = now + 5000;
  sim.tick();
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  tracker.apply(snap);
  pred.noteSnapshot(6, later);
  pred.onSnapshot(predictorState(snap, snap.snakes.find((x) => x.id === 'me'), tracker.bodies.get('me')), tracker.food, later);
  assert.equal(pred.inputs.length, 0);
});

test('prediction never draws the snake leaving the arena and never predicts a death', () => {
  const sim = makeSim({ head: [82, 30], len: 5, dir: 'right' });
  const pred = new LocalPredictor();
  const tracker = new SnapTracker();
  tracker.apply(sim.snapshot({ full: true }));
  pred.noteRtt(300);
  pred.noteSnapshot(1, 1000 + TICK);
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  pred.onSnapshot(predictorState(snap, snap.snakes.find((x) => x.id === 'me'), tracker.bodies.get('me')), tracker.food, 1000 + TICK);
  pred.displayCells(1000 + TICK * 4);
  for (const c of pred.curCells) assert.ok(c.x >= 0 && c.x < CONFIG.GRID_COLS);
});

// --- snapshot codec ---------------------------------------------------------------------------------

test('delta snapshots reconstruct the exact server state every tick (bodies and food)', () => {
  let bytesDelta = 0;
  let bytesFull = 0;
  let totalTicks = 0;
  for (let match = 0; match < 8 && totalTicks < 300; match++) {
  const sim = new MatchSim([
    { id: 'a', name: 'A', skinId: 'classic' },
    { id: 'b', name: 'B', skinId: 'inferno' },
    { id: 'c', name: 'C', skinId: 'frost' },
  ]);
  const tracker = new SnapTracker();
  tracker.apply(sim.snapshot({ full: true }));
  const seq = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 400 && !sim.over; i++) {
    for (const id of ['a', 'b', 'c']) {
      const sn = sim.byId.get(id);
      if (!sn.alive) continue;
      const nearWall = sn.head.x + sn.direction.x * 5 < 2 || sn.head.x + sn.direction.x * 5 > 81 || sn.head.y + sn.direction.y * 5 < 2 || sn.head.y + sn.direction.y * 5 > 57;
      if (nearWall || Math.random() < 0.1) {
        const opts = sn.direction.x !== 0 ? ['up', 'down'] : ['left', 'right'];
        sim.applyInput(id, ++seq[id], { dir: opts[Math.floor(Math.random() * 2)] });
      }
      if (Math.random() < 0.02) sim.applyInput(id, ++seq[id], { boost: true });
    }
    sim.tick();
    const snap = JSON.parse(JSON.stringify(sim.snapshot()));
    bytesDelta += JSON.stringify(snap).length;
    bytesFull += JSON.stringify(sim.snapshot({ full: true })).length;
    tracker.apply(snap);
    assert.equal(tracker.needsSync, false, `tick ${sim.tickCount}: delta must always be decodable`);
    for (const s of sim.snakes) {
      const want = s.alive ? s.body.flatMap((c) => [c.x, c.y]) : undefined;
      assert.deepEqual(tracker.bodies.get(s.playerId), want, `tick ${sim.tickCount} body of ${s.playerId}`);
    }
    const foodWant = [...sim.food.all()].map((f) => `${f.x},${f.y}`).sort();
    assert.deepEqual([...tracker.food.keys()].sort(), foodWant, `tick ${sim.tickCount} food`);
  }
  totalTicks += sim.tickCount;
  }
  assert.ok(totalTicks >= 300, `ran a meaningful number of ticks (${totalTicks})`);
  assert.ok(bytesDelta < bytesFull * 0.6, `deltas are much smaller than full snapshots (${bytesDelta} vs ${bytesFull})`);
});

test('a missed delta is detected and a full snapshot repairs the client', () => {
  const sim = makeSim();
  const tracker = new SnapTracker();
  tracker.apply(sim.snapshot({ full: true }));
  sim.tick();
  sim.snapshot(); // this one is "lost" on the way
  sim.tick();
  const snap2 = JSON.parse(JSON.stringify(sim.snapshot()));
  tracker.apply(snap2);
  // (Bodies still decode because a head-run delta applies to the older body, but food
  // deltas / lengths can now be wrong.) The client asks for a full sync when a delta
  // cannot be applied at all - simulate that by corrupting the client's body length.
  tracker.bodies.set('me', tracker.bodies.get('me').slice(0, 4));
  sim.tick();
  const snap3 = JSON.parse(JSON.stringify(sim.snapshot()));
  tracker.apply(snap3);
  if (snap3.snakes.find((s) => s.id === 'me').h) assert.equal(tracker.needsSync, true, 'client notices it cannot apply the delta');
  tracker.apply(JSON.parse(JSON.stringify(sim.snapshot({ full: true }))));
  assert.equal(tracker.needsSync, false);
  const me = sim.byId.get('me');
  assert.deepEqual(tracker.bodies.get('me'), me.body.flatMap((c) => [c.x, c.y]));
});

test('body delta encode/decode round trip incl. growth and boost double-moves', () => {
  const prev = [5, 5, 4, 5, 3, 5, 2, 5];
  for (const next of [
    [6, 5, 5, 5, 4, 5, 3, 5], // moved
    [6, 5, 5, 5, 4, 5, 3, 5, 2, 5], // moved + grew
    [7, 5, 6, 5, 5, 5, 4, 5], // boost: two head cells
    prev, // bounced: nothing changed
  ]) {
    const d = encodeBodyDelta(prev, next);
    assert.ok(d, JSON.stringify(next));
    assert.deepEqual(applyBodyDelta(prev, d.h, d.n), next);
  }
  assert.equal(encodeBodyDelta(prev, [1, 1, 1, 2, 1, 3, 1, 4, 1, 5, 1, 6]), null, 'an unrelated body needs a full send');
});

// --- integration: virtual-time network simulation ---------------------------------------------------------

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Runs a whole match against a virtual clock: server ticks every 150ms, packets take
// `up`/`down` ms (+ random jitter), and a scripted player presses keys based on what
// its OWN predicted snake looks like. Measures how responsive and how accurate the
// prediction is, and how long the same turns would take without it.
function simulate({ up, down, jitter = 0, seconds = 40, seed = 1, stopInputsAt = Infinity, serverTickMs = TICK, rttStepAt = Infinity, rttStepMs = 0 }) {
  const rand = mulberry32(seed);
  const jit = () => rand() * jitter;
  const sim = new MatchSim([
    { id: 'me', name: 'Me', skinId: 'classic' },
    { id: 'ot', name: 'Ot', skinId: 'inferno' },
  ]);
  // These simulations measure MOVEMENT prediction under latency. Power-ups are switched off here because a Shield hold
  // on a body collision (a documented, rare correction) would otherwise add random mismatches; power-ups have their own tests.
  sim.specials.cooldown = 1e9;
  const pred = new LocalPredictor();
  const tracker = new SnapTracker();
  tracker.apply(sim.snapshot({ full: true }));
  const deaths = [];
  const origKill = sim._killSnake.bind(sim);
  sim._killSnake = (sn, killer, cause) => { deaths.push(`tick ${sim.tickCount} ${sn.playerId} ${cause}`); return origKill(sn, killer, cause); };

  const events = [];
  const push = (time, kind, data) => events.push({ time, kind, data, n: events.length });
  const T0 = 37; // server tick phase, unknown to the client
  let seq = 0;
  let otSeq = 0;
  let lastArrival = 0;
  let nextPress = 400;
  let nextPing = 50;
  let lastBoost = 0;
  const pressed = []; // { seq, dir, time }
  const stats = { turns: 0, instantTurns: 0, snapshots: 0, mismatches: 0, mismatchAfterQuiet: 0, snapshotsAfterQuiet: 0, sent: 0 };
  const baseline = []; // ms from press to the first snapshot showing the turn

  push(T0 + serverTickMs, 'tick', 1);
  push(nextPress, 'press');
  push(nextPing, 'ping');

  const dirName = (v) => DIR_NAMES[dirIndex(v)];
  let over = false;

  while (events.length && !over) {
    events.sort((a, b) => a.time - b.time || a.n - b.n);
    const ev = events.shift();
    const t = ev.time;
    if (t > seconds * 1000) break;

    if (ev.kind === 'ping') {
      const extra = t >= rttStepAt ? rttStepMs : 0;
      const rtt = up + jit() + down + jit() + extra;
      push(t + rtt, 'pong', rtt);
      push(t + 2000, 'ping');
    } else if (ev.kind === 'pong') {
      pred.noteRtt(ev.data);
    } else if (ev.kind === 'tick') {
      // The server-side opponent just wanders (and avoids walls) so the match lasts.
      const ot = sim.byId.get('ot');
      if (ot.alive) {
        const h = ot.head;
        const d = ot.direction;
        const near = h.x + d.x * 6 < 3 || h.x + d.x * 6 > 80 || h.y + d.y * 6 < 3 || h.y + d.y * 6 > 56;
        if (near || rand() < 0.08) {
          const own = new Set(ot.body.map((c) => c.x + ',' + c.y));
          const all = d.x !== 0 ? ['up', 'down'] : ['left', 'right'];
          const free = all.filter((n) => !own.has((h.x + CONFIG.DIRECTIONS[n].x) + ',' + (h.y + CONFIG.DIRECTIONS[n].y)) && !own.has((h.x + 2 * CONFIG.DIRECTIONS[n].x) + ',' + (h.y + 2 * CONFIG.DIRECTIONS[n].y)));
          const options = free.length ? free : all;
          const pick = near ? options.sort((p, q) => Math.hypot(h.x + CONFIG.DIRECTIONS[p].x * 9 - 42, h.y + CONFIG.DIRECTIONS[p].y * 9 - 30) - Math.hypot(h.x + CONFIG.DIRECTIONS[q].x * 9 - 42, h.y + CONFIG.DIRECTIONS[q].y * 9 - 30))[0] : options[Math.floor(rand() * 2)];
          sim.applyInput('ot', ++otSeq, { dir: pick });
        }
      }
      sim.tick();
      const snap = JSON.parse(JSON.stringify(sim.snapshot()));
      const arrival = Math.max(lastArrival + 0.01, t + down + jit() + (t >= rttStepAt ? rttStepMs / 2 : 0));
      lastArrival = arrival;
      push(arrival, 'snap', snap);
      if (sim.over) over = true;
      else push(T0 + (ev.data + 1) * serverTickMs, 'tick', ev.data + 1);
    } else if (ev.kind === 'snap') {
      const snap = ev.data;
      const me = snap.snakes.find((x) => x.id === 'me');
      // Accuracy: what did we predict for THIS tick before hearing about it?
      const predicted = pred.history.get(snap.tick);
      tracker.apply(snap);
      const flat = tracker.bodies.get('me');
      if (me.a && flat) {
        if (predicted && snap.tick > 25) {
          stats.snapshots++;
          const off = Math.abs(predicted.x - flat[0]) + Math.abs(predicted.y - flat[1]);
          if (off > 0) stats.mismatches++;
          if (t > stopInputsAt + 3000) {
            stats.snapshotsAfterQuiet++;
            if (off > 0) stats.mismatchAfterQuiet++;
          }
        }
        // Baseline: first snapshot whose committed heading shows a pending press.
        for (const p of pressed) {
          if (p.seen || me.q < p.seq) continue;
          if (me.d[0] === p.dir.x && me.d[1] === p.dir.y) { p.seen = true; baseline.push(t - p.time); }
        }
        pred.noteSnapshot(snap.tick, t);
        pred.onSnapshot(predictorState(snap, me, flat), tracker.food, t);
      } else {
        pred.onSnapshot({ alive: false, cells: [] }, tracker.food, t);
        over = over || !me.a;
      }
    } else if (ev.kind === 'inputArrives') {
      sim.applyInput('me', ev.data.seq, ev.data.input);
    } else if (ev.kind === 'press') {
      if (t < stopInputsAt) {
        push(t + 250 + rand() * 550 - (rand() < 0.25 ? 200 : 0), 'press');
        if (pred.active && pred.phi !== null && sim.byId.get('me').alive) {
          pred.displayCells(t);
          const cur = pred.sim.direction;
          const h = pred.curCells[0];
          const reach = pred.sim.boostTicksLeft > 0 ? 16 : 7; // boost covers twice the ground per tick
          const near = h.x + cur.x * reach < 4 || h.x + cur.x * reach > 79 || h.y + cur.y * reach < 4 || h.y + cur.y * reach > 55;
          const options = cur.x !== 0 ? [DIR_VECS[0], DIR_VECS[1]] : [DIR_VECS[2], DIR_VECS[3]];
          // A sensible player doesn't steer into its own body: only consider cells that are free
          // in the snake as the player currently sees it.
          const bodyCells = new Set(pred.curCells.map((c) => c.x + ',' + c.y));
          const two = (v) => !bodyCells.has((h.x + v.x) + ',' + (h.y + v.y)) && !bodyCells.has((h.x + 2 * v.x) + ',' + (h.y + 2 * v.y));
          const safe = options.filter(two);
          const pool = safe.length ? safe : options;
          let choice = pool[Math.floor(rand() * pool.length)];
          if (near && pool.length > 1) choice = pool.sort((p, q) => Math.hypot(h.x + p.x * 9 - 42, h.y + p.y * 9 - 30) - Math.hypot(h.x + q.x * 9 - 42, h.y + q.y * 9 - 30))[0];
          if (rand() < 0.08) choice = { x: -cur.x, y: -cur.y }; // an illegal reversal now and then
          // same no-op filter the game uses
          const s = pred.sim;
          const recent = s.inputBuffer.length ? s.inputBuffer[s.inputBuffer.length - 1] : s.pendingDirection;
          const changes = !(choice.x === recent.x && choice.y === recent.y) && !(choice.x === -recent.x && choice.y === -recent.y);
          if (changes) {
            const mySeq = ++seq;
            stats.sent++;
            push(t + up + jit() + (t >= rttStepAt ? rttStepMs / 2 : 0), 'inputArrives', { seq: mySeq, input: { dir: dirName(choice) } });
            pred.addInput('dir', choice, mySeq, t);
            stats.turns++;
            // Accepted into the predicted state = it is the pending heading (or queued right
            // behind another turn). It has already changed what is drawn.
            const ps = pred.sim;
            const queued = ps.inputBuffer.length ? ps.inputBuffer[ps.inputBuffer.length - 1] : ps.pendingDirection;
            if (queued.x === choice.x && queued.y === choice.y) stats.instantTurns++;
            pressed.push({ seq: mySeq, dir: choice, time: t, seen: false });
          }
          const clearAhead = !(h.x + cur.x * 26 < 2 || h.x + cur.x * 26 > 81 || h.y + cur.y * 26 < 2 || h.y + cur.y * 26 > 57);
          if (clearAhead && t - lastBoost > 6000 && rand() < 0.3 && pred.canBoost()) {
            lastBoost = t;
            const mySeq = ++seq;
            push(t + up + jit(), 'inputArrives', { seq: mySeq, input: { boost: true } });
            pred.addInput('boost', null, mySeq, t);
          }
        }
      }
    }
  }
  const avg = baseline.length ? baseline.reduce((a, b) => a + b, 0) / baseline.length : NaN;
  return { ...stats, deaths, ticks: sim.tickCount, baselineAvgMs: Math.round(avg), baselineSamples: baseline.length, over };
}

const ROBUSTNESS = [
  { name: 'real server tick of 156ms (unpaced setInterval on Windows), ~100ms RTT', up: 50, down: 50, jitter: 10, serverTickMs: 156 },
  { name: 'RTT jumps from 100ms to 300ms mid-match', up: 50, down: 50, jitter: 10, rttStepAt: 15000, rttStepMs: 200 },
];

const SCENARIOS = [
  { name: '~50ms RTT', up: 25, down: 25, jitter: 0 },
  { name: '~100ms RTT', up: 50, down: 50, jitter: 0 },
  { name: '~100ms RTT + 30ms jitter', up: 50, down: 50, jitter: 30 },
  { name: '~200ms RTT', up: 100, down: 100, jitter: 0 },
  { name: '~200ms RTT + 40ms jitter', up: 100, down: 100, jitter: 40 },
  { name: '~400ms RTT (bad mobile)', up: 200, down: 200, jitter: 40 },
];

for (const sc of SCENARIOS) {
  test(`network simulation: ${sc.name} - local turns are instant and the client converges on the server`, () => {
    // Random matches can legitimately end early (the two snakes collide, someone boosts into a
    // body...), so measure across many seeds and judge the totals - and every run individually
    // for the properties that must hold ALWAYS.
    const runs = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => simulate({ ...sc, seed, seconds: 45, stopInputsAt: 30000 }));
    const total = runs.reduce((acc, r) => ({ ticks: acc.ticks + r.ticks, turns: acc.turns + r.turns, sn: acc.sn + r.snapshots, mm: acc.mm + r.mismatches }), { ticks: 0, turns: 0, sn: 0, mm: 0 });
    assert.ok(total.ticks > 300 && total.turns >= 60 && total.sn >= 150, `enough data (${total.ticks} ticks, ${total.turns} turns, ${total.sn} snapshots)`);
    for (const r of runs) {
      assert.equal(r.instantTurns, r.turns, 'EVERY accepted turn was reflected in the local snake the instant it was pressed');
      assert.equal(r.mismatchAfterQuiet, 0, 'after inputs stop, predicted == authoritative (no permanent desync)');
    }
    const rate = total.mm / Math.max(1, total.sn);
    const limit = sc.jitter >= 30 || sc.up >= 100 ? 0.35 : 0.2;
    assert.ok(rate < limit, `prediction mismatch rate ${(rate * 100).toFixed(1)}% under ${limit * 100}%`);
    const t = runs.reduce((a, r) => ({ turns: a.turns + r.turns, mm: a.mm + r.mismatches, sn: a.sn + r.snapshots, base: a.base + (r.baselineAvgMs || 0), n: a.n + (r.baselineAvgMs ? 1 : 0) }), { turns: 0, mm: 0, sn: 0, base: 0, n: 0 });
    console.log(`    [${sc.name}] turns=${t.turns}  local turn latency: 0 ms (predicted)  vs  ${Math.round(t.base / Math.max(1, t.n))} ms until the server's snapshot shows it (no prediction, before interpolation)  mismatch=${(100 * t.mm / t.sn).toFixed(1)}%`);
  });
}

for (const sc of ROBUSTNESS) {
  test(`network simulation: ${sc.name} - turns stay instant and the client re-converges`, () => {
    const runs = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => simulate({ ...sc, seed, seconds: 45, stopInputsAt: 30000 }));
    const total = runs.reduce((a, r) => ({ sn: a.sn + r.snapshots, mm: a.mm + r.mismatches }), { sn: 0, mm: 0 });
    for (const r of runs) {
      assert.equal(r.instantTurns, r.turns);
      assert.equal(r.mismatchAfterQuiet, 0, 'no permanent desync once inputs stop');
    }
    const rate = total.mm / Math.max(1, total.sn);
    console.log(`    [${sc.name}] mismatch=${(rate * 100).toFixed(1)}%`);
    assert.ok(rate < 0.35, `mismatch rate ${(rate * 100).toFixed(1)}%`);
  });
}
