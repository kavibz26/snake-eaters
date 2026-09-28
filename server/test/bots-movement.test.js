import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchSim } from '../match.js';
import { hitsTerrain, buildOccupancyMap } from '../../js/collision.js';
import { CONFIG, cellKey } from '../../js/config.js';
import { immediateDanger } from '../bots/controller.js';
import { profileHuntConfig } from '../bots/config.js';

// Movement-pipeline regression tests for the bot hunting layer (server/bots/controller.js). These are
// NOT about hunting priority, personality, or difficulty - only about the mechanics of how a bot's
// chosen direction is actually applied tick to tick, exactly like js/game.js and MatchSim's existing
// single-player/multiplayer movement tests.
//
// Math.random is pinned high (never below any difficulty's mistakeChance) for the deterministic tests
// below, so an occasional random "mistake" substitution (server/bots/controller.js) never flips an
// assertion - that is a real, intentional feature (see server/test/bots-attack.test.js), just not what
// these particular tests are about.
const realRandom = Math.random;
const withRandom = (value, fn) => { Math.random = () => value; try { return fn(); } finally { Math.random = realRandom; } };
const tick = (sim) => withRandom(0.99, () => sim.tick());

function twoBotMatch(mapId = 'classic') {
  const sim = new MatchSim([
    { id: 'hunter', name: 'Hunter', skinId: 'classic', bot: true },
    { id: 'prey', name: 'Prey', skinId: 'inferno', bot: true },
  ], { mapId });
  const hunter = sim.byId.get('hunter');
  const prey = sim.byId.get('prey');
  // A clean, controlled starting state: hunter clearly bigger, far from the prey and from any food,
  // already settled into heading 'right' (so this is never the very first decision a fresh snake ever
  // makes, which - like single-player - is legitimately free to turn any way with no prior heading to
  // hold). Both moved out of each other's spawn-seeded food first.
  sim.food.items.clear();
  hunter.body = [{ x: 10, y: 30 }, { x: 9, y: 30 }, { x: 8, y: 30 }];
  hunter.direction = hunter.pendingDirection = { x: 1, y: 0 };
  hunter.inputBuffer = [];
  prey.body = [{ x: 70, y: 30 }];
  prey.direction = prey.pendingDirection = { x: 0, y: -1 };
  prey.inputBuffer = [];
  // "Warm up" with a real decision (this is deliberately NOT the very first-ever call for a fresh
  // snake, which - like single-player - is legitimately free to turn any way with no prior heading to
  // hold). Block up/down for this one tick only, so open-space scoring can't jitter into a "spontaneous"
  // turn: continuing straight is the only sensible, legal option, deterministically.
  sim.obstacles.add(cellKey(10, 29));
  sim.obstacles.add(cellKey(10, 31));
  tick(sim);
  sim.obstacles.delete(cellKey(10, 29));
  sim.obstacles.delete(cellKey(10, 31));
  assert.deepEqual(hunter.direction, { x: 1, y: 0 }, 'sanity check: settled into a real heading with nothing pulling it');
  return { sim, hunter, prey };
}

test('a bot does not take a second consecutive turn immediately, even mid-chase with an active Speed effect', () => {
  // Speed's extra pre-step (server/match.js tick() step 0) moves using whatever direction was already
  // committed BEFORE this tick's bot decisions run; the normal step (later in the same tick) uses
  // whatever server/bots/controller.js just decided. If a hunting decision could turn on every single
  // tick with no gap (unlike every other AI-driven direction change in this game - js/ai.js's own
  // AI_MIN_TURN_GAP), those two sub-moves could end up pointing in different directions, and the NET
  // head displacement for the tick would look diagonal even though no single step actually was. A
  // single fresh turn coinciding with an active Speed tick is normal (the same is already true for a
  // human player); a SECOND turn just one tick after the last one is exactly what the throttle exists
  // to prevent, and is the realistic way this showed up during real matches (rapid, repeated turns).
  const { sim, hunter, prey } = twoBotMatch();

  prey.body = [{ x: 10, y: 20 }];
  tick(sim); // a first, legitimate turn toward the prey - nothing to hold yet, so this is expected
  const firstDir = { ...hunter.direction };
  assert.ok(firstDir.x !== 1 || firstDir.y !== 0, 'sanity check: the hunter turned to chase in the first place');

  // Speed becomes active, and the prey immediately shifts sideways - tempting a fresh course
  // correction one tick after the last turn, with an extra step now due.
  hunter.speedTicksLeft = 6;
  if (sim.tickCount % 2 === 0) sim.tickCount++; // land on the tick Speed's extra step actually fires (tick() increments first)
  prey.body = [{ x: hunter.head.x + 15, y: hunter.head.y - 1 }];

  const before = { ...hunter.head };
  tick(sim);
  const after = hunter.head;
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  assert.deepEqual(hunter.direction, firstDir, 'holds the heading it just turned to, instead of turning again one tick later');
  assert.ok(!(dx !== 0 && dy !== 0), `and so the tick's sub-moves share one heading (got dx=${dx} dy=${dy}, from ${JSON.stringify(before)} to ${JSON.stringify(after)})`);
});

test('a hunting bot still holds its heading for at least one tick before turning, like every other AI-driven direction change (AI_MIN_TURN_GAP)', () => {
  const { sim, hunter, prey } = twoBotMatch();

  // The prey suddenly comes into range, directly above: the hunter is now free (and expected) to turn.
  prey.body = [{ x: 10, y: 20 }];
  tick(sim);
  const firstDir = { ...hunter.direction };
  assert.ok(firstDir.x !== 1 || firstDir.y !== 0, 'sanity check: the hunter actually turns to chase in the first place');

  // Immediately afterward the same target still calls for the same course; nothing emergency-forces
  // another turn. A second consecutive turn is only expected once the throttle's gap has elapsed -
  // exactly the rule js/ai.js already enforces for every other AI-driven direction change.
  tick(sim);
  assert.deepEqual(hunter.direction, firstDir, 'holds the new heading for at least one tick instead of turning again immediately');
});

test('a bot never turns again within the turn-gap unless continuing straight would have been an immediate collision', () => {
  // The direct, general-case version of the two focused tests above, run across many real matches
  // instead of one hand-built scenario: whenever a bot's committed direction changes, either it has
  // held its previous heading for at least AI_MIN_TURN_GAP ticks, or continuing that heading would have
  // driven it straight into a wall, obstacle or another snake's body this very tick (the same emergency
  // exception js/ai.js's own decideAIDirection already allows itself - server/bots/controller.js hands
  // real immediate danger entirely to it, deliberately un-throttled). Anything else turning twice in a
  // row is exactly the "too passive"-fix regression this file exists to catch.
  for (let m = 0; m < 20; m++) {
    const sim = new MatchSim([
      { id: 'human', name: 'Human', skinId: 'classic', bot: false },
      { id: 'b1', name: 'Viper', skinId: 'inferno', bot: true },
      { id: 'b2', name: 'Cobra', skinId: 'jungle', bot: true },
      { id: 'b3', name: 'Fang', skinId: 'frost', bot: true },
    ], { mapId: 'classic', botDifficulty: 'normal' });
    const prevDir = new Map();
    const sinceTurn = new Map();
    for (const s of sim.snakes) {
      prevDir.set(s.playerId, { ...s.direction });
      sinceTurn.set(s.playerId, 99);
    }
    let ticks = 0;
    while (!sim.over && ticks < 400) {
      // What would have excused an immediate turn. Three independent reasons: (1)
      // server/bots/controller.js's own immediateDanger() was true, meaning decideBotDirection handed
      // the whole decision to decideAIDirection un-throttled by design; or (2) js/ai.js's own
      // decideAIDirection emergency override - continuing straight runs into ANY occupied cell (a wall,
      // an obstacle, another snake's body, or the bot's own neck curling back on itself - that check
      // does not distinguish who occupies it, or whether it would actually be fatal). (2) is checked
      // against occupancy both before AND after this tick, since the real check inside MatchSim.tick()
      // runs mid-tick - after the Speed/Boost extra pre-step may have already moved some snakes, which
      // this test (driving tick() as one opaque call) cannot observe directly.
      const preOcc = buildOccupancyMap(sim.snakes);
      const straightNext = new Map();
      const emergencyExcused = new Map();
      for (const s of sim.snakes) {
        if (!s.alive || !s.isBot) continue;
        const next = { x: s.head.x + s.direction.x, y: s.head.y + s.direction.y };
        straightNext.set(s.playerId, next);
        const straightBlocked = hitsTerrain(sim.obstacles, next.x, next.y) || preOcc.has(cellKey(next.x, next.y));
        const inDanger = immediateDanger(s, sim.snakes, profileHuntConfig(s.profile));
        emergencyExcused.set(s.playerId, straightBlocked || inDanger);
      }
      sim.tick();
      ticks++;
      const postOcc = buildOccupancyMap(sim.snakes);
      for (const [id, next] of straightNext) {
        if (postOcc.has(cellKey(next.x, next.y))) emergencyExcused.set(id, true);
      }
      for (const s of sim.snakes) {
        if (!s.alive || !s.isBot) continue;
        const pd = prevDir.get(s.playerId);
        const turned = s.direction.x !== pd.x || s.direction.y !== pd.y;
        if (turned) {
          const heldLongEnough = sinceTurn.get(s.playerId) >= CONFIG.AI_MIN_TURN_GAP;
          const emergency = emergencyExcused.get(s.playerId);
          assert.ok(heldLongEnough || emergency, `match ${m} tick ${ticks} ${s.playerId}: turned again after only ${sinceTurn.get(s.playerId)} tick(s), and nothing excused it as an emergency`);
        }
        sinceTurn.set(s.playerId, turned ? 0 : sinceTurn.get(s.playerId) + 1);
        prevDir.set(s.playerId, { ...s.direction });
      }
    }
  }
});

test('a bot never occupies obstacle or out-of-bounds terrain while alive', () => {
  for (let m = 0; m < 10; m++) {
    const sim = new MatchSim([
      { id: 'human', name: 'Human', skinId: 'classic', bot: false },
      { id: 'b1', name: 'Viper', skinId: 'inferno', bot: true },
      { id: 'b2', name: 'Cobra', skinId: 'jungle', bot: true },
      { id: 'b3', name: 'Fang', skinId: 'frost', bot: true },
    ], { mapId: 'blocks', botDifficulty: 'normal' });
    let ticks = 0;
    while (!sim.over && ticks < 300) {
      sim.tick();
      ticks++;
      for (const s of sim.snakes) {
        if (!s.alive || !s.isBot) continue;
        assert.equal(hitsTerrain(sim.obstacles, s.head.x, s.head.y), false, `match ${m} tick ${ticks} ${s.playerId}: head is on terrain but still alive`);
      }
    }
  }
});
