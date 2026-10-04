export const DEFAULT_TIME_MS = 10 * 60_000;
export const MIN_TIME_MS = 6_000;
export const MAX_TIME_MS = 180 * 60_000;
export const MIN_MOVE_TIME_MS = 1000;
export const MAX_MOVE_TIME_MS = 3600_000;

export function parseTimeControl(value) {
  if (value === undefined) return { ok: true, timeControl: { red: DEFAULT_TIME_MS, black: DEFAULT_TIME_MS } };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['red', 'black'].every((side) => Number.isSafeInteger(value[side])
      && value[side] >= MIN_TIME_MS && value[side] <= MAX_TIME_MS && value[side] % 600 === 0)) {
    return { ok: false, error: '双方总时间须为 0.1–180 分钟，最多两位小数' };
  }
  return { ok: true, timeControl: { red: value.red, black: value.black } };
}

export function parseMoveTime(value, fallback = null) {
  const moveTimeMs = value === undefined ? fallback ?? null : value;
  if (moveTimeMs !== null && (!Number.isSafeInteger(moveTimeMs)
    || moveTimeMs < MIN_MOVE_TIME_MS || moveTimeMs > MAX_MOVE_TIME_MS || moveTimeMs % 1000 !== 0)) {
    return { ok: false, error: '单步限时须为 1–3600 秒的整数，或关闭' };
  }
  return { ok: true, moveTimeMs };
}

export function createClock(initialMs, enabled = true, moveTimeMs = null) {
  const limit = enabled ? moveTimeMs : null;
  return {
    initialMs: { ...initialMs }, remainingMs: { ...initialMs }, enabled,
    moveTimeMs: limit, moveRemainingMs: limit, timeoutReason: null,
    runningSide: null, started: false, changedAt: null,
  };
}

export function startClock(clock, side, now) {
  clock.started = true;
  clock.runningSide = clock.enabled ? side : null;
  clock.changedAt = now;
  clock.moveRemainingMs = clock.moveTimeMs;
  clock.timeoutReason = null;
}

export function settleClock(clock, now) {
  if (!clock.runningSide) return null;
  const side = clock.runningSide;
  const totalRemaining = clock.remainingMs[side];
  const moveRemaining = clock.moveRemainingMs;
  // Stop charging at the first deadline, even if the tick or request arrives late.
  const charge = Math.min(Math.max(0, now - clock.changedAt), totalRemaining, moveRemaining ?? Infinity);
  clock.remainingMs[side] = Math.max(0, totalRemaining - charge);
  if (moveRemaining !== null) clock.moveRemainingMs = Math.max(0, moveRemaining - charge);
  clock.changedAt = now;
  if (clock.remainingMs[side] > 0 && clock.moveRemainingMs !== 0) return null;
  clock.timeoutReason = totalRemaining <= (moveRemaining ?? Infinity) ? 'timeout' : 'move-timeout';
  clock.runningSide = null;
  return side;
}

export function clockSnapshot(clock, now) {
  const remainingMs = { ...clock.remainingMs };
  let moveRemainingMs = clock.moveRemainingMs;
  if (clock.runningSide) {
    const side = clock.runningSide;
    const charge = Math.min(Math.max(0, now - clock.changedAt), remainingMs[side], moveRemainingMs ?? Infinity);
    remainingMs[side] = Math.max(0, remainingMs[side] - charge);
    if (moveRemainingMs !== null) moveRemainingMs = Math.max(0, moveRemainingMs - charge);
  }
  return {
    initialMs: { ...clock.initialMs }, remainingMs, runningSide: clock.runningSide,
    moveTimeMs: clock.moveTimeMs, moveRemainingMs,
    enabled: clock.enabled, started: clock.started, serverNow: now,
  };
}
