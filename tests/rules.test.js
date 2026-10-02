import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialGame, indexOf, validateMove, applyMove, isInCheck, legalMoves, undoMove } from '../src/shared/rules.js';

const p = (x, y) => ({ x, y });
function position(pieces = [], turn = 'red') {
  const game = { board: Array(90).fill(null), turn, history: [] };
  for (const [side, type, x, y] of [['red', 'general', 4, 9], ['black', 'general', 5, 0], ...pieces]) {
    game.board[indexOf(p(x, y))] = { side, type };
  }
  return game;
}
const allowed = (game, from, to) => assert.equal(validateMove(game, from, to).ok, true, validateMove(game, from, to).error);
const denied = (game, from, to) => assert.equal(validateMove(game, from, to).ok, false);

test('standard setup contains 32 pieces and red moves first', () => {
  const game = createInitialGame();
  assert.equal(game.turn, 'red');
  assert.equal(game.board.filter(Boolean).length, 32);
  for (const side of ['red', 'black']) assert.equal(game.board.filter((piece) => piece?.side === side).length, 16);
  assert.equal(isInCheck(game.board, 'red'), false);
  assert.equal(isInCheck(game.board, 'black'), false);
  allowed(game, p(1, 9), p(2, 7));
  denied(game, p(0, 9), p(0, 5));
});

test('rook moves straight, captures enemies, and cannot jump or capture friendly pieces', () => {
  const game = position([['red', 'rook', 0, 8], ['black', 'pawn', 0, 2]]);
  allowed(game, p(0, 8), p(0, 2));
  allowed(game, p(0, 8), p(3, 8));
  denied(game, p(0, 8), p(1, 7));
  game.board[indexOf(p(0, 5))] = { side: 'red', type: 'pawn' };
  denied(game, p(0, 8), p(0, 2));
  denied(game, p(0, 8), p(0, 5));
});

for (const side of ['red', 'black']) {
  test(`${side} horse has all eight destinations and the correct orthogonal leg`, () => {
    const game = position([[side, 'horse', 3, 4]], side);
    for (const [dx, dy] of [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [-1, 2], [1, -2], [-1, -2]]) {
      const to = p(3 + dx, 4 + dy);
      allowed(game, p(3, 4), to);
      const leg = Math.abs(dx) === 2 ? p(3 + Math.sign(dx), 4) : p(3, 4 + Math.sign(dy));
      game.board[indexOf(leg)] = { side, type: 'pawn' };
      denied(game, p(3, 4), to);
      game.board[indexOf(leg)] = null;
    }
    denied(game, p(3, 4), p(4, 5));
  });

  test(`${side} elephant obeys its eye and river boundary`, () => {
    const y = side === 'red' ? 9 : 0;
    const step = side === 'red' ? -1 : 1;
    const game = position([[side, 'elephant', 2, y]], side);
    allowed(game, p(2, y), p(4, y + 2 * step));
    game.board[indexOf(p(3, y + step))] = { side, type: 'pawn' };
    denied(game, p(2, y), p(4, y + 2 * step));
    const riverY = side === 'red' ? 5 : 4;
    const river = position([[side, 'elephant', 2, riverY]], side);
    denied(river, p(2, riverY), p(4, riverY + 2 * step));
    denied(river, p(2, riverY), p(3, riverY + step));
  });

  test(`${side} pawn gains sideways moves only after crossing and never retreats`, () => {
    const step = side === 'red' ? -1 : 1;
    const y = side === 'red' ? 5 : 4;
    let game = position([[side, 'pawn', 2, y]], side);
    allowed(game, p(2, y), p(2, y + step));
    denied(game, p(2, y), p(3, y));
    denied(game, p(2, y), p(2, y - step));
    game = position([[side, 'pawn', 2, y + step]], side);
    allowed(game, p(2, y + step), p(3, y + step));
    allowed(game, p(2, y + step), p(1, y + step));
    denied(game, p(2, y + step), p(2, y));
    denied(game, p(2, y + step), p(3, y + 2 * step));
    const endY = side === 'red' ? 0 : 9;
    game = position([[side, 'pawn', 2, endY]], side);
    allowed(game, p(2, endY), p(3, endY));
    denied(game, p(2, endY), p(2, endY - step));
  });
}

test('cannon requires exactly one screen to capture, and none for a quiet move', () => {
  const game = position([['red', 'cannon', 0, 7], ['black', 'rook', 0, 1]]);
  denied(game, p(0, 7), p(0, 1));
  allowed(game, p(0, 7), p(2, 7));
  for (const side of ['red', 'black']) {
    game.board[indexOf(p(0, 4))] = { side, type: 'pawn' };
    allowed(game, p(0, 7), p(0, 1));
    denied(game, p(0, 7), p(0, 2));
  }
  game.board[indexOf(p(0, 3))] = { side: 'black', type: 'pawn' };
  denied(game, p(0, 7), p(0, 1));
  denied(game, p(0, 7), p(1, 6));
});

test('advisors move diagonally inside the palace on both sides', () => {
  for (const side of ['red', 'black']) {
    const y = side === 'red' ? 9 : 0;
    const step = side === 'red' ? -1 : 1;
    const game = position([[side, 'advisor', 3, y]], side);
    allowed(game, p(3, y), p(4, y + step));
    denied(game, p(3, y), p(2, y + step));
    denied(game, p(3, y), p(3, y + step));
  }
});

test('generals move orthogonally one point inside the palace', () => {
  const game = position();
  allowed(game, p(4, 9), p(3, 9));
  allowed(game, p(4, 9), p(4, 8));
  denied(game, p(4, 9), p(3, 8));
  denied(game, p(4, 9), p(4, 7));
  game.board[indexOf(p(4, 9))] = null;
  game.board[indexOf(p(4, 7))] = { side: 'red', type: 'general' };
  denied(game, p(4, 7), p(4, 6));
});

test('removing the last screen between generals is forbidden', () => {
  const game = position([['red', 'rook', 4, 5]]);
  game.board[indexOf(p(5, 0))] = null;
  game.board[indexOf(p(4, 0))] = { side: 'black', type: 'general' };
  denied(game, p(4, 5), p(3, 5));
  allowed(game, p(4, 5), p(4, 4));
  game.board[indexOf(p(4, 5))] = null;
  assert.equal(isInCheck(game.board, 'red'), true);
  assert.equal(isInCheck(game.board, 'black'), true);
});

test('a pinned piece cannot expose its own general and check must be answered', () => {
  const game = position([['red', 'rook', 4, 8], ['black', 'rook', 4, 0], ['red', 'pawn', 0, 6]]);
  denied(game, p(4, 8), p(3, 8));
  allowed(game, p(4, 8), p(4, 0));
  game.board[indexOf(p(4, 8))] = null;
  assert.equal(isInCheck(game.board, 'red'), true);
  denied(game, p(0, 6), p(0, 5));
  allowed(game, p(4, 9), p(3, 9));
});

test('horse legs and cannon screens also determine attacks on the general', () => {
  const horse = position([['black', 'horse', 3, 7]]);
  assert.equal(isInCheck(horse.board, 'red'), true);
  horse.board[indexOf(p(3, 8))] = { side: 'red', type: 'pawn' };
  assert.equal(isInCheck(horse.board, 'red'), false);
  const cannon = position([['black', 'cannon', 4, 0]]);
  assert.equal(isInCheck(cannon.board, 'red'), false);
  cannon.board[indexOf(p(4, 5))] = { side: 'red', type: 'pawn' };
  assert.equal(isInCheck(cannon.board, 'red'), true);
  cannon.board[indexOf(p(4, 6))] = { side: 'black', type: 'pawn' };
  assert.equal(isInCheck(cannon.board, 'red'), false);
});

test('invalid coordinates, empty squares, same square and wrong turn are rejected', () => {
  const game = createInitialGame();
  for (const point of [null, {}, p(-1, 0), p(9, 0), p(0, 10), p(1.5, 2), { x: '1', y: 2 }]) {
    denied(game, p(0, 6), point);
    denied(game, point, p(0, 5));
  }
  denied(game, p(0, 5), p(0, 4));
  denied(game, p(0, 6), p(0, 6));
  denied(game, p(0, 3), p(0, 4));
});

test('moves and captures are immutable, alternate turns, and undo restores the exact state', () => {
  const game = position([['red', 'rook', 0, 8], ['black', 'pawn', 0, 2]]);
  const original = structuredClone(game);
  const result = applyMove(game, p(0, 8), p(0, 2));
  assert.equal(result.ok, true);
  assert.deepEqual(game, original);
  assert.equal(result.game.turn, 'black');
  assert.equal(result.game.history[0].captured.type, 'pawn');
  assert.equal(result.game.board[indexOf(p(0, 8))], null);
  assert.deepEqual(undoMove(result.game), original);
  assert.deepEqual(undoMove(game), game);
});

test('legal-move suggestions include every accepted destination and never leave self in check', () => {
  let game = createInitialGame();
  for (let ply = 0; ply < 100; ply++) {
    const candidates = game.board.flatMap((piece, index) => {
      if (piece?.side !== game.turn) return [];
      const from = p(index % 9, Math.floor(index / 9));
      return legalMoves(game, from).map((to) => ({ from, to }));
    });
    if (!candidates.length) break;
    const move = candidates[(ply * 17 + 3) % candidates.length];
    const previousSide = game.turn;
    const result = applyMove(game, move.from, move.to);
    assert.equal(result.ok, true);
    assert.equal(isInCheck(result.game.board, previousSide), false);
    game = result.game;
  }
  assert.ok(game.history.length > 20);
});
