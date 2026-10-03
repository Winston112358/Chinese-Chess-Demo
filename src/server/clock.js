export const DEFAULT_TIME_MS = 10 * 60_000;
export const MIN_TIME_MS = 6_000;
export const MAX_TIME_MS = 180 * 60_000;

export function parseTimeControl(value) {
  if (value === undefined) return { ok: true, timeControl: { red: DEFAULT_TIME_MS, black: DEFAULT_TIME_MS } };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['red', 'black'].every((side) => Number.isSafeInteger(value[side])
      && value[side] >= MIN_TIME_MS && value[side] <= MAX_TIME_MS && value[side] % 600 === 0)) {
    return { ok: false, error: '双方总时间须为 0.1–180 分钟，最多两位小数' };
  }
  return { ok: true, timeControl: { red: value.red, black: value.black } };
}

export function createClock(initialMs, enabled = true) {
  return { initialMs: { ...initialMs }, remainingMs: { ...initialMs }, enabled, runningSide: null, started: false, changedAt: null };
}

export function startClock(clock, side, now) {
  clock.started = true;
  clock.runningSide = clock.enabled ? side : null;
  clock.changedAt = now;
}

export function settleClock(clock, now) {
  if (!clock.runningSide) return null;
  const side = clock.runningSide;
  clock.remainingMs[side] = Math.max(0, clock.remainingMs[side] - Math.max(0, now - clock.changedAt));
  clock.changedAt = now;
  if (clock.remainingMs[side] > 0) return null;
  clock.runningSide = null;
  return side;
}

export function clockSnapshot(clock, now) {
  const remainingMs = { ...clock.remainingMs };
  if (clock.runningSide) {
    remainingMs[clock.runningSide] = Math.max(0, remainingMs[clock.runningSide] - Math.max(0, now - clock.changedAt));
  }
  return {
    initialMs: { ...clock.initialMs }, remainingMs, runningSide: clock.runningSide,
    enabled: clock.enabled, started: clock.started, serverNow: now,
  };
}
