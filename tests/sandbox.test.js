import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialGame, applyMove, indexOf, pieceAt, legalMoves, otherSide } from '../src/shared/rules.js';
import { createSandbox, rebaseSandbox, sandboxApplyMove, sandboxUndo } from '../src/shared/sandbox.js';

const p = (x, y) => ({ x, y });
function position(pieces = [], turn = 'red') {
  const game = { board: Array(90).fill(null), turn, history: [], result: null };
  for (const [side, type, x, y] of [['red', 'general', 4, 9], ['black', 'general', 5, 0], ...pieces]) {
    game.board[indexOf(p(x, y))] = { side, type };
  }
  return game;
}
function move(sandbox, from, to) {
  const result = sandboxApplyMove(sandbox, from, to);
  assert.equal(result.ok, true, result.error);
  return result.sandbox;
}

for (const side of ['red', 'black']) {
  test(`${side} sandbox undo across the river removes sideways moves and restores horizontal captures`, () => {
    const beforeY = side === 'red' ? 5 : 4;
    const step = side === 'red' ? -1 : 1;
    const enemy = otherSide(side);
    const enemyRookY = side === 'red' ? 1 : 8;
    const real = position([
      [side, 'pawn', 2, beforeY], [enemy, 'horse', 3, beforeY + step],
      [enemy, 'rook', 8, enemyRookY],
    ], side);
    const before = structuredClone(real);
    const baseline = createSandbox(real, 12);
    assert.deepEqual(legalMoves(baseline.game, p(2, beforeY)), [p(2, beforeY + step)]);
    const crossed = move(baseline, p(2, beforeY), p(2, beforeY + step));
    const reply = move(crossed, p(8, enemyRookY), p(7, enemyRookY));
    assert.ok(legalMoves(reply.game, p(2, beforeY + step)).some(({ x, y }) => x === 3 && y === beforeY + step));
    const captured = move(reply, p(2, beforeY + step), p(3, beforeY + step));
    assert.deepEqual(captured.game.history.at(-1).captured, { side: enemy, type: 'horse' });
    assert.deepEqual(sandboxUndo(captured), reply);
    assert.equal(sandboxUndo(captured).game.turn, side);
    assert.deepEqual(sandboxUndo(reply), crossed);
    const uncrossed = sandboxUndo(crossed);
    assert.deepEqual(uncrossed, baseline);
    assert.deepEqual(legalMoves(uncrossed.game, p(2, beforeY)), [p(2, beforeY + step)]);
    assert.deepEqual(real, before);
  });
}

test('sandbox deep-copies the real board, pieces, and result without borrowing real history', () => {
  const real = applyMove(createInitialGame(), p(0, 6), p(0, 5)).game;
  real.result = { winner: 'red', loser: 'black', reason: 'timeout' };
  const original = structuredClone(real);
  const sandbox = createSandbox(real, 7);
  assert.equal(sandbox.baseRevision, 7);
  assert.equal(sandbox.game.turn, 'black');
  assert.deepEqual(sandbox.game.result, real.result);
  assert.notEqual(sandbox.game.result, real.result);
  assert.notEqual(sandbox.game.board, real.board);
  assert.notEqual(pieceAt(sandbox.game.board, p(0, 5)), pieceAt(real.board, p(0, 5)));
  assert.deepEqual(sandbox.game.history, []);
  sandbox.game.result.reason = 'checkmate';
  pieceAt(sandbox.game.board, p(0, 5)).type = 'rook';
  sandbox.game.board[indexOf(p(2, 9))] = null;
  assert.deepEqual(real, original);
});

test('the baseline cannot be undone, even when the real game already has moves or a result', () => {
  const real = applyMove(createInitialGame(), p(0, 6), p(0, 5)).game;
  real.result = { winner: 'red', loser: 'black', reason: 'timeout' };
  const sandbox = createSandbox(real, 1);
  assert.equal(sandboxUndo(sandbox), sandbox);
  assert.deepEqual(sandbox.game.board, real.board);
  assert.deepEqual(sandbox.game.result, real.result);
  assert.equal(sandbox.game.turn, 'black');
});

test('sandbox moves alternate both sides and repeated undo restores captures and baseline turn', () => {
  const real = position([
    ['red', 'rook', 0, 8], ['black', 'pawn', 0, 2],
    ['black', 'rook', 8, 1], ['red', 'pawn', 8, 6],
  ]);
  const original = structuredClone(real);
  const baseline = createSandbox(real, 18);
  const states = [baseline];
  for (const [from, to] of [[p(0, 8), p(0, 2)], [p(8, 1), p(8, 6)], [p(0, 2), p(2, 2)], [p(8, 6), p(7, 6)]]) {
    states.push(move(states.at(-1), from, to));
  }
  assert.equal(states[1].game.turn, 'black');
  assert.equal(states[2].game.turn, 'red');
  assert.deepEqual(states[1].game.history[0].captured, { side: 'black', type: 'pawn' });
  assert.deepEqual(states[2].game.history[1].captured, { side: 'red', type: 'pawn' });
  let current = states.at(-1);
  for (let index = states.length - 2; index >= 0; index--) {
    current = sandboxUndo(current);
    assert.deepEqual(current, states[index]);
  }
  assert.equal(sandboxUndo(current), current);
  assert.equal(current.game.history.length, 0);
  assert.deepEqual(real, original);
});

test('a hypothetical move does not alter the original real game or its previous sandbox state', () => {
  const real = createInitialGame();
  const baseline = createSandbox(real, 0);
  const before = structuredClone(baseline);
  const moved = move(baseline, p(0, 6), p(0, 5));
  assert.deepEqual(baseline, before);
  assert.deepEqual(real, createInitialGame());
  assert.equal(moved.game.history.length, 1);
  assert.equal(moved.baseRevision, 0);
});

test('illegal geometry and playing the wrong side leave the sandbox unchanged', () => {
  const sandbox = createSandbox(createInitialGame(), 0);
  const before = structuredClone(sandbox);
  for (const [from, to] of [[p(0, 6), p(1, 6)], [p(0, 3), p(0, 4)]]) {
    const rejected = sandboxApplyMove(sandbox, from, to);
    assert.equal(rejected.ok, false);
    assert.equal(typeof rejected.error, 'string');
    assert.equal('sandbox' in rejected, false);
  }
  assert.deepEqual(sandbox, before);
});

test('a sandbox terminal capture blocks further moves but undo restores the general and reopens play', () => {
  const real = position([['red', 'rook', 5, 2]]);
  const baseline = createSandbox(real, 3);
  const finished = move(baseline, p(5, 2), p(5, 0));
  assert.deepEqual(finished.game.result, { winner: 'red', loser: 'black', reason: 'general-captured' });
  assert.equal(sandboxApplyMove(finished, p(4, 9), p(3, 9)).ok, false);
  const reopened = sandboxUndo(finished);
  assert.deepEqual(reopened, baseline);
  assert.equal(reopened.game.result, null);
  assert.deepEqual(pieceAt(reopened.game.board, p(5, 0)), { side: 'black', type: 'general' });
  assert.equal(sandboxApplyMove(reopened, p(5, 2), p(5, 0)).ok, true);
});

test('undo can step back from checkmate after a multi-move hypothetical variation', () => {
  const opening = [
    [4, 6, 4, 5], [4, 3, 4, 4], [3, 9, 4, 8], [4, 4, 4, 5], [1, 7, 4, 7],
    [4, 5, 3, 5], [4, 7, 4, 2], [3, 5, 2, 5], [7, 7, 4, 7],
  ];
  let sandbox = createSandbox(createInitialGame(), 10);
  let penultimate;
  opening.forEach(([x, y, toX, toY], index) => {
    if (index === opening.length - 1) penultimate = sandbox;
    sandbox = move(sandbox, p(x, y), p(toX, toY));
  });
  assert.equal(sandbox.game.result.reason, 'checkmate');
  assert.deepEqual(sandboxUndo(sandbox), penultimate);
  assert.equal(sandboxUndo(sandbox).game.turn, 'red');
});

test('same-revision rebasing preserves the variation; a changed revision replaces its baseline', () => {
  const real = createInitialGame();
  const variation = move(createSandbox(real, 4), p(2, 6), p(2, 5));
  assert.equal(rebaseSandbox(variation, real, 4), variation);
  const updated = applyMove(real, p(0, 6), p(0, 5)).game;
  const rebased = rebaseSandbox(variation, updated, 5);
  assert.notEqual(rebased, variation);
  assert.equal(rebased.baseRevision, 5);
  assert.equal(rebased.game.turn, 'black');
  assert.deepEqual(rebased.game.board, updated.board);
  assert.deepEqual(rebased.game.history, []);
  assert.equal(sandboxUndo(rebased), rebased);
  pieceAt(rebased.game.board, p(0, 5)).type = 'horse';
  assert.equal(pieceAt(updated.board, p(0, 5)).type, 'pawn');
  assert.equal(variation.game.history.length, 1);
});
