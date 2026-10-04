import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyMove, createInitialGame, getGameResult, indexOf, isInCheck, legalMoves, otherSide, undoMove,
} from '../src/shared/rules.js';

const p = (x, y) => ({ x, y });
const draw = (reason) => ({ winner: null, loser: null, reason });
const types = { k: 'general', a: 'advisor', b: 'elephant', n: 'horse', r: 'rook', c: 'cannon', p: 'pawn' };
const examples = JSON.parse(readFileSync(new URL('./fixtures/adjudication-examples.json', import.meta.url), 'utf8'));

function fromFen(fen) {
  const [placement, turn] = fen.split(' ');
  const board = Array(90).fill(null);
  placement.split('/').forEach((rank, y) => {
    let x = 0;
    for (const character of rank) {
      if (/\d/.test(character)) x += Number(character);
      else board[indexOf(p(x++, y))] = {
        side: character === character.toUpperCase() ? 'red' : 'black', type: types[character.toLowerCase()],
      };
    }
    assert.equal(x, 9);
  });
  return { board, turn: turn === 'b' ? 'black' : 'red', history: [], result: null };
}

const uciPoint = (square) => p(square.charCodeAt(0) - 97, 9 - Number(square[1]));
const mirrorPoint = (point, mirrored) => mirrored ? p(point.x, 9 - point.y) : point;

function mirror(game, mirrored) {
  if (!mirrored) return game;
  const board = Array(90).fill(null);
  game.board.forEach((piece, i) => {
    if (piece) board[indexOf(p(i % 9, 9 - Math.floor(i / 9)))] = { ...piece, side: otherSide(piece.side) };
  });
  return { ...game, board, turn: otherSide(game.turn) };
}

function play(game, moves, mirrored = false) {
  for (const move of moves) {
    const from = mirrorPoint(uciPoint(move.slice(0, 2)), mirrored);
    const to = mirrorPoint(uciPoint(move.slice(2)), mirrored);
    const applied = applyMove(game, from, to);
    assert.equal(applied.ok, true, `${move}, ply ${game.history.length + 1}: ${applied.error}`);
    game = applied.game;
  }
  return game;
}

// Source: https://www.pikafish.com/rule.html, chapter 3, examples 1–39 (2026-10-04).
// The fixtures record factual FENs, move sequences, and expected adjudications.
for (const example of examples) for (const mirrored of [false, true]) {
  test(`Pikafish example ${example.number}, ${mirrored ? 'colors mirrored' : 'original colors'}: ${example.reason}`, () => {
    const initial = mirror(fromFen(example.fen), mirrored);
    const original = structuredClone(initial);
    const game = play(initial, example.moves, mirrored);
    const loser = example.loser && (mirrored ? otherSide(example.loser) : example.loser);
    const expected = loser
      ? { winner: otherSide(loser), loser, reason: example.reason }
      : draw(example.reason);
    assert.deepEqual(game.result, expected);
    assert.deepEqual(getGameResult(JSON.parse(JSON.stringify(game))), expected, 'JSON history retains piece identity');
    assert.deepEqual(initial, original, 'adjudication must not mutate its input');
    assert.deepEqual(Object.keys(game).sort(), ['board', 'history', 'result', 'turn']);
    const reopened = undoMove(JSON.parse(JSON.stringify(game)));
    assert.equal(reopened.result, null);
    assert.equal(getGameResult(reopened), null, 'one undo must remove the terminal repetition');
    assert.deepEqual(play(reopened, example.moves.slice(-1), mirrored).result, expected);
  });
}

const positionKey = (game) => `${game.turn}:${game.board.map((piece) => piece ? `${piece.side[0]}${piece.type}` : '-').join(',')}`;

// Walk legal positions without captures or checks and reject any third occurrence.
// This produces an actual game history, rather than fabricating clock metadata.
function quietMoves(game, plies, visits = new Map([[positionKey(game), 1]])) {
  for (let ply = 0; ply < plies; ply++) {
    const candidates = [];
    game.board.forEach((piece, i) => {
      if (piece?.side !== game.turn) return;
      const from = p(i % 9, Math.floor(i / 9));
      for (const to of legalMoves({ ...game, result: null }, from)) {
        if (game.board[indexOf(to)]) continue;
        const moved = applyMove({ ...game, result: null }, from, to);
        if (!moved.ok || isInCheck(moved.game.board, moved.game.turn)) continue;
        if (moved.game.result && moved.game.result.reason !== 'no-capture') continue;
        if ((visits.get(positionKey(moved.game)) ?? 0) >= 2) continue;
        candidates.push(moved.game);
      }
    });
    assert.ok(candidates.length, `quiet continuation must exist at ply ${game.history.length}`);
    game = candidates[(ply * 17 + 3) % candidates.length];
    const key = positionKey(game);
    visits.set(key, (visits.get(key) ?? 0) + 1);
  }
  return { game, visits };
}

function visitsFromHistory(game) {
  const visits = new Map();
  for (;;) {
    const key = positionKey(game);
    visits.set(key, (visits.get(key) ?? 0) + 1);
    if (!game.history.length) return visits;
    game = undoMove(game);
  }
}

// Build and replay legal, noncapturing predecessors ending at a chosen fixture.
// Horses supply reversible moves while the tactical pieces keep their positions.
function quietPrelude(target, plies) {
  const targetKey = positionKey(target);
  const visits = new Map([[targetKey, 1]]);
  const moves = [];
  let current = target;
  for (let ply = 0; ply < plies; ply++) {
    const candidates = [];
    const side = otherSide(current.turn);
    current.board.forEach((piece, i) => {
      if (piece?.side !== side || piece.type !== 'horse') return;
      const to = p(i % 9, Math.floor(i / 9));
      for (const from of legalMoves({ ...current, turn: side, result: null }, to)) {
        if (current.board[indexOf(from)]) continue;
        const board = current.board.slice();
        board[indexOf(from)] = piece;
        board[indexOf(to)] = null;
        const previous = { board, turn: side, history: [], result: null };
        if (isInCheck(board, 'red') || isInCheck(board, 'black')) continue;
        const forward = applyMove(previous, from, to);
        if (!forward.ok || forward.game.result) continue;
        const key = positionKey(previous);
        if (key === targetKey || (visits.get(key) ?? 0) >= 2) continue;
        candidates.push({ previous, move: { from, to } });
      }
    });
    assert.ok(candidates.length, `a quiet predecessor exists at reverse ply ${ply}`);
    const chosen = candidates[(ply * 17 + 3) % candidates.length];
    current = chosen.previous;
    moves.push(chosen.move);
    const key = positionKey(current);
    visits.set(key, (visits.get(key) ?? 0) + 1);
  }
  for (const { from, to } of moves.reverse()) {
    const applied = applyMove(current, from, to);
    assert.equal(applied.ok, true, applied.error);
    current = applied.game;
    assert.equal(current.result, null, 'the entire prelude is playable');
  }
  assert.deepEqual(current.board, target.board);
  assert.equal(current.turn, target.turn);
  return current;
}

test('same-type pieces may exchange positions: layout repetition counts, but the chased entity must stay the same', () => {
  const initial = fromFen('5k3/9/9/3n5/1R7/3n5/9/9/9/4K4 w');
  const firstHorse = initial.board[indexOf(p(3, 3))];
  const secondHorse = initial.board[indexOf(p(3, 5))];
  const exchange = ['b5d5', 'd6b5', 'd5d7', 'd4f5', 'd7b7', 'b5d4', 'b7b5', 'f5d6'];
  const swapped = play(initial, exchange);
  assert.equal(positionKey(swapped), positionKey(initial));
  assert.equal(swapped.board[indexOf(p(3, 3))], secondHorse);
  assert.equal(swapped.board[indexOf(p(3, 5))], firstHorse);
  assert.equal(swapped.result, null);
  const drawn = play(JSON.parse(JSON.stringify(swapped)), exchange);
  assert.deepEqual(drawn.result, draw('repetition'), 'chasing alternating horses is an allowed cycle');
});

test('an opening reached from the standard setup draws on the third position, including the initial position', () => {
  const game = play(createInitialGame(), ['b0c2', 'b9c7', 'c2b0', 'c7b9']);
  assert.equal(game.result, null, 'the second occurrence remains playable');
  const drawn = play(game, ['b0c2', 'b9c7', 'c2b0', 'c7b9']);
  assert.deepEqual(drawn.result, draw('repetition'));
  assert.deepEqual(undoMove(drawn), play(game, ['b0c2', 'b9c7', 'c2b0']));
  assert.equal(applyMove(drawn, p(0, 6), p(0, 5)).ok, false);
});

test('120 noncapturing plies draw; moving pawns does not restart the count', () => {
  const before = quietMoves(createInitialGame(), 119);
  assert.equal(before.game.result, null);
  assert.ok(before.game.history.some((move) => move.piece.type === 'pawn'), 'the sequence includes pawn moves');
  const after = quietMoves(before.game, 1, before.visits).game;
  assert.deepEqual(after.result, draw('no-capture'));
  assert.deepEqual(getGameResult(JSON.parse(JSON.stringify(after))), after.result);
  assert.deepEqual(undoMove(after), before.game);
});

test('a capture restarts the noncapture count even after 119 previous quiet plies', () => {
  const before = quietMoves(createInitialGame(), 119).game;
  let captured;
  before.board.forEach((piece, i) => {
    if (captured || piece?.side !== before.turn) return;
    const from = p(i % 9, Math.floor(i / 9));
    for (const to of legalMoves(before, from)) {
      if (!before.board[indexOf(to)]) continue;
      const applied = applyMove(before, from, to);
      if (applied.ok && !applied.game.result && !isInCheck(applied.game.board, applied.game.turn)) {
        captured = applied.game;
        break;
      }
    }
  });
  assert.ok(captured, 'the legal fixture must have a nonterminal capture');
  assert.ok(captured.history.at(-1).captured);
  assert.equal(captured.result, null);
  assert.deepEqual(undoMove(captured), before);
  const after119 = quietMoves(captured, 119, visitsFromHistory(captured));
  assert.equal(after119.game.result, null);
  assert.deepEqual(quietMoves(after119.game, 1, after119.visits).game.result, draw('no-capture'));
});

test('checks above ten per side and their responses do not count toward the 120-ply limit', () => {
  const initial = fromFen('3k5/2R6/9/9/9/9/9/9/6r2/4K1N2 w');
  let game = initial;
  const checkCycle = ['c8c9', 'd9d8', 'c9c8', 'd8d9'];
  const separators = [
    ['g0i1', 'g1f1'], ['i1g2', 'f1g1'], ['g2i3', 'g1g2'],
    ['i3g4', 'g2g3'], ['g4i5', 'g3g4'], ['i5g6', 'g4g5'],
  ];
  for (const separator of separators) {
    game = play(game, checkCycle);
    game = play(game, separator);
    assert.equal(game.result, null, 'each checking cycle has distinct horse/rook positions');
  }
  assert.equal(game.history.length, 36);
  let checkCount = 0;
  for (let replay = game; replay.history.length; replay = undoMove(replay)) {
    if (replay.history.at(-1).piece.side === 'red' && isInCheck(replay.board, 'black')) checkCount++;
  }
  assert.equal(checkCount, 12, 'two checks and their two responses are discounted');
  const before = quietMoves(game, 87, visitsFromHistory(game));
  assert.equal(before.game.history.length, 123);
  assert.equal(before.game.result, null, '123 raw plies include only 119 counted plies');
  const after = quietMoves(before.game, 1, before.visits).game;
  assert.equal(after.history.length, 124);
  assert.deepEqual(after.result, draw('no-capture'));
  assert.deepEqual(undoMove(after), before.game);
});

test('checkmate on the 120th noncapturing ply takes priority over the natural draw', () => {
  const target = fromFen('5k2n/9/9/9/9/9/9/2r6/3r1r3/N3K4 b');
  const before = quietPrelude(target, 119);
  const mated = play(before, ['c2e2']);
  assert.equal(mated.history.length, 120);
  assert.deepEqual(mated.result, { winner: 'black', loser: 'red', reason: 'checkmate' });
  assert.deepEqual(undoMove(mated), before);
});

test('a third repetition on the 120th noncapturing ply takes priority over the natural draw', () => {
  const target = fromFen('n2k4n/2R6/9/9/9/9/9/9/6r2/4K1N2 w');
  const before = quietPrelude(target, 112);
  const repeated = play(before, ['c8c9', 'd9d8', 'c9c8', 'd8d9', 'c8c9', 'd9d8', 'c9c8', 'd8d9']);
  assert.equal(repeated.history.length, 120);
  assert.deepEqual(repeated.result, { winner: 'black', loser: 'red', reason: 'perpetual-check' });
  assert.equal(getGameResult(undoMove(repeated)), null);
});

test('both sides retaining only generals, advisors and elephants draw', () => {
  for (const fen of ['4k4/9/9/9/9/9/9/9/9/3K5 w', '2bak4/4a4/4b4/9/9/9/9/4B4/4A4/3K1AB2 b']) {
    assert.deepEqual(getGameResult(fromFen(fen)), draw('insufficient-material'));
  }
  for (const piece of ['R', 'N', 'C', 'P']) {
    assert.equal(getGameResult(fromFen(`4k4/9/9/9/9/1${piece}7/9/9/9/3K5 w`)), null, piece);
  }
});

test('capturing the last attacking piece triggers the defensive-material draw and undo restores exact state', () => {
  const initial = fromFen('5k3/9/9/9/9/9/9/4r4/9/2B1K4 w');
  const original = structuredClone(initial);
  const game = play(initial, ['c0e2']);
  assert.equal(game.history.at(-1).captured.type, 'rook');
  assert.deepEqual(game.result, draw('insufficient-material'));
  assert.deepEqual(undoMove(game), original);
});
