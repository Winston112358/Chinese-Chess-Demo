import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeControl, createClock, startClock, settleClock, clockSnapshot } from '../src/server/clock.js';

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
