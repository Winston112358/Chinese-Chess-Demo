import { parseTimeControl, parseMoveTime } from './clock.js';

export const START_COUNTDOWN_MS = 3000;

export function parseRoundConfig(value, defaults) {
  if (value === undefined) return {
    ok: true, config: { ...defaults, timeControl: { ...defaults.timeControl }, moveTimeMs: defaults.timed ? defaults.moveTimeMs ?? null : null },
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['red', 'black'].includes(value.redSide) || typeof value.timed !== 'boolean') {
    return { ok: false, error: '下一局配置格式错误' };
  }
  const times = parseTimeControl(value.timed ? value.timeControl : defaults.timeControl);
  if (!times.ok) return times;
  const moveTime = parseMoveTime(value.timed ? value.moveTimeMs : null, defaults.moveTimeMs);
  if (!moveTime.ok) return moveTime;
  return { ok: true, config: { redSide: value.redSide, timed: value.timed, timeControl: times.timeControl, moveTimeMs: moveTime.moveTimeMs } };
}
