import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeControl, parseMoveTime, createClock, startClock, settleClock, clockSnapshot } from '../src/server/clock.js';

test('time controls accept defaults, asymmetric budgets and bounded custom minutes', () => {
  assert.deepEqual(parseTimeControl().timeControl, { red: 600_000, black: 600_000 });
  for (const settings of [{ red: 600_000, black: 900_000 }, { red: 6000, black: 10_800_000 }, { red: 740_400, black: 600_000 }]) {
    assert.deepEqual(parseTimeControl(settings), { ok: true, timeControl: settings });
  }
  for (const settings of [null, [], '10', {}, { red: 0, black: 600_000 }, { red: -6000, black: 600_000 },
    { red: '600000', black: 600_000 }, { red: 6000.5, black: 600_000 }, { red: 6001, black: 600_000 },
    { red: NaN, black: 600_000 }, { red: Infinity, black: 600_000 }, { red: 10_800_600, black: 600_000 }]) {
    assert.equal(parseTimeControl(settings).ok, false);
  }
});

test('waiting clocks never charge; elapsed time charges only the running side without cumulative drift', () => {
  const clock = createClock({ red: 6000, black: 9000 });
  settleClock(clock, 1_000_000);
  assert.deepEqual(clock.remainingMs, { red: 6000, black: 9000 });
  startClock(clock, 'red', 1_000_000);
  assert.equal(settleClock(clock, 1_000_123.5), null);
  assert.equal(settleClock(clock, 1_001_500), null);
  assert.deepEqual(clock.remainingMs, { red: 4500, black: 9000 });
  const snapshot = clockSnapshot(clock, 1_002_000);
  assert.deepEqual(snapshot.remainingMs, { red: 4000, black: 9000 });
  assert.equal(clock.remainingMs.red, 4500, 'reading the clock must not mutate it');
  startClock(clock, 'black', 1_001_500);
  settleClock(clock, 1_002_500);
  assert.deepEqual(clock.remainingMs, { red: 4500, black: 8000 });
});

test('the exact deadline expires once, clamps at zero, and never charges the other side', () => {
  for (const side of ['red', 'black']) {
    const clock = createClock({ red: 6000, black: 6000 });
    startClock(clock, side, 1000);
    assert.equal(settleClock(clock, 6999.9), null);
    assert.equal(settleClock(clock, 7000), side);
    assert.equal(clock.remainingMs[side], 0);
    assert.equal(clock.runningSide, null);
    assert.equal(settleClock(clock, 100_000), null);
    assert.equal(clock.remainingMs[side === 'red' ? 'black' : 'red'], 6000);
  }
});

test('single-move limits accept only whole seconds in range, with null and legacy omission disabled', () => {
  for (const value of [null, 1000, 2000, 3_600_000]) {
    assert.deepEqual(parseMoveTime(value), { ok: true, moveTimeMs: value });
  }
  assert.deepEqual(parseMoveTime(), { ok: true, moveTimeMs: null });
  assert.deepEqual(parseMoveTime(undefined, 3000), { ok: true, moveTimeMs: 3000 });
  assert.deepEqual(parseMoveTime(null, 3000), { ok: true, moveTimeMs: null });
  for (const value of [0, -1000, 999, 1001, 1000.5, 3_601_000, '1000', true, false, {}, [], NaN, Infinity]) {
    assert.equal(parseMoveTime(value).ok, false, String(value));
  }
});

test('one shared elapsed duration charges both limits; snapshots do not mutate and a new turn resets only the move budget', () => {
  const clock = createClock({ red: 6000, black: 9000 }, true, 2000);
  assert.equal(clockSnapshot(clock, 500_000).moveRemainingMs, 2000);
  assert.equal(settleClock(clock, 500_000), null);
  startClock(clock, 'red', 500_000);
  settleClock(clock, 500_123.5);
  settleClock(clock, 501_500);
  const snapshot = clockSnapshot(clock, 501_750);
  assert.deepEqual(snapshot.remainingMs, { red: 4250, black: 9000 });
  assert.equal(snapshot.moveTimeMs, 2000);
  assert.equal(snapshot.moveRemainingMs, 250);
  assert.equal(clock.moveRemainingMs, 500);
  assert.equal(clock.remainingMs.red, 4500);
  startClock(clock, 'black', 501_500);
  assert.equal(clock.moveRemainingMs, 2000);
  settleClock(clock, 502_500);
  assert.deepEqual(clock.remainingMs, { red: 4500, black: 8000 });
  assert.equal(clock.moveRemainingMs, 1000);
  const disabled = createClock({ red: 6000, black: 9000 }, false, 2000);
  startClock(disabled, 'red', 0);
  assert.equal(settleClock(disabled, 100_000_000), null);
  assert.equal(disabled.moveTimeMs, null);
  assert.equal(clockSnapshot(disabled, 100_000_000).moveRemainingMs, null);
});

test('either deadline stops the clock at the first expiry, including delayed ticks and simultaneous expiry', () => {
  for (const side of ['red', 'black']) {
    const clock = createClock({ red: 6000, black: 6000 }, true, 2000);
    startClock(clock, side, 1000);
    assert.equal(settleClock(clock, 2999.9), null);
    assert.equal(settleClock(clock, 3000), side);
    assert.equal(clock.timeoutReason, 'move-timeout');
    assert.equal(clock.moveRemainingMs, 0);
    assert.equal(clock.remainingMs[side], 4000);
    assert.equal(clock.runningSide, null);
    assert.equal(settleClock(clock, 100_000), null);
    assert.equal(clock.remainingMs[side], 4000);
  }
  for (const [total, move, reason, remainingMove] of [
    [6000, 2000, 'move-timeout', 0], [6000, 9000, 'timeout', 3000], [6000, 6000, 'timeout', 0],
  ]) {
    const clock = createClock({ red: total, black: 9000 }, true, move);
    startClock(clock, 'red', 0);
    const projected = clockSnapshot(clock, 60_000);
    assert.equal(projected.remainingMs.red, reason === 'move-timeout' ? total - move : 0);
    assert.equal(projected.moveRemainingMs, remainingMove);
    assert.equal(settleClock(clock, 60_000), 'red');
    assert.equal(clock.timeoutReason, reason);
    assert.equal(clock.moveRemainingMs, remainingMove);
    assert.deepEqual(clockSnapshot(clock, 70_000).remainingMs, projected.remainingMs);
  }
});
