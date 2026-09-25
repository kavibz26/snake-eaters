import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../js/config.js';
import { MatchSim } from '../match.js';

// Simulation-level checks for the live leaderboard and the match results (no sockets).
test('leaderboard: the server ranks by score with deterministic tie-breaks', () => {
  const sim = new MatchSim([
    { id: 'a', name: 'A', skinId: 'classic' },
    { id: 'b', name: 'B', skinId: 'inferno' },
    { id: 'c', name: 'C', skinId: 'frost' },
    { id: 'd', name: 'D', skinId: 'toxic' },
  ]);
  const s = (id) => sim.byId.get(id);
  s('a').score = 50; s('b').score = 120; s('c').score = 50; s('d').score = 50;
  s('c').eliminations = 2; s('d').alive = false;
  // b (120) first; then the 50s: a alive/0 kills, c alive/2 kills, d dead
  // order among 50s: alive first (a, c), then more kills (c), so c, a, d
  const order = sim.leaderboardOrder().map((i) => sim.snakes[i].playerId);
  assert.deepEqual(order, ['b', 'c', 'a', 'd']);
  // exact ties fall back to join order
  s('a').score = s('b').score = s('c').score = s('d').score = 10;
  s('c').eliminations = 0; s('d').alive = true;
  assert.deepEqual(sim.leaderboardOrder().map((i) => sim.snakes[i].playerId), ['a', 'b', 'c', 'd']);
  // it is what gets sent
  const snap = sim.snapshot({ full: true });
  assert.deepEqual(snap.lb, sim.leaderboardOrder());
});

test('leaderboard: scores in snapshots are the server-authoritative ones and live-update as food is eaten', () => {
  const sim = new MatchSim([{ id: 'a', name: 'A', skinId: 'classic' }, { id: 'b', name: 'B', skinId: 'inferno' }]);
  sim.food.items.clear();
  sim.food.target = 0;
  const a = sim.byId.get('a');
  a.body = Array.from({ length: 5 }, (_, i) => ({ x: 10 - i, y: 10 }));
  a.direction = a.pendingDirection = CONFIG.DIRECTIONS.right;
  const b = sim.byId.get('b');
  b.body = Array.from({ length: 5 }, (_, i) => ({ x: 60 - i, y: 45 }));
  b.direction = b.pendingDirection = CONFIG.DIRECTIONS.right;
  sim.food.scatterAt([{ x: 11, y: 10 }]);
  sim._commitBaseline();
  sim.tick();
  const snap = sim.snapshot();
  assert.equal(snap.snakes.find((x) => x.id === 'a').sc, CONFIG.FOOD_SCORE);
  assert.equal(snap.snakes[snap.lb[0]].id, 'a', 'the one who ate leads');
});

test('results: ranking, winner and survival are computed by the server, ties are deterministic', () => {
  const sim = new MatchSim([
    { id: 'a', name: 'A', skinId: 'classic' },
    { id: 'b', name: 'B', skinId: 'inferno' },
    { id: 'c', name: 'C', skinId: 'frost' },
  ]);
  sim.forfeit('c');
  sim.tick();
  sim.byId.get('b').alive = false;
  sim.byId.get('b').diedTick = 5;
  sim.tick();
  assert.equal(sim.over, true);
  const r = sim.results();
  assert.equal(r[0].id, 'a');
  assert.equal(r[0].survived, true);
  assert.deepEqual(r.map((x) => x.rank), [1, 2, 3]);
  const again = sim.results();
  assert.deepEqual(again, r, 'stable, deterministic ordering');
});

