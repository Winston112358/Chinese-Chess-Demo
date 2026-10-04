import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialGame, applyMove, undoMove, indexOf, pieceAt } from '../src/shared/rules.js';
import { createSandbox, sandboxApplyMove, sandboxUndo } from '../src/shared/sandbox.js';
import { createReplay, replayGame, seekReplay, stepReplay } from '../src/shared/replay.js';

const p = (x, y) => ({ x, y });
function move(game, from, to) {
  const applied = applyMove(game, from, to);
  assert.equal(applied.ok, true, applied.error);
  return applied.game;
}
function opening() {
  const states = [createInitialGame()];
  for (const [from, to] of [
    [p(0, 6), p(0, 5)], [p(0, 3), p(0, 4)],
    [p(7, 9), p(6, 7)], [p(1, 0), p(2, 2)],
  ]) states.push(move(states.at(-1), from, to));
  return states;
}
function position(pieces, turn = 'red') {
  const game = { board: Array(90).fill(null), turn, history: [], result: null };
  for (const [side, type, x, y] of [['red', 'general', 4, 9], ['black', 'general', 5, 0], ...pieces]) {
    game.board[indexOf(p(x, y))] = { side, type };
  }
  return game;
}

test('replay starts at the actual initial position and each frame exactly matches the surviving game', () => {
  const states = opening();
  states.at(-1).result = { winner: 'black', loser: 'red', reason: 'timeout' };
  const real = states.at(-1);
  const before = structuredClone(real);
  const replay = createReplay(real);
  assert.equal(replay.index, 0);
  assert.equal(replay.length, 4);
  assert.equal(replay.frames.length, 5);
  assert.deepEqual(replay.result, real.result);
  for (let index = 0; index < states.length; index++) {
    assert.deepEqual(replayGame(seekReplay(replay, index)), states[index]);
  }
  assert.deepEqual(real, before);
});

test('a record received through LAN JSON reconstructs the same positions and final result', () => {
  const real = opening().at(-1);
  real.result = { winner: null, loser: null, reason: 'draw' };
  const expected = createReplay(real);
  const actual = createReplay(JSON.parse(JSON.stringify(real)));
  assert.deepEqual(actual, expected);
});

test('custom starting positions, black-to-move and both sides of captures are restored exactly', () => {
  const initial = position([
    ['red', 'rook', 0, 8], ['black', 'pawn', 0, 2],
    ['black', 'rook', 8, 1], ['red', 'pawn', 8, 6],
  ], 'black');
  const first = move(initial, p(8, 1), p(8, 6));
  const final = move(first, p(0, 8), p(0, 2));
  final.result = { winner: null, loser: null, reason: 'draw' };
  const replay = createReplay(final);
  assert.deepEqual(replayGame(replay), initial);
  assert.deepEqual(replayGame(stepReplay(replay)), first);
  assert.deepEqual(replayGame(seekReplay(replay, 2)), final);
  assert.equal(pieceAt(replayGame(replay).board, p(8, 6)).type, 'pawn');
  assert.equal(pieceAt(replayGame(replay).board, p(0, 2)).type, 'pawn');
});

test('a terminal general capture only has a result at the final frame and restores the general when stepping back', () => {
  const initial = position([['red', 'rook', 5, 2]]);
  const final = move(initial, p(5, 2), p(5, 0));
  assert.equal(final.result.reason, 'general-captured');
  const replay = createReplay(final);
  assert.deepEqual(replayGame(replay), initial);
  assert.equal(replayGame(replay).result, null);
  assert.deepEqual(replayGame(stepReplay(replay)), final);
  const previous = stepReplay(stepReplay(replay), -1);
  assert.deepEqual(replayGame(previous), initial);
  assert.equal(pieceAt(replayGame(previous).board, p(5, 0)).type, 'general');
});

for (const reason of ['timeout', 'resign', 'draw', 'checkmate', 'stalemate', 'repetition', 'perpetual-check', 'perpetual-chase', 'no-capture', 'insufficient-material']) {
  test(`replay preserves a saved ${reason} result without recomputing it in earlier frames`, () => {
    const real = opening().at(-1);
    real.result = { winner: null, loser: null, reason, details: { saved: true } };
    const replay = createReplay(real);
    for (let index = 0; index < replay.length; index++) {
      assert.equal(replayGame(seekReplay(replay, index)).result, null);
    }
    assert.deepEqual(replayGame(seekReplay(replay, replay.length)).result, real.result);
    assert.deepEqual(replay.result, real.result);
  });
}

test('an ended zero-move game can be reviewed without inventing moves or losing its result', () => {
  const real = createInitialGame();
  real.result = { winner: 'black', loser: 'red', reason: 'resign' };
  const replay = createReplay(real);
  assert.equal(replay.length, 0);
  assert.equal(replay.frames.length, 1);
  assert.deepEqual(replayGame(replay), real);
  assert.equal(stepReplay(replay), replay);
  assert.equal(stepReplay(replay, -1), replay);
});

test('the record excludes abandoned moves and replays only the branch chosen after undo', () => {
  const initial = createInitialGame();
  const discarded = move(initial, p(0, 6), p(0, 5));
  const reopened = undoMove(discarded);
  const adopted = move(reopened, p(2, 6), p(2, 5));
  const final = move(adopted, p(8, 3), p(8, 4));
  final.result = { winner: 'red', loser: 'black', reason: 'resign' };
  const replay = createReplay(final);
  assert.equal(replay.length, 2);
  assert.deepEqual(replayGame(replay), initial);
  assert.deepEqual(replayGame(stepReplay(replay)), adopted);
  assert.deepEqual(replayGame(seekReplay(replay, 2)).history.map(({ from }) => from), [p(2, 6), p(8, 3)]);
  assert.equal(pieceAt(replayGame(seekReplay(replay, 2)).board, p(0, 6)).type, 'pawn');
});

test('step and seek clamp at the boundaries and preserve independent earlier cursors', () => {
  const real = opening().at(-1);
  real.result = { winner: 'red', loser: 'black', reason: 'resign' };
  const initial = createReplay(real);
  const second = seekReplay(initial, 2.9);
  assert.equal(second.index, 2);
  assert.equal(initial.index, 0);
  assert.equal(stepReplay(second).index, 3);
  assert.equal(stepReplay(second, -1).index, 1);
  assert.equal(stepReplay(second, -100).index, 0);
  assert.equal(stepReplay(second, 100).index, 4);
  assert.equal(seekReplay(second, Infinity).index, 4);
  assert.equal(seekReplay(second, -Infinity).index, 0);
  assert.equal(seekReplay(second, NaN), second);
  assert.equal(seekReplay(second, 2), second);
  assert.equal(second.frames, initial.frames);
});

test('snapshot copies and frozen stored frames isolate the real game and all replay steps', () => {
  const real = opening().at(-1);
  real.result = { winner: 'red', loser: 'black', reason: 'resign' };
  const expected = structuredClone(real);
  const replay = seekReplay(createReplay(real), real.history.length);
  const view = replayGame(replay);
  view.board[0].type = 'pawn';
  view.history[0].from.x = 8;
  view.result.reason = 'timeout';
  assert.deepEqual(real, expected);
  assert.deepEqual(replayGame(replay), expected);
  assert.throws(() => { replay.frames[0].board[0].type = 'pawn'; }, TypeError);
  assert.throws(() => { replay.frames.at(-1).history[0].from.x = 8; }, TypeError);
  real.board[0].type = 'pawn';
  real.result.reason = 'timeout';
  assert.deepEqual(replayGame(replay), expected);
});

test('sandbox analysis starts at a reviewed step, can undo to that baseline, and leaves playback unchanged', () => {
  const real = opening().at(-1);
  real.result = { winner: 'red', loser: 'black', reason: 'resign' };
  const original = structuredClone(real);
  const replay = stepReplay(createReplay(real));
  const frame = replayGame(replay);
  const sandbox = createSandbox({ ...frame, result: null }, replay.index);
  assert.deepEqual(sandbox.game.board, frame.board);
  assert.equal(sandbox.game.turn, 'black');
  assert.equal(sandbox.game.history.length, 0);
  const analysis = sandboxApplyMove(sandbox, p(2, 3), p(2, 4));
  assert.equal(analysis.ok, true, analysis.error);
  assert.deepEqual(sandboxUndo(analysis.sandbox), sandbox);
  assert.deepEqual(replayGame(replay), frame);
  assert.deepEqual(real, original);
  assert.deepEqual(replayGame(stepReplay(replay)), opening()[2]);
});

test('sandbox can explore a finished frame after explicitly clearing its result without clearing the saved result', () => {
  const real = opening().at(-1);
  real.result = { winner: 'red', loser: 'black', reason: 'resign' };
  const replay = seekReplay(createReplay(real), real.history.length);
  const sandbox = createSandbox({ ...replayGame(replay), result: null }, replay.index);
  const analysis = sandboxApplyMove(sandbox, p(2, 6), p(2, 5));
  assert.equal(analysis.ok, true, analysis.error);
  assert.equal(analysis.sandbox.game.result, null);
  assert.deepEqual(replayGame(replay).result, real.result);
});

test('the replay entry rejects a live game', () => {
  assert.throws(() => createReplay(createInitialGame()), /仅已结束/);
});
