import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialGame, indexOf, validateMove, applyMove, isInCheck, legalMoves, undoMove, getGameResult, otherSide } from '../src/shared/rules.js';

const p = (x, y) => ({ x, y });
function position(pieces = [], turn = 'red') {
  const game = { board: Array(90).fill(null), turn, history: [], result: null };
  for (const [side, type, x, y] of [['red', 'general', 4, 9], ['black', 'general', 5, 0], ...pieces]) {
    game.board[indexOf(p(x, y))] = { side, type };
  }
  return game;
}
const allowed = (game, from, to) => assert.equal(validateMove(game, from, to).ok, true, validateMove(game, from, to).error);
const denied = (game, from, to) => assert.equal(validateMove(game, from, to).ok, false);

function bruteLegalMoves(game, from) {
  const moves = [];
  for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
    if (validateMove(game, from, p(x, y)).ok) moves.push(p(x, y));
  }
  return moves;
}

test('standard setup contains 32 pieces and red moves first', () => {
  const game = createInitialGame();
  assert.equal(game.turn, 'red');
  assert.equal(game.result, null);
  assert.equal(getGameResult(game), null);
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
      const destinations = legalMoves(game, from);
      if (ply % 17 === 0 || ply === 99) {
        assert.deepEqual(destinations, bruteLegalMoves(game, from), `ply ${ply}, ${piece.type} at ${index}`);
      }
      return destinations.map((to) => ({ from, to }));
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

// Mirror both the board and colors so every endgame is tested from either side.
function fromRedPerspective(game, side) {
  if (side === 'red') return game;
  const board = Array(90).fill(null);
  game.board.forEach((piece, index) => {
    if (piece) board[indexOf(p(index % 9, 9 - Math.floor(index / 9)))] = { ...piece, side: otherSide(piece.side) };
  });
  return { ...game, board, turn: otherSide(game.turn) };
}
const perspectivePoint = (side, x, y) => p(x, side === 'red' ? y : 9 - y);

test('geometry candidates match all 90-square validations for blockers, captures, river edges and flying generals', () => {
  const flyingGenerals = position();
  flyingGenerals.board[indexOf(p(5, 0))] = null;
  flyingGenerals.board[indexOf(p(4, 0))] = { side: 'black', type: 'general' };
  const fixtures = [
    createInitialGame(),
    flyingGenerals,
    position([
      ['red', 'cannon', 0, 7], ['red', 'pawn', 0, 4], ['black', 'rook', 0, 1],
      ['black', 'pawn', 0, 0], ['black', 'pawn', 3, 7], ['black', 'rook', 6, 7],
      ['red', 'rook', 8, 5], ['red', 'pawn', 8, 7], ['black', 'horse', 5, 5],
    ]),
    position([
      ['red', 'horse', 3, 4], ['red', 'pawn', 3, 5], ['black', 'pawn', 4, 4],
      ['red', 'elephant', 2, 5], ['red', 'pawn', 1, 6], ['red', 'advisor', 3, 9],
      ['red', 'pawn', 0, 0], ['red', 'pawn', 8, 4], ['red', 'pawn', 6, 5],
    ]),
    position([
      ['black', 'rook', 4, 6], ['black', 'rook', 3, 8], ['black', 'rook', 5, 8],
      ['red', 'rook', 0, 7],
    ]),
  ];
  for (const side of ['red', 'black']) for (const fixture of fixtures) {
    const game = fromRedPerspective(fixture, side);
    game.board.forEach((piece, index) => {
      if (piece?.side !== game.turn) return;
      const from = p(index % 9, Math.floor(index / 9));
      assert.deepEqual(legalMoves(game, from), bruteLegalMoves(game, from), `${side} ${piece.type} at ${index}`);
    });
  }
  assert.ok(legalMoves(flyingGenerals, p(4, 9)).some((to) => to.x === 4 && to.y === 0));
});

test('a legal nine-ply opening finishes by double-cannon checkmate', () => {
  const moves = [
    [4, 6, 4, 5], [4, 3, 4, 4], [3, 9, 4, 8], [4, 4, 4, 5], [1, 7, 4, 7],
    [4, 5, 3, 5], [4, 7, 4, 2], [3, 5, 2, 5], [7, 7, 4, 7],
  ];
  let game = createInitialGame();
  moves.forEach(([x, y, toX, toY], index) => {
    const move = applyMove(game, p(x, y), p(toX, toY));
    assert.equal(move.ok, true, `ply ${index + 1}: ${move.error}`);
    game = move.game;
    if (index < moves.length - 1) assert.equal(game.result, null);
    if (index === 4) assert.equal(isInCheck(game.board, 'black'), true);
  });
  assert.deepEqual(game.result, { winner: 'red', loser: 'black', reason: 'checkmate' });
  assert.equal(game.history.length, 9);
  assert.deepEqual(legalMoves(game, p(4, 0)), []);
});

for (const side of ['red', 'black']) {
  test(`${side} can escape check by moving its general; check alone is not a loss`, () => {
    const game = fromRedPerspective(position([['black', 'rook', 4, 7]]), side);
    assert.equal(isInCheck(game.board, side), true);
    assert.equal(getGameResult(game), null);
    const move = applyMove(game, perspectivePoint(side, 4, 9), perspectivePoint(side, 3, 9));
    assert.equal(move.ok, true);
    assert.equal(isInCheck(move.game.board, side), false);
    assert.equal(move.game.result, null);
  });

  test(`${side} is not mated when another piece can block or capture the attacker`, () => {
    for (const defense of ['block', 'capture']) {
      const checkingY = defense === 'block' ? 6 : 7;
      const game = fromRedPerspective(position([
        ['black', 'rook', 4, checkingY], ['black', 'rook', 3, 8], ['black', 'rook', 5, 8],
        ['red', 'rook', 0, 7],
      ]), side);
      assert.equal(isInCheck(game.board, side), true);
      assert.deepEqual(legalMoves(game, perspectivePoint(side, 4, 9)), []);
      assert.equal(getGameResult(game), null, defense);
      const move = applyMove(game, perspectivePoint(side, 0, 7), perspectivePoint(side, 4, 7));
      assert.equal(move.ok, true, defense);
      assert.equal(isInCheck(move.game.board, side), false, defense);
      assert.equal(move.game.result, null, defense);
      assert.equal(move.game.history.at(-1).captured?.type ?? null, defense === 'capture' ? 'rook' : null);
    }
  });

  test(`${side} loses to checkmate; finished games reject moves and undo reopens play`, () => {
    const game = fromRedPerspective(position([
      ['black', 'rook', 4, 6], ['black', 'rook', 3, 8], ['black', 'rook', 5, 8],
    ], 'black'), side);
    const original = structuredClone(game);
    const from = perspectivePoint(side, 4, 6);
    const to = perspectivePoint(side, 4, 7);
    const move = applyMove(game, from, to);
    assert.equal(move.ok, true);
    const result = { winner: otherSide(side), loser: side, reason: 'checkmate' };
    assert.deepEqual(move.game.result, result);
    assert.deepEqual(getGameResult(move.game), result);
    assert.equal(isInCheck(move.game.board, side), true);
    const general = perspectivePoint(side, 4, 9);
    const rejected = applyMove(move.game, general, perspectivePoint(side, 3, 9));
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /棋局已经结束/);
    assert.deepEqual(legalMoves(move.game, general), []);
    assert.deepEqual(game, original);
    const reopened = undoMove(move.game);
    assert.deepEqual(reopened, original);
    assert.equal(reopened.result, null);
    assert.equal(applyMove(reopened, from, to).ok, true);
  });

  test(`${side} loses to stalemate without being in check`, () => {
    const game = fromRedPerspective(position([
      ['black', 'rook', 2, 8], ['black', 'rook', 5, 8],
    ], 'black'), side);
    const move = applyMove(game, perspectivePoint(side, 2, 8), perspectivePoint(side, 3, 8));
    assert.equal(move.ok, true);
    assert.equal(isInCheck(move.game.board, side), false);
    assert.deepEqual(move.game.result, { winner: otherSide(side), loser: side, reason: 'stalemate' });
    assert.deepEqual(getGameResult(move.game), move.game.result);
    assert.deepEqual(undoMove(move.game), game);
  });

  test(`${side} is not stalemated when its general is trapped but another piece can move`, () => {
    const game = fromRedPerspective(position([
      ['black', 'rook', 3, 8], ['black', 'rook', 5, 8], ['red', 'pawn', 0, 6],
    ]), side);
    assert.equal(isInCheck(game.board, side), false);
    assert.deepEqual(legalMoves(game, perspectivePoint(side, 4, 9)), []);
    assert.equal(getGameResult(game), null);
    const move = applyMove(game, perspectivePoint(side, 0, 6), perspectivePoint(side, 0, 5));
    assert.equal(move.ok, true);
    assert.equal(move.game.result, null);
  });

  test(`${side} wins when it captures the opposing general; undo restores the general`, () => {
    const game = fromRedPerspective(position([['red', 'rook', 5, 2]]), side);
    const from = perspectivePoint(side, 5, 2);
    const to = perspectivePoint(side, 5, 0);
    const move = applyMove(game, from, to);
    assert.equal(move.ok, true);
    const result = { winner: side, loser: otherSide(side), reason: 'general-captured' };
    assert.deepEqual(move.game.result, result);
    assert.deepEqual(getGameResult(move.game), result);
    assert.equal(move.game.history.at(-1).captured.type, 'general');
    assert.deepEqual(undoMove(move.game), game);
    assert.equal(applyMove(undoMove(move.game), from, to).ok, true);
  });
}
