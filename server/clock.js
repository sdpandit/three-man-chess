// Chess clocks for a room. Pure functions over plain data, so they save with the room
// and can be tested without waiting: every function takes the current time.
//
// A clock is { initial, increment, remaining: { w, g, b }, moved: { w, g, b }, since, paused }.
// Times are in milliseconds. Only the player on move has a running clock, and only once
// they have made their first move. `since` is when the current turn's time began.
// `paused` stops every clock, while the player on move waits on a takeback they agreed to.
import { COLORS } from '../shared/engine.js';

export const MAX_MINUTES = 180;
export const MAX_INCREMENT = 60;

// Checks a { minutes, increment } time control from a client. Null means no clock.
export function parseTimeControl(input) {
  if (input == null) return null;
  const minutes = Number(input.minutes);
  const increment = Number(input.increment ?? 0);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) {
    throw new Error(`The clock must be between 0 and ${MAX_MINUTES} minutes`);
  }
  if (!Number.isInteger(increment) || increment < 0 || increment > MAX_INCREMENT) {
    throw new Error(`The increment must be a whole number from 0 to ${MAX_INCREMENT} seconds`);
  }
  return { minutes, increment };
}

export function createClock({ minutes, increment }, now) {
  const initial = Math.round(minutes * 60000);
  return {
    initial,
    increment: increment * 1000,
    remaining: Object.fromEntries(COLORS.map((c) => [c, initial])),
    moved: Object.fromEntries(COLORS.map((c) => [c, false])),
    since: now,
  };
}

// Whose clock is ticking, if anyone's.
export function runningColor(clock, game) {
  if (!clock || clock.paused || game?.status !== 'active') return null;
  return clock.moved[game.turn] ? game.turn : null;
}

// Each player's time left at `now`, without changing the clock.
export function timeLeft(clock, game, now) {
  const left = { ...clock.remaining };
  const color = runningColor(clock, game);
  if (color) left[color] = Math.max(0, left[color] - (now - clock.since));
  return left;
}

// Brings the clock up to `now` for a change to the game: charges the time the turn took,
// credits the increment if `mover` just moved, and starts the next turn's time. A player's
// first move is untimed, so it earns no increment either.
// Pass the game as it was before the change.
export function settle(clock, gameBefore, now, mover = null) {
  clock.remaining = timeLeft(clock, gameBefore, now);
  if (mover) {
    if (clock.moved[mover]) clock.remaining[mover] += clock.increment;
    clock.moved[mover] = true;
  }
  clock.since = now;
}

export function pause(clock, game, now) {
  settle(clock, game, now);
  clock.paused = true;
}

export function resume(clock, now) {
  if (!clock?.paused) return;
  clock.paused = false;
  clock.since = now;
}

// Whether the player on move has used up their time at `now`.
export function hasFlagged(clock, game, now) {
  const color = runningColor(clock, game);
  return Boolean(color) && timeLeft(clock, game, now)[color] <= 0;
}
