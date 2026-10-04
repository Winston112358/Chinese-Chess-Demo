import { undoMove } from './rules.js';

function freezeSnapshot(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeSnapshot(child, seen);
  return Object.freeze(value);
}

// The surviving history is the record of the finished game. Reversing that
// record also recovers custom starting positions and captured pieces, without
// rerunning adjudication or recording any moves that were undone during play.
export function createReplay(game) {
  if (!game.result) throw new Error('仅已结束的对局可以复盘');
  const frames = Array(game.history.length + 1);
  frames[game.history.length] = structuredClone(game);
  for (let index = game.history.length - 1; index >= 0; index--) {
    frames[index] = undoMove(frames[index + 1]);
  }
  freezeSnapshot(frames);
  return Object.freeze({ frames, index: 0, length: game.history.length, result: frames.at(-1).result });
}

// Callers may safely use this copy as a sandbox baseline. The saved replay and
// the finished real game never borrow board, move, or result objects from it.
export function replayGame(replay) {
  return structuredClone(replay.frames[replay.index]);
}

export function seekReplay(replay, index) {
  const integer = Math.trunc(index);
  const nextIndex = Number.isNaN(integer) ? replay.index : Math.max(0, Math.min(replay.length, integer));
  return nextIndex === replay.index ? replay : Object.freeze({ ...replay, index: nextIndex });
}

export function stepReplay(replay, offset = 1) {
  return seekReplay(replay, replay.index + offset);
}
