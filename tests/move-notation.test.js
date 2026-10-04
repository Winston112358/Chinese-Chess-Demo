import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialGame, legalMoves, applyMove, validateMove } from '../src/shared/rules.js';
import { chineseMoveNotation } from '../web/move-notation.js';

const point = (x, y) => ({ x, y });
const move = (x, y, tx, ty) => ({ from: point(x, y), to: point(tx, ty) });

test('every legal initial horse jump records the destination file, never its vertical distance', () => {
  for (const [side, coordinates, expected] of [
    ['red', [1, 9, 0, 7], '马八进九'],
    ['red', [1, 9, 2, 7], '马八进七'],
    ['red', [7, 9, 6, 7], '马二进三'],
    ['red', [7, 9, 8, 7], '马二进一'],
    ['black', [1, 0, 0, 2], '马2进1'],
    ['black', [1, 0, 2, 2], '马2进3'],
    ['black', [7, 0, 6, 2], '马8进7'],
    ['black', [7, 0, 8, 2], '马8进9'],
  ]) {
    const game = createInitialGame();
    game.turn = side;
    const candidate = move(...coordinates);
    assert.equal(validateMove(game, candidate.from, candidate.to).ok, true);
    assert.equal(chineseMoveNotation(game, candidate), expected);
  }
  const game = createInitialGame();
  const initialEighthHorse = legalMoves(game, point(1, 9));
  assert.deepEqual(initialEighthHorse.map(to => chineseMoveNotation(game, {from: point(1, 9), to})).sort(),
    ['马八进七', '马八进九']);
  for (const tx of [8, 7]) {
    assert.equal(validateMove(game, point(1, 9), point(tx, 8)).ok, false,
      'The reported 马八进一/二 cannot describe a legal jump of the initial eighth-file horse');
  }
});

test('all 1016 in-board horse jumps have the correct origin, destination and advance/retreat', (t) => {
  const labels = { red: [...'九八七六五四三二一'], black: [...'123456789'] };
  const jumps = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  let count = 0;
  for (const side of ['red', 'black']) {
    for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
      const game = { board: Array(90).fill(null) };
      game.board[y * 9 + x] = {side, type: 'horse'};
      for (const [dx, dy] of jumps) {
        const tx = x + dx, ty = y + dy;
        if (tx < 0 || tx > 8 || ty < 0 || ty > 9) continue;
        const direction = (side === 'red' ? dy < 0 : dy > 0) ? '进' : '退';
        const expected = `马${labels[side][x]}${direction}${labels[side][tx]}`;
        assert.equal(chineseMoveNotation(game, move(x, y, tx, ty)), expected,
          `${side} (${x},${y}) -> (${tx},${ty})`);
        count++;
      }
    }
  }
  assert.equal(count, 1016);
  t.diagnostic(`Verified ${count} horse jumps across both sides and every board edge.`);
});

test('a complete opening uses standard red/black digits and four-character destination notation', () => {
  // Normal opening fixtures expressed as absolute board intersections.
  const opening = [
    [7,9,6,7,'马二进三'], [6,3,6,4,'卒7进1'],
    [1,9,0,7,'马八进九'], [7,0,6,2,'马8进7'],
    [0,9,0,8,'车九进一'], [1,0,2,2,'马2进3'],
    [0,8,5,8,'车九平四'], [2,0,4,2,'象3进5'],
    [5,8,5,5,'车四进三'], [2,3,2,4,'卒3进1'],
    [1,7,3,7,'炮八平六'], [0,0,1,0,'车1平2'],
  ];
  let game = createInitialGame();
  for (const [x, y, tx, ty, expected] of opening) {
    const candidate = move(x, y, tx, ty);
    assert.equal(chineseMoveNotation(game, candidate), expected);
    const applied = applyMove(game, candidate.from, candidate.to);
    assert.equal(applied.ok, true, expected);
    game = applied.game;
  }
});

test('notation stays unambiguous for every legal move in hundreds of varied reachable positions', (t) => {
  let seed = 0x5311016;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  let positions = 0, records = 0;
  const types = new Set();
  for (let variation = 0; variation < 8; variation++) {
    let game = createInitialGame();
    for (let ply = 0; ply < 60 && !game.result; ply++) {
      const before = JSON.stringify(game);
      const names = new Map(), candidates = [];
      for (let index = 0; index < game.board.length; index++) {
        const piece = game.board[index];
        if (piece?.side !== game.turn) continue;
        const from = point(index % 9, Math.floor(index / 9));
        for (const to of legalMoves(game, from)) {
          const candidate = {from, to};
          const text = chineseMoveNotation(game, candidate);
          assert.equal([...text].length, 4, text);
          assert.match(text, game.turn === 'red'
            ? /^[帅仕相马车炮兵前中后一二三四五][一二三四五六七八九帅仕相马车炮兵][进退平][一二三四五六七八九]$/
            : /^[将士象马车炮卒前中后一二三四五][1-9将士象马车炮卒][进退平][1-9]$/, text);
          assert.equal(names.has(text), false,
            `Ambiguous ${game.turn} notation ${text} in variation ${variation}, ply ${ply}: ${JSON.stringify(names.get(text))} vs ${JSON.stringify(candidate)}`);
          names.set(text, candidate);
          candidates.push(candidate);
          types.add(piece.type);
          records++;
        }
      }
      assert.equal(JSON.stringify(game), before, 'Formatting must preserve the pre-move position');
      positions++;
      if (!candidates.length) break;
      const selected = candidates[random() % candidates.length];
      const applied = applyMove(game, selected.from, selected.to);
      assert.equal(applied.ok, true);
      game = applied.game;
    }
  }
  assert.ok(positions >= 300, `${positions} tested positions`);
  assert.deepEqual([...types].sort(), ['advisor','cannon','elephant','general','horse','pawn','rook']);
  t.diagnostic(`Verified ${records} legal notation records across ${positions} reachable positions, all seven piece types and both sides.`);
});
