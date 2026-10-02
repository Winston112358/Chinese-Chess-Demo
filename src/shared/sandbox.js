import { applyMove, undoMove } from './rules.js';

export function createSandbox(realGame, revision) {
  return {
    baseRevision: revision,
    game: structuredClone({ ...realGame, history: [] }),
  };
}

export function rebaseSandbox(sandbox, realGame, revision) {
  return sandbox.baseRevision === revision ? sandbox : createSandbox(realGame, revision);
}

export function sandboxApplyMove(sandbox, from, to) {
  const result = applyMove(sandbox.game, from, to);
  if (!result.ok) return result;
  return { ok: true, sandbox: { ...sandbox, game: result.game } };
}

export function sandboxUndo(sandbox) {
  const game = undoMove(sandbox.game);
  return game === sandbox.game ? sandbox : { ...sandbox, game };
}
