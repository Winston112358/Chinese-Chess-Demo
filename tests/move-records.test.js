import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMove, createInitialGame, undoMove } from '../src/shared/rules.js';
import { chineseMoveNotation } from '../web/move-notation.js';
import { formatMoveRecord, getMoveRecords } from '../web/move-records.js';

const point = (x, y) => ({ x, y });
const candidate = (x, y, tx, ty) => ({ from: point(x, y), to: point(tx, ty) });
const play = (game, x, y, tx, ty) => {
  const result = applyMove(game, point(x, y), point(tx, ty));
  assert.equal(result.ok, true, result.error);
  return result.game;
};
const position = (side, type, points) => {
  const board = Array(90).fill(null);
  for (const [x, y] of points) board[y * 9 + x] = { side, type };
  return { board, turn: side, history: [], result: null };
};

test('records preserve adopted coordinates and capture names while reconstructing pre-move notation', () => {
  let game = createInitialGame();
  const expected = [];
  for (const coordinates of [[7, 9, 6, 7], [7, 0, 6, 2], [4, 6, 4, 5], [4, 3, 4, 4], [4, 5, 4, 4]]) {
    const move = candidate(...coordinates);
    expected.push(chineseMoveNotation(game, move));
    game = play(game, ...coordinates);
  }
  const original = structuredClone(game);
  const records = getMoveRecords(game);
  assert.deepEqual(records.map(({ notation }) => notation), expected);
  assert.deepEqual(records.map(({ ply, side }) => [ply, side]), [[1, 'red'], [2, 'black'], [3, 'red'], [4, 'black'], [5, 'red']]);
  assert.equal(records[0].text, '红方 马二进三 · (8,10) → (7,8)');
  assert.equal(records[1].text, '黑方 马8进7 · (8,1) → (7,3)');
  assert.equal(records[4].capture, '吃黑方卒');
  assert.equal(records[4].text, '红方 兵五进一 · (5,6) → (5,5) 吃黑方卒');
  assert.deepEqual(game, original, 'Generating records cannot modify pieces, board, history or result');
});

test('undo followed by another branch records only the ultimately adopted moves', () => {
  let game = play(createInitialGame(), 7, 9, 6, 7);
  game = play(game, 7, 0, 6, 2);
  game = play(game, 7, 7, 7, 6);
  game = undoMove(game);
  game = play(game, 6, 6, 6, 5);
  assert.deepEqual(getMoveRecords(game).map(({ notation }) => notation), ['马二进三', '马8进7', '兵三进一']);
  assert.equal(getMoveRecords(game).length, 3);
  assert.deepEqual(getMoveRecords(createInitialGame()), []);
});

test('sandbox records start at the supplied arbitrary baseline and survive captures and external terminal results', () => {
  let game = position('red', 'rook', [[8, 5], [8, 7]]);
  game.board[9 * 9 + 4] = { side: 'red', type: 'general' };
  game.board[0 * 9 + 3] = { side: 'black', type: 'general' };
  game.board[5 * 9 + 5] = { side: 'black', type: 'horse' };
  game = play(game, 8, 5, 5, 5);
  game.result = { winner: 'black', reason: 'resign' };
  assert.deepEqual(getMoveRecords(game), [{
    ply: 1, side: 'red', notation: '前车平四',
    coordinates: '(9,6) → (6,6)', capture: '吃黑方马',
    text: '红方 前车平四 · (9,6) → (6,6) 吃黑方马',
  }]);
});

test('same-file rooks, horses and cannons use front/back from each player perspective', () => {
  for (const [type, name, dx, dy] of [['rook', '车', 1, 0], ['horse', '马', 1, -2], ['cannon', '炮', 1, 0]]) {
    for (const side of ['red', 'black']) {
      const game = position(side, type, [[4, 3], [4, 6]]);
      const frontY = side === 'red' ? 3 : 6;
      const backY = side === 'red' ? 6 : 3;
      const target = side === 'red' ? '四' : '6';
      const action = dy ? '进' : '平';
      const step = side === 'red' ? dy : -dy;
      assert.equal(chineseMoveNotation(game, candidate(4, frontY, 4 + dx, frontY + step)), `前${name}${action}${target}`);
      assert.equal(chineseMoveNotation(game, candidate(4, backY, 4 + dx, backY + step)), `后${name}${action}${target}`);
    }
  }
});

test('advisors and elephants on one file retain their file number instead of front/back', () => {
  assert.equal(chineseMoveNotation(position('red', 'advisor', [[4, 7], [4, 9]]), candidate(4, 9, 3, 8)), '仕五进六');
  assert.equal(chineseMoveNotation(position('black', 'advisor', [[4, 0], [4, 2]]), candidate(4, 2, 3, 1)), '士5退4');
  assert.equal(chineseMoveNotation(position('red', 'elephant', [[4, 5], [4, 9]]), candidate(4, 5, 2, 7)), '相五退七');
  assert.equal(chineseMoveNotation(position('black', 'elephant', [[4, 0], [4, 4]]), candidate(4, 0, 6, 2)), '象5进7');
});

test('two and three crowded pawns use front/middle/back while four and five use positional ordinals', () => {
  for (const side of ['red', 'black']) {
    const pawn = side === 'red' ? '兵' : '卒';
    const target = side === 'red' ? '四' : '6';
    for (const count of [2, 3, 4, 5]) {
      const rows = Array.from({ length: count }, (_, index) => side === 'red' ? index : 9 - index);
      const game = position(side, 'pawn', rows.map(y => [4, y]));
      const prefixes = count === 2 ? ['前', '后'] : count === 3 ? ['前', '中', '后'] : [...'一二三四五'].slice(0, count);
      rows.forEach((y, index) => assert.equal(chineseMoveNotation(game, candidate(4, y, 5, y)), `${prefixes[index]}${pawn}平${target}`));
    }
  }
});

test('multiple crowded pawn files are numbered from own right, front to back, excluding isolated pawns', () => {
  const red = position('red', 'pawn', [[5, 1], [5, 3], [4, 2], [3, 1], [3, 3]]);
  assert.deepEqual([[5, 1], [5, 3], [3, 1], [3, 3]].map(([x, y]) => chineseMoveNotation(red, candidate(x, y, 4, y))),
    ['一兵平五', '二兵平五', '三兵平五', '四兵平五']);
  assert.equal(chineseMoveNotation(red, candidate(4, 2, 4, 1)), '兵五进一');
  const black = position('black', 'pawn', [[3, 8], [3, 6], [4, 7], [5, 8], [5, 6]]);
  assert.deepEqual([[3, 8], [3, 6], [5, 8], [5, 6]].map(([x, y]) => chineseMoveNotation(black, candidate(x, y, 4, y))),
    ['一卒平5', '二卒平5', '三卒平5', '四卒平5']);
  assert.equal(chineseMoveNotation(black, candidate(4, 7, 4, 8)), '卒5进1');
});

test('single-record formatting retains canonical black captured cannon glyph', () => {
  const game = position('red', 'rook', [[8, 5]]);
  const move = { ...candidate(8, 5, 3, 5), piece: game.board[5 * 9 + 8], captured: { side: 'black', type: 'cannon' } };
  assert.equal(formatMoveRecord(game, move, 6).text, '红方 车一平六 · (9,6) → (4,6) 吃黑方砲');
});
