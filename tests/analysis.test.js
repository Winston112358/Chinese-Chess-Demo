import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialGame, indexOf, otherSide, pieceAt, validateMove, applyMove } from '../src/shared/rules.js';
import { dangerousPieces } from '../src/shared/analysis.js';

const p = (x, y) => ({ x, y });
function position(pieces = [], turn = 'red') {
  const game = { board: Array(90).fill(null), turn, history: [], result: null };
  for (const [side, type, x, y] of [['red', 'general', 4, 9], ['black', 'general', 5, 0], ...pieces]) {
    game.board[indexOf(p(x, y))] = { side, type };
  }
  return game;
}
const includes = (points, point) => points.some((candidate) => indexOf(candidate) === indexOf(point));
function bruteDangerousPieces(game, side) {
  const opponent = { ...game, turn: otherSide(side), result: null };
  const targets = new Set();
  game.board.forEach((piece, index) => {
    if (piece?.side !== opponent.turn) return;
    const from = p(index % 9, Math.floor(index / 9));
    for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
      const to = p(x, y);
      if (validateMove(opponent, from, to).ok && pieceAt(game.board, to)?.side === side) targets.add(indexOf(to));
    }
  });
  return [...targets].sort((a, b) => a - b).map((index) => p(index % 9, Math.floor(index / 9)));
}

test('cannon danger requires exactly one screen, regardless of the screen color', () => {
  const game = position([['black', 'cannon', 0, 2], ['red', 'rook', 0, 8]]);
  assert.equal(includes(dangerousPieces(game, 'red'), p(0, 8)), false);
  for (const color of ['red', 'black']) {
    game.board[indexOf(p(0, 5))] = { side: color, type: 'pawn' };
    assert.equal(includes(dangerousPieces(game, 'red'), p(0, 8)), true);
  }
  game.board[indexOf(p(0, 6))] = { side: 'red', type: 'pawn' };
  assert.equal(includes(dangerousPieces(game, 'red'), p(0, 8)), false);
  assert.equal(includes(dangerousPieces(game, 'red'), p(0, 6)), true);
});

test('horse danger respects the separate horizontal and vertical legs', () => {
  const game = position([
    ['black', 'horse', 3, 4], ['red', 'pawn', 5, 5], ['red', 'cannon', 4, 6],
  ]);
  assert.equal(includes(dangerousPieces(game, 'red'), p(5, 5)), true);
  assert.equal(includes(dangerousPieces(game, 'red'), p(4, 6)), true);
  game.board[indexOf(p(4, 4))] = { side: 'black', type: 'pawn' };
  assert.equal(includes(dangerousPieces(game, 'red'), p(5, 5)), false);
  assert.equal(includes(dangerousPieces(game, 'red'), p(4, 6)), true);
  game.board[indexOf(p(3, 5))] = { side: 'red', type: 'pawn' };
  assert.equal(includes(dangerousPieces(game, 'red'), p(4, 6)), false);
});

test('a pinned enemy cannot capture sideways but can capture the piece pinning it', () => {
  const game = position([
    ['black', 'rook', 5, 2], ['red', 'rook', 5, 7], ['red', 'pawn', 3, 2],
  ]);
  let danger = dangerousPieces(game, 'red');
  assert.equal(includes(danger, p(3, 2)), false);
  assert.equal(includes(danger, p(5, 7)), true);
  game.board[indexOf(p(5, 7))] = null;
  danger = dangerousPieces(game, 'red');
  assert.equal(includes(danger, p(3, 2)), true);
});

for (const attackingSide of ['red', 'black']) {
  test(`${attackingSide} pawn danger changes at the river, never points backward, and stays inside the board`, () => {
    const targetSide = otherSide(attackingSide);
    const before = attackingSide === 'red' ? 5 : 4;
    const forward = attackingSide === 'red' ? -1 : 1;
    for (const y of [before, before + forward]) {
      const game = position([
        [attackingSide, 'pawn', 0, y], [targetSide, 'rook', 1, y],
        [targetSide, 'pawn', 0, y + forward], [targetSide, 'horse', 0, y - forward],
      ]);
      const danger = dangerousPieces(game, targetSide);
      assert.equal(includes(danger, p(0, y + forward)), true);
      assert.equal(includes(danger, p(1, y)), y !== before);
      assert.equal(includes(danger, p(0, y - forward)), false);
    }
    const lastRank = attackingSide === 'red' ? 0 : 9;
    const edge = position([
      [attackingSide, 'pawn', 0, lastRank], [targetSide, 'rook', 1, lastRank],
      [targetSide, 'horse', 0, lastRank - forward],
    ]);
    const danger = dangerousPieces(edge, targetSide);
    assert.equal(includes(danger, p(1, lastRank)), true);
    assert.equal(includes(danger, p(0, lastRank - forward)), false);
    assert.ok(danger.every(({ x, y }) => x >= 0 && x < 9 && y >= 0 && y < 10));
  });
}

test('multiple attackers report a threatened piece once and never report empty or enemy squares', () => {
  const game = position([
    ['black', 'rook', 0, 5], ['black', 'rook', 5, 2], ['red', 'pawn', 5, 5],
  ]);
  assert.deepEqual(dangerousPieces(game, 'red'), [p(5, 5)]);
});

test('analysis uses the enemy turn, ignores a saved result, and leaves the real game untouched', () => {
  const game = position([['black', 'rook', 0, 5], ['red', 'pawn', 5, 5]], 'red');
  game.result = { winner: 'red', loser: 'black', reason: 'timeout' };
  const original = structuredClone(game);
  const danger = dangerousPieces(game, 'red');
  assert.deepEqual(danger, [p(5, 5)]);
  assert.deepEqual(game, original);
  danger[0].x = 8;
  assert.deepEqual(dangerousPieces(game, 'red'), [p(5, 5)]);
});

test('dangerous pieces match full-board move validation on openings, pins, blockers, and endgames', () => {
  let opening = createInitialGame();
  for (const [from, to] of [[p(4, 6), p(4, 5)], [p(4, 3), p(4, 4)], [p(1, 7), p(4, 7)]]) {
    const result = applyMove(opening, from, to);
    assert.equal(result.ok, true, result.error);
    opening = result.game;
  }
  const fixtures = [
    createInitialGame(), opening,
    position([
      ['black', 'cannon', 0, 2], ['red', 'pawn', 0, 5], ['red', 'rook', 0, 8],
      ['black', 'horse', 3, 4], ['red', 'cannon', 4, 6], ['red', 'rook', 5, 5],
    ]),
    position([
      ['black', 'rook', 5, 2], ['red', 'rook', 5, 7], ['red', 'pawn', 3, 2],
      ['red', 'pawn', 0, 0], ['black', 'pawn', 8, 5],
    ]),
    position([
      ['black', 'rook', 4, 7], ['black', 'rook', 3, 8], ['black', 'rook', 5, 8],
    ]),
  ];
  for (const [index, game] of fixtures.entries()) for (const side of ['red', 'black']) {
    assert.deepEqual(dangerousPieces(game, side), bruteDangerousPieces(game, side), `fixture ${index}, ${side}`);
  }
});
