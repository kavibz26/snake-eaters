import { CONFIG, isOpposite } from './config.js';

let nextSnakeId = 1;

export class Snake {
  constructor({ isPlayer, cells, direction, color, profile }) {
    this.id = nextSnakeId++;
    this.isPlayer = isPlayer;
    this.color = color;
    this.profile = profile || null; // AI behavior style, null for player
    this.body = cells.slice(); // [head, ..., tail], each {x,y}
    this.direction = direction; // current committed direction
    this.pendingDirection = direction; // direction that will be applied on the next tick
    this.inputBuffer = []; // player-only: one extra buffered turn, see queueDirection()
    this.boostTicksLeft = 0; // player-only: ticks remaining on an active speed boost
    this.boostCooldownLeft = 0; // player-only: ticks remaining before boost can be used again
    this.attackPending = false; // player-only: a one-shot dash+bite queued for the next tick
    this.attackCooldownLeft = 0; // player-only: ticks remaining before attack can be used again
    this.alive = true;
    this.growPending = 0; // segments still owed from a previous eat (kill bonuses can exceed 1)
    this.foodEaten = 0;
    this.eliminations = 0;
    this.score = 0;
    this.justAte = false; // set true for one tick after eating, for render feedback
  }

  get length() {
    return this.body.length;
  }

  get head() {
    return this.body[0];
  }

  get tail() {
    return this.body[this.body.length - 1];
  }

  setDirection(dir) {
    if (!dir) return;
    if (isOpposite(dir, this.direction)) return; // never allow instant 180s
    this.pendingDirection = dir;
  }

  // Player-only input path: a same-tick first press still turns with zero
  // delay (identical to setDirection), but a quick follow-up press before
  // that turn has resolved is buffered for the very next tick instead of
  // silently overwriting - and therefore losing - the first one. AI never
  // calls this, so it never gains this forgiveness; it's a deliberate edge
  // in the player's favor. Always deterministic: no randomness involved.
  queueDirection(dir) {
    if (!dir) return;
    const mostRecent = this.inputBuffer.length
      ? this.inputBuffer[this.inputBuffer.length - 1]
      : this.pendingDirection;
    if (isOpposite(dir, mostRecent)) return; // would reverse whatever precedes it - never allowed
    if (dir.x === mostRecent.x && dir.y === mostRecent.y) return; // already headed that way

    const nothingPendingYet = this.pendingDirection.x === this.direction.x && this.pendingDirection.y === this.direction.y;
    if (nothingPendingYet && this.inputBuffer.length === 0) {
      this.pendingDirection = dir; // zero-delay: applies on the very next tick
    } else if (this.inputBuffer.length === 0) {
      this.inputBuffer.push(dir); // a turn is already pending - queue this one for the tick after
    } else {
      this.inputBuffer[0] = dir; // replace the buffered turn with the latest input
    }
  }

  nextHead() {
    const dir = isOpposite(this.pendingDirection, this.direction) ? this.direction : this.pendingDirection;
    return { x: this.head.x + dir.x, y: this.head.y + dir.y, dir };
  }

  willGrowThisTick() {
    return this.growPending > 0;
  }

  // Body cells that still count as solid obstacles this tick. The tail cell is
  // excluded unless the snake is growing, because it vacates that cell as part
  // of this same move - treating it as solid would cause unpredictable deaths
  // on cells a snake is simultaneously leaving.
  collidableBody() {
    if (this.willGrowThisTick() || this.body.length <= 1) return this.body;
    return this.body.slice(0, -1);
  }

  commitMove(newHead) {
    const growing = this.willGrowThisTick();
    this.body.unshift({ x: newHead.x, y: newHead.y });
    if (!growing) {
      this.body.pop();
    } else {
      this.growPending -= 1;
    }
    this.direction = newHead.dir;
    // Promote any buffered follow-up turn now that this tick's move is
    // locked in, so it takes effect next tick. No-op for AI (buffer always empty).
    this.pendingDirection = this.inputBuffer.length ? this.inputBuffer.shift() : newHead.dir;
  }

  grow(amount) {
    this.growPending += amount;
  }

  canBoost() {
    return this.boostTicksLeft <= 0 && this.boostCooldownLeft <= 0 && !this.attackPending;
  }

  // Starts a temporary speed boost; the actual extra movement happens in
  // Game.tick() (see the boost pre-step there). Returns false if a boost is
  // already active or still cooling down.
  activateBoost(durationTicks) {
    if (!this.canBoost()) return false;
    this.boostTicksLeft = durationTicks;
    return true;
  }

  canAttack() {
    return !this.attackPending && this.attackCooldownLeft <= 0 && this.boostTicksLeft <= 0;
  }

  // Queues a one-shot dash+bite for the very start of the next tick (see the
  // attack pre-step in Game.tick()). Returns false if attack is already
  // queued, still cooling down, or a boost is currently active.
  activateAttack() {
    if (!this.canAttack()) return false;
    this.attackPending = true;
    return true;
  }

  kill() {
    this.alive = false;
  }

  // Body cells to scatter as food when this snake dies.
  corpseFoodCells() {
    const cells = [];
    for (let i = 0; i < this.body.length; i += CONFIG.DEATH_FOOD_STRIDE) {
      cells.push(this.body[i]);
    }
    return cells;
  }
}
