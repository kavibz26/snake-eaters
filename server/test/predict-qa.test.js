import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../js/config.js';
import { MatchSim } from '../match.js';
import { LocalPredictor, predictorState } from '../../js/net/predict.js';
import { SnapTracker, DIR_VECS } from '../../js/net/snapcodec.js';

// Sequence hygiene and reconciliation bounds of the prediction buffer.
const UP = DIR_VECS[0];
const LEFT = DIR_VECS[2];
const TICK = CONFIG.TICK_MS;

function primed({ rtt = 100 } = {}) {
  const sim = new MatchSim([
    { id: 'me', name: 'Me', skinId: 'classic' },
    { id: 'ot', name: 'Ot', skinId: 'inferno' },
  ]);
  sim.food.items.clear();
  sim.food.target = 0;
  const me = sim.byId.get('me');
  me.body = Array.from({ length: 6 }, (_, i) => ({ x: 30 - i, y: 30 }));
  me.direction = me.pendingDirection = CONFIG.DIRECTIONS.right;
  me.inputBuffer = [];
  const ot = sim.byId.get('ot');
  ot.body = Array.from({ length: 4 }, (_, i) => ({ x: 70 - i, y: 50 }));
  ot.direction = ot.pendingDirection = CONFIG.DIRECTIONS.right;
  sim._commitBaseline();

  const pred = new LocalPredictor();
  const tracker = new SnapTracker();
  tracker.apply(sim.snapshot({ full: true }));
  let now = 0;
  for (let k = 1; k <= 5; k++) {
    sim.tick();
    const snap = JSON.parse(JSON.stringify(sim.snapshot()));
    tracker.apply(snap);
    now = 1000 + k * TICK + rtt / 2;
    pred.noteRtt(rtt);
    pred.noteSnapshot(k, now);
    pred.onSnapshot(predictorState(snap, snap.snakes.find((x) => x.id === 'me'), tracker.bodies.get('me')), tracker.food, now);
  }
  return { sim, pred, tracker, now };
}

function feed(ctx, tick, arrival) {
  ctx.sim.tick();
  const snap = JSON.parse(JSON.stringify(ctx.sim.snapshot()));
  ctx.tracker.apply(snap);
  ctx.pred.noteSnapshot(tick, arrival);
  const me = snap.snakes.find((x) => x.id === 'me');
  ctx.pred.onSnapshot(predictorState(snap, me, ctx.tracker.bodies.get('me')), ctx.tracker.food, arrival);
  return me;
}

test('a duplicated, stale or out-of-order sequence number is never buffered twice', () => {
  const { pred, now } = primed({ rtt: 80 });
  assert.equal(pred.addInput('dir', UP, 5, now + 10), true);
  assert.equal(pred.addInput('dir', UP, 5, now + 12), false, 'same seq again');
  assert.equal(pred.addInput('dir', LEFT, 4, now + 14), false, 'lower seq (stale / out of order)');
  assert.equal(pred.addInput('dir', LEFT, 0, now + 16), false, 'zero is not a valid sequence number');
  assert.equal(pred.inputs.length, 1);
  assert.equal(pred.addInput('dir', LEFT, 6, now + 18), true, 'the next real input is accepted');
  assert.deepEqual(pred.inputs.map((i) => i.seq), [5, 6]);
});

test('acknowledged inputs are never replayed by later snapshots (old inputs cannot come back)', () => {
  const ctx = primed({ rtt: 60 });
  const { sim, pred, now } = ctx;
  pred.addInput('dir', UP, 1, now + 20);
  sim.applyInput('me', 1, { dir: 'up' });
  let t = now;
  for (let k = 6; k <= 12; k++) {
    t = now + (k - 5) * TICK;
    const me = feed(ctx, k, t);
    assert.equal(pred.inputs.length, 0, `tick ${k}: nothing left to replay`);
    assert.deepEqual(pred.direction(t), { x: me.d[0], y: me.d[1] }, `tick ${k}: prediction simply follows the server`);
  }
  assert.equal(pred.addInput('dir', LEFT, 2, t + 10), true, 'a NEW input afterwards works normally');
  assert.equal(pred.inputs.length, 1);
});

test('unacknowledged inputs are replayed exactly once per rebuild, in order', () => {
  const ctx = primed({ rtt: 120 });
  const { pred, now } = ctx;
  pred.addInput('dir', UP, 1, now + 10);
  pred.addInput('dir', LEFT, 2, now + 20);
  // Several snapshots arrive that have NOT yet seen the inputs (ack 0): they stay buffered, never doubled.
  for (let k = 6; k <= 8; k++) {
    feed(ctx, k, now + (k - 5) * TICK);
    assert.deepEqual(pred.inputs.map((i) => i.seq), [1, 2], `tick ${k}: still exactly the two unacknowledged inputs`);
  }
});

test('reset() (new match) clears the sequence memory so a fresh match can start at 1 again', () => {
  const { pred, now } = primed();
  pred.addInput('dir', UP, 9, now + 10);
  pred.reset();
  assert.equal(pred.lastSeq, 0);
  assert.equal(pred.inputs.length, 0);
});

test('reconciliation is bounded: if the server applies a turn a tick later than predicted, the drawn head moves at most a cell or two', () => {
  const ctx = primed({ rtt: 100 });
  const { pred, now } = ctx;
  pred.addInput('dir', UP, 1, now + 40);
  const before = pred.displayCells(now + 60)[0];
  feed(ctx, 6, now + TICK); // the server had NOT processed the turn yet
  const after = pred.displayCells(now + 60)[0];
  assert.ok(Math.abs(after.x - before.x) + Math.abs(after.y - before.y) <= 2.01, 'a small correction, never a teleport');
});

// --- RTT tracking (the lead the prediction runs ahead by) ---------------------------------------------
const feedRtt = (pred, list) => list.forEach((v) => pred.noteRtt(v));
const jit = (base, spread, seed = 7) => { let t = seed; return () => { t = (Math.imul(t, 1664525) + 1013904223) >>> 0; return base + (t / 4294967296) * spread; }; };

test('RTT: a sustained rise is adopted within 2 pings, and no sample is stored twice', () => {
  const pred = new LocalPredictor();
  feedRtt(pred, Array(12).fill(0).map((_, i) => 64 + (i % 3)));
  assert.ok(pred.lead < 80);
  feedRtt(pred, [205, 208]);
  assert.ok(pred.lead > 195, `lead follows the new path after two slow pings (${Math.round(pred.lead)}ms)`);
  assert.deepEqual(pred.rttSamples, [205, 208], 'exactly the samples that were measured, none duplicated');
});

test('RTT: a flapping link (200 -> 50 -> 200) re-adapts within 2 pings instead of waiting for the window to age out', () => {
  const pred = new LocalPredictor();
  feedRtt(pred, Array(12).fill(213));
  feedRtt(pred, Array(5).fill(65));
  assert.ok(pred.lead < 80, 'dropped to the fast path');
  feedRtt(pred, [208, 212]);
  assert.ok(pred.lead > 195, `back on the slow path after two pings (${Math.round(pred.lead)}ms)`);
});

test('RTT: a single spike never moves the lead', () => {
  const pred = new LocalPredictor();
  feedRtt(pred, Array(8).fill(70));
  const before = pred.lead;
  pred.noteRtt(600);
  assert.ok(pred.lead - before <= 41, `one spike moved the lead by ${Math.round(pred.lead - before)}ms (jitter allowance only)`);
  feedRtt(pred, [70, 70, 70]);
  assert.ok(Math.abs(pred.lead - before) < 1);
});

test('RTT: a jittery but stable link (60-140ms) does not thrash the lead', () => {
  const pred = new LocalPredictor();
  const next = jit(60, 80);
  feedRtt(pred, Array.from({ length: 12 }, next));
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 300; i++) {
    pred.noteRtt(next());
    lo = Math.min(lo, pred.lead); hi = Math.max(hi, pred.lead);
  }
  assert.ok(lo >= 55 && hi <= 140, `lead stayed within ${Math.round(lo)}-${Math.round(hi)}ms (the link itself is 60-140ms)`);
});

test('RTT samples survive predictor.reset() (a new match is on the same connection)', () => {
  const pred = new LocalPredictor();
  feedRtt(pred, [180, 185, 190]);
  pred.reset();
  assert.ok(pred.lead > 170, `lead after reset ${Math.round(pred.lead)}ms, not the 60ms default`);
  assert.equal(pred.lastSeq, 0);
});

test('RTT: a sustained fall (210 -> 65) is adopted within 2 pings and the stale samples stop inflating the jitter term', () => {
  const pred = new LocalPredictor();
  feedRtt(pred, Array(12).fill(0).map((_, i) => 208 + (i % 4)));
  feedRtt(pred, [65, 66]);
  assert.ok(pred.lead < 75, `lead ${Math.round(pred.lead)}ms after two fast pings (was 105 while the stale median lingered)`);
  assert.deepEqual(pred.rttSamples, [65, 66]);
  assert.equal(pred.jitter, 1);
});

test('RTT: a single unusually fast ping does not drop the lead', () => {
  const pred = new LocalPredictor();
  feedRtt(pred, Array(8).fill(200));
  pred.noteRtt(20);
  feedRtt(pred, [200]);
  assert.ok(pred.rttSamples.includes(200) && pred.rttSamples.includes(20), 'the older samples were kept: one dip is not a level shift');
});
