import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../shared/engine.js';
import {
  parseTimeControl, createClock, runningColor, timeLeft, settle, hasFlagged, pause, resume,
} from '../server/clock.js';

const MIN = 60000;
const onMove = (turn) => ({ ...createGame(), turn });

test('time controls are checked', () => {
  assert.equal(parseTimeControl(null), null);
  assert.equal(parseTimeControl(undefined), null);
  assert.deepEqual(parseTimeControl({ minutes: '5', increment: '3' }), { minutes: 5, increment: 3 });
  assert.deepEqual(parseTimeControl({ minutes: 0.5 }), { minutes: 0.5, increment: 0 });
  for (const bad of [{ minutes: 0 }, { minutes: -1 }, { minutes: 181 }, { minutes: 'ten' },
    { minutes: 5, increment: -1 }, { minutes: 5, increment: 1.5 }, { minutes: 5, increment: 61 }]) {
    assert.throws(() => parseTimeControl(bad), JSON.stringify(bad));
  }
});

test('nobody\'s clock runs during their first move, and each move after it earns the increment', () => {
  const clock = createClock({ minutes: 5, increment: 3 }, 0);
  assert.deepEqual(clock.remaining, { w: 5 * MIN, g: 5 * MIN, b: 5 * MIN });

  // Everyone's first move is free, however long it takes, and earns no increment.
  assert.equal(runningColor(clock, onMove('w')), null);
  settle(clock, onMove('w'), 40000, 'w');
  settle(clock, onMove('g'), 90000, 'g');
  settle(clock, onMove('b'), 95000, 'b');
  assert.deepEqual(clock.remaining, { w: 5 * MIN, g: 5 * MIN, b: 5 * MIN });

  // White's second move is timed.
  assert.equal(runningColor(clock, onMove('w')), 'w');
  assert.equal(timeLeft(clock, onMove('w'), 105000).w, 5 * MIN - 10000);
  settle(clock, onMove('w'), 105000, 'w');
  assert.equal(clock.remaining.w, 5 * MIN - 7000, 'ten seconds used, three earned');
  assert.equal(clock.remaining.g, 5 * MIN, 'other clocks are untouched');
});

test('a turn ended without a move charges the time but earns no increment', () => {
  const clock = createClock({ minutes: 1, increment: 5 }, 0);
  clock.moved.w = true;
  settle(clock, onMove('w'), 20000);
  assert.equal(clock.remaining.w, 40000);
  assert.equal(clock.since, 20000);
});

test('the clock flags at zero and never goes below it', () => {
  const clock = createClock({ minutes: 1, increment: 0 }, 0);
  clock.moved.g = true;
  assert.equal(hasFlagged(clock, onMove('g'), 59999), false);
  assert.equal(hasFlagged(clock, onMove('g'), 60000), true);
  assert.equal(timeLeft(clock, onMove('g'), 90000).g, 0);
  assert.equal(hasFlagged(clock, onMove('w'), 90000), false, 'white has not moved yet, so is not timed');
});

test('a paused clock keeps its time until it resumes', () => {
  const clock = createClock({ minutes: 1, increment: 0 }, 0);
  clock.moved.w = true;
  pause(clock, onMove('w'), 10000);
  assert.equal(runningColor(clock, onMove('w')), null);
  assert.equal(timeLeft(clock, onMove('w'), 50000).w, 50000, 'nothing is charged while paused');
  assert.equal(hasFlagged(clock, onMove('w'), 999999), false);
  resume(clock, 70000);
  assert.equal(runningColor(clock, onMove('w')), 'w');
  assert.equal(timeLeft(clock, onMove('w'), 75000).w, 45000, 'time runs again from the resume');
  resume(clock, 80000);
  assert.equal(clock.since, 70000, 'resuming a running clock changes nothing');
});

test('clocks stop when the game ends', () => {
  const clock = createClock({ minutes: 1, increment: 0 }, 0);
  clock.moved.w = true;
  const over = { ...onMove('w'), status: 'won', winner: 'w' };
  assert.equal(runningColor(clock, over), null);
  assert.equal(timeLeft(clock, over, 999999).w, MIN);
});
