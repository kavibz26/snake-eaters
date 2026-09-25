import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../js/config.js';
import { MatchSim } from '../match.js';

function makeSim(ids = ['a', 'b', 'c']) {
  const skins = ['classic', 'inferno', 'frost', 'toxic'];
  const sim = new MatchSim(ids.map((id, i) => ({ id, name: id.toUpperCase(), skinId: skins[i] })));
  sim.food.items.clear();
  sim.food.target = 0; // no random replenishment during rule tests
  return sim;
}

function place(sim, id, cells, dirName) {
  const s = sim.byId.get(id);
  s.body = cells.map(([x, y]) => ({ x, y }));
  const d = CONFIG.DIRECTIONS[dirName];
  s.direction = d;
  s.pendingDirection = d;
  s.inputBuffer = [];
  s.growPending = 0;
  return s;
}

// Row of `len` cells, head first, heading right, head at (hx,hy).
function row(hx, hy, len) {
  return Array.from({ length: len }, (_, i) => [hx - i, hy]);
}

// Parks the spare snake far away so it never interferes.
function parkC(sim) {
  place(sim, 'c', row(70, 50, 3), 'right');
}

test('spawn: everyone starts equal length, distinct skins, inside the arena', () => {
  const sim = new MatchSim([
    { id: 'a', name: 'A', skinId: 'classic' },
    { id: 'b', name: 'B', skinId: 'inferno' },
    { id: 'c', name: 'C', skinId: 'frost' },
  ]);
  for (const s of sim.snakes) {
    assert.equal(s.length, CONFIG.PLAYER_INITIAL_LENGTH);
    for (const c of s.body) {
      assert.ok(c.x >= 0 && c.x < CONFIG.GRID_COLS && c.y >= 0 && c.y < CONFIG.GRID_ROWS);
    }
  }
  const all = new Set(sim.snakes.flatMap((s) => s.body.map((c) => `${c.x},${c.y}`)));
  assert.equal(all.size, 3 * CONFIG.PLAYER_INITIAL_LENGTH, 'no overlapping spawn cells');
  assert.ok(sim.food.count > 0);
});

test('bigger snake eats a smaller one by touching ANY part of its body', () => {
  const sim = makeSim();
  const a = place(sim, 'a', row(10, 11, 6), 'right'); // head -> (11,11)
  const b = place(sim, 'b', [[11, 13], [11, 12], [11, 11], [11, 10]], 'down'); // (11,11) is a body cell
  parkC(sim);
  sim.tick();
  assert.equal(b.alive, false, 'smaller snake is eliminated');
  assert.equal(a.alive, true);
  assert.equal(a.eliminations, 1);
  assert.equal(a.score, CONFIG.KILL_SCORE);
  assert.equal((a.length - 6) + a.growPending, Math.ceil(4 * CONFIG.KILL_GROWTH_RATIO), 'gains half the victim\'s length');
  assert.ok(sim.events.some((e) => e.e === 'kill' && e.killer === 'a' && e.victim === 'b'));
});

test('equal-size body contact kills the one who moved into it', () => {
  const sim = makeSim();
  const a = place(sim, 'a', row(10, 11, 4), 'right');
  const b = place(sim, 'b', [[11, 13], [11, 12], [11, 11], [11, 10]], 'down');
  parkC(sim);
  sim.tick();
  assert.equal(a.alive, false);
  assert.equal(b.alive, true);
  assert.equal(b.eliminations, 0, 'the snake that was merely touched gets no kill credit');
});

test('running into a BIGGER snake body eliminates you', () => {
  const sim = makeSim();
  const a = place(sim, 'a', row(10, 11, 3), 'right');
  const b = place(sim, 'b', [[11, 14], [11, 13], [11, 12], [11, 11], [11, 10], [11, 9]], 'down');
  parkC(sim);
  sim.tick();
  assert.equal(a.alive, false);
  assert.equal(b.alive, true);
  // Existing rule preserved exactly: kill credit (growth/score) is only awarded
  // to the bigger snake when IT is the one that made contact.
  assert.equal(b.eliminations, 0);
  assert.ok(sim.events.some((e) => e.e === 'kill' && e.killer === 'b' && e.victim === 'a'), 'still shown as a kill');
});

test('head-to-head on the same cell: bigger wins', () => {
  const sim = makeSim();
  const a = place(sim, 'a', row(10, 10, 6), 'right'); // -> (11,10)
  const b = place(sim, 'b', [[12, 10], [13, 10], [14, 10], [15, 10], [16, 10]], 'left'); // -> (11,10)
  parkC(sim);
  sim.tick();
  assert.equal(b.alive, false);
  assert.equal(a.alive, true);
  assert.deepEqual({ ...a.head }, { x: 11, y: 10 });
});

test('head-to-head tie between equals bounces: nobody dies, nobody moves', () => {
  const sim = makeSim();
  const a = place(sim, 'a', row(10, 10, 5), 'right');
  const b = place(sim, 'b', [[12, 10], [13, 10], [14, 10], [15, 10], [16, 10]], 'left');
  parkC(sim);
  sim.tick();
  assert.equal(a.alive, true);
  assert.equal(b.alive, true);
  assert.deepEqual({ ...a.head }, { x: 10, y: 10 });
  assert.deepEqual({ ...b.head }, { x: 12, y: 10 });
});

test('walls are always fatal', () => {
  const sim = makeSim();
  const a = place(sim, 'a', [[0, 20], [1, 20], [2, 20]], 'left');
  place(sim, 'b', row(40, 30, 3), 'right');
  parkC(sim);
  sim.tick();
  assert.equal(a.alive, false);
  assert.ok(sim.events.some((e) => e.e === 'death' && e.id === 'a'));
});

test('eating food grows the snake and scores', () => {
  const sim = makeSim();
  const a = place(sim, 'a', row(10, 10, 5), 'right');
  place(sim, 'b', row(40, 30, 3), 'right');
  parkC(sim);
  sim.food.scatterAt([{ x: 11, y: 10 }]);
  sim.tick();
  assert.equal(a.length, 6, 'grows by one immediately');
  assert.equal(a.score, CONFIG.FOOD_SCORE);
  assert.equal(sim.food.has(11, 10), false);
  assert.ok(sim.events.some((e) => e.e === 'eat' && e.id === 'a'));
});

test('a dead snake scatters corpse food', () => {
  const sim = makeSim();
  place(sim, 'a', [[0, 20], [1, 20], [2, 20], [3, 20], [4, 20]], 'left');
  place(sim, 'b', row(40, 30, 3), 'right');
  parkC(sim);
  sim.tick();
  assert.ok(sim.food.count > 0);
});

test('reversing is rejected (existing queueDirection rule)', () => {
  const sim = makeSim();
  const a = place(sim, 'a', row(10, 10, 5), 'right');
  place(sim, 'b', row(40, 30, 3), 'right');
  parkC(sim);
  sim.setDirection('a', 'left');
  sim.tick();
  assert.deepEqual({ ...a.head }, { x: 11, y: 10 }, 'kept heading right');
});

test('invalid direction names are ignored', () => {
  const sim = makeSim();
  const a = place(sim, 'a', row(10, 10, 5), 'right');
  place(sim, 'b', row(40, 30, 3), 'right');
  parkC(sim);
  sim.setDirection('a', 'sideways');
  sim.setDirection('a', undefined);
  sim.setDirection('nobody', 'up');
  sim.tick();
  assert.deepEqual({ ...a.head }, { x: 11, y: 10 });
});

test('Speed Boost: two cells per tick for the boost duration, then cooldown', () => {
  const sim = makeSim();
  const a = place(sim, 'a', row(10, 10, 5), 'right');
  place(sim, 'b', row(40, 30, 3), 'right');
  parkC(sim);
  assert.equal(sim.activateBoost('a'), true);
  assert.equal(sim.activateBoost('a'), false, 'cannot re-trigger while active');
  sim.tick();
  assert.deepEqual({ ...a.head }, { x: 12, y: 10 }, 'moved 2 cells this tick');
  for (let i = 1; i < CONFIG.BOOST_DURATION_TICKS; i++) {
    place(sim, 'b', row(40, 30, 3), 'right');
    parkC(sim);
    sim.tick();
  }
  assert.equal(a.boostTicksLeft, 0);
  assert.equal(a.boostCooldownLeft, CONFIG.BOOST_COOLDOWN_TICKS);
  assert.equal(sim.activateBoost('a'), false, 'cooling down');
});

test('Speed Boost: the extra boost step into a wall or body is a plain death (existing pre-step rule)', () => {
  const sim = makeSim();
  const a = place(sim, 'a', row(83, 10, 5), 'right'); // already at the right wall
  place(sim, 'b', row(40, 30, 3), 'right');
  parkC(sim);
  sim.activateBoost('a');
  sim.tick();
  assert.equal(a.alive, false);
  assert.ok(sim.events.some((e) => e.e === 'death' && e.id === 'a' && e.cause === 'boost'));

  const sim2 = makeSim();
  const c = place(sim2, 'a', row(10, 10, 9), 'right');
  const d = place(sim2, 'b', [[11, 12], [11, 11], [11, 10], [11, 9]], 'down'); // (11,10) solid
  parkC(sim2);
  sim2.activateBoost('a');
  sim2.tick();
  assert.equal(c.alive, false, 'boost pre-step ignores size: touching any body mid-boost is fatal');
  assert.equal(d.alive, true);
});

test('a frozen (disconnected) snake stays put and is fully solid, tail included', () => {
  const sim = makeSim();
  const a = place(sim, 'a', row(10, 10, 5), 'right'); // tail (6,10)
  const b = place(sim, 'b', [[6, 9], [6, 8]], 'down'); // head (6,9) heading into (6,10), a's tail cell
  parkC(sim);
  sim.setFrozen('a', true);
  sim.tick();
  assert.deepEqual({ ...a.head }, { x: 10, y: 10 }, 'frozen snake did not move');
  // b (len 2) moved into the frozen snake's tail cell: solid + bigger => b dies
  assert.equal(b.alive, false);
  sim.setFrozen('a', false);
  assert.equal(Object.prototype.hasOwnProperty.call(a, 'collidableBody'), false);
});

test('match ends when one snake is left standing; winner ranked first', () => {
  const sim = makeSim(['a', 'b']);
  const a = place(sim, 'a', row(10, 10, 5), 'right');
  place(sim, 'b', [[0, 20], [1, 20], [2, 20]], 'left');
  sim.tick();
  assert.equal(sim.over, true);
  assert.equal(sim.winnerId, 'a');
  assert.equal(sim.endReason, 'last_standing');
  const r = sim.results();
  assert.equal(r[0].id, 'a');
  assert.equal(r[0].rank, 1);
  assert.equal(r[1].id, 'b');
  assert.equal(a.alive, true);
});

test('everyone dying on the same tick is a draw with no winner', () => {
  const sim = makeSim(['a', 'b']);
  place(sim, 'a', [[0, 20], [1, 20], [2, 20]], 'left');
  place(sim, 'b', [[83, 30], [82, 30], [81, 30]], 'right');
  sim.tick();
  assert.equal(sim.over, true);
  assert.equal(sim.winnerId, null);
  assert.equal(sim.endReason, 'draw');
});

test('forfeit removes a snake and can end the match', () => {
  const sim = makeSim(['a', 'b']);
  sim.forfeit('b');
  sim.tick();
  assert.equal(sim.over, true);
  assert.equal(sim.winnerId, 'a');
});

test('snapshot is compact, JSON-safe and never leaks server internals', () => {
  const sim = makeSim(['a', 'b']);
  const snap = sim.snapshot();
  const json = JSON.stringify(snap);
  assert.equal(snap.t, 'snap');
  assert.equal(snap.snakes.length, 2);
  assert.ok(Array.isArray(snap.snakes[0].c) && snap.snakes[0].c.length === CONFIG.PLAYER_INITIAL_LENGTH * 2);
  assert.ok(!json.includes('token'));
  assert.ok(json.length < 4000);
});
