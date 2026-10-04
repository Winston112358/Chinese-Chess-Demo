import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPikafish, resolvePikafishPath } from '../src/server/pikafish.js';
import { applyMove, createInitialGame, legalMoves, validateMove } from '../src/shared/rules.js';
import { chineseMoveNotation } from '../web/move-notation.js';

// This parser reads notation backwards into coordinates. It never calls the formatter.
const digits = new Map([...Array.from('〇一二三四五六七八九').map((c, i) => [c, i]),
  ...Array.from('0123456789').map((c, i) => [c, i])]);
const roles = new Map([
  ['帅', 'general'], ['将', 'general'], ['仕', 'advisor'], ['士', 'advisor'],
  ['相', 'elephant'], ['象', 'elephant'], ['马', 'horse'], ['车', 'rook'],
  ['炮', 'cannon'], ['砲', 'cannon'], ['兵', 'pawn'], ['卒', 'pawn'],
]);
const point = (index) => ({ x: index % 9, y: Math.floor(index / 9) });
const sameMove = (a, b) => a.from.x === b.from.x && a.from.y === b.from.y
  && a.to.x === b.to.x && a.to.y === b.to.y;

function decodeNotation(game, notation) {
  const [first, second, action, last] = Array.from(notation);
  assert.equal(Array.from(notation).length, 4, `Not four characters: ${notation}`);
  assert.ok(['进', '退', '平'].includes(action), `Unknown action: ${notation}`);
  const amount = digits.get(last);
  assert.ok(amount >= 1 && amount <= 9, `Invalid destination: ${notation}`);
  const side = game.turn;
  assert.match(last, side === 'red' ? /^[一二三四五六七八九]$/ : /^[1-9]$/,
    `Destination numeral does not match side: ${notation}`);
  const type = roles.get(first) ?? roles.get(second);
  assert.ok(type, `Unknown role: ${notation}`);
  const origins = game.board.flatMap((piece, index) => piece?.side === side && piece.type === type
    ? [point(index)] : []);
  const frontKey = (p) => side === 'red' ? p.y : -p.y;
  const rightKey = (p) => side === 'red' ? -p.x : p.x;
  let candidates;
  if (roles.has(first)) {
    const file = digits.get(second);
    assert.ok(file >= 1 && file <= 9, `Invalid source file: ${notation}`);
    const x = side === 'red' ? 9 - file : file - 1;
    candidates = origins.filter((p) => p.x === x);
  } else if (['前', '中', '后'].includes(first)) {
    candidates = origins.filter((p) => {
      const file = origins.filter((q) => q.x === p.x).sort((a, b) => frontKey(a) - frontKey(b));
      if (file.length < 2) return false;
      const rank = file.findIndex((q) => q.y === p.y);
      return first === '前' ? rank === 0 : first === '后' ? rank === file.length - 1
        : file.length === 3 && rank === 1;
    });
  } else {
    assert.equal(type, 'pawn', `Ordinal prefix on a non-pawn: ${notation}`);
    const rank = digits.get(first);
    assert.ok(rank >= 1, `Invalid pawn ordinal: ${notation}`);
    // Independently scan crowded files in player-right order, then front-to-back.
    const crowded = origins.filter((p) => origins.filter((q) => q.x === p.x).length > 1)
      .sort((a, b) => rightKey(a) - rightKey(b) || frontKey(a) - frontKey(b));
    candidates = crowded[rank - 1] ? [crowded[rank - 1]] : [];
  }
  const decoded = candidates.flatMap((from) => {
    let to;
    const targetX = side === 'red' ? 9 - amount : amount - 1;
    if (action === '平') to = { x: targetX, y: from.y };
    else {
      const sign = (side === 'red' ? -1 : 1) * (action === '进' ? 1 : -1);
      if (['horse', 'advisor', 'elephant'].includes(type)) {
        const dx = Math.abs(targetX - from.x);
        const dy = type === 'horse' && [1, 2].includes(dx) ? 3 - dx
          : type === 'advisor' && dx === 1 ? 1 : type === 'elephant' && dx === 2 ? 2 : 0;
        if (!dy) return [];
        to = { x: targetX, y: from.y + sign * dy };
      } else to = { x: from.x, y: from.y + sign * amount };
    }
    return validateMove(game, from, to).ok ? [{ from, to }] : [];
  });
  assert.equal(decoded.length, 1, `Notation is not uniquely decodable: ${notation} (${decoded.length} candidates)`);
  return decoded[0];
}

function mutationCheck(game, notation, original) {
  const chars = Array.from(notation);
  const number = digits.get(chars[3]);
  const changed = number === 9 ? 1 : number + 1;
  const suffix = game.turn === 'red' ? Array.from('〇一二三四五六七八九')[changed] : String(changed);
  const mutations = [chars.slice(0, 3).join('') + suffix,
    chars.slice(0, 2).join('') + (chars[2] === '进' ? '退' : '进') + chars[3]];
  return mutations.map((mutated) => {
    let decoded;
    try { decoded = decodeNotation(game, mutated); }
    catch { return { notation: mutated, rejected: true }; }
    assert.ok(!sameMove(decoded, original), `Changed notation still represents original move: ${mutated}`);
    return { notation: mutated, rejected: false, differentMove: decoded };
  });
}

const move = (x, y, tx, ty) => ({ from: { x, y }, to: { x: tx, y: ty } });
function crowdedPawns(side) {
  const start = side === 'red' ? 6 : 3;
  const front = side === 'red' ? 4 : 5;
  const middle = side === 'red' ? 5 : 4;
  const pawnSteps = [move(0, start, 0, middle), move(0, middle, 0, front),
    move(0, front, 1, front), move(1, front, 2, front), move(2, start, 2, middle),
    move(6, start, 6, middle), move(6, middle, 6, front), move(6, front, 5, front),
    move(5, front, 4, front), move(4, start, 4, middle)];
  const waitY = side === 'red' ? 2 : 7;
  let waitX = 1;
  const wait = () => {
    const result = move(waitX, waitY, waitX === 1 ? 2 : 1, waitY);
    waitX = result.to.x;
    return result;
  };
  const history = [];
  for (const pawn of pawnSteps) history.push(...(side === 'red' ? [pawn, wait()] : [wait(), pawn]));
  if (side === 'black') history.push(wait());
  return history;
}

const seeds = [
  ['initial', []],
  ['center-cannons', [move(1, 7, 4, 7), move(1, 2, 4, 2)]],
  ['developed-horses', [move(1, 9, 2, 7), move(1, 0, 2, 2)]],
  ['open-rook-lanes', [move(7, 9, 6, 7), move(7, 0, 6, 2), move(8, 9, 7, 9), move(8, 0, 7, 0)]],
  ['advanced-pawns', [move(2, 6, 2, 5), move(2, 3, 2, 4)]],
  ['elephant-defense', [move(2, 9, 4, 7), move(2, 0, 4, 2)]],
  ['advisor-defense', [move(5, 9, 4, 8), move(5, 0, 4, 1)]],
  ['crowded-black-pawns', crowdedPawns('black')],
  ['crowded-red-pawns', crowdedPawns('red')],
];

function replay(history) {
  let game = createInitialGame();
  for (const step of history) {
    const result = applyMove(game, step.from, step.to);
    assert.ok(result.ok, `Seed move is illegal: ${JSON.stringify(step)} ${result.error ?? ''}`);
    game = result.game;
  }
  assert.ok(!game.result, 'Seed game is already over');
  return game;
}

function selfCheckDecoder() {
  const red = createInitialGame();
  const black = replay([move(4, 6, 4, 5)]);
  for (const [game, notation, expected] of [
    [red, '马八进七', move(1, 9, 2, 7)], [red, '炮二平五', move(7, 7, 4, 7)],
    [red, '兵七进一', move(2, 6, 2, 5)], [red, '车九进一', move(0, 9, 0, 8)],
    [black, '马2进3', move(1, 0, 2, 2)], [black, '炮8平5', move(7, 2, 4, 2)],
    [black, '卒5进1', move(4, 3, 4, 4)], [black, '车1进1', move(0, 0, 0, 1)],
    [replay(crowdedPawns('black')), '三卒进1', move(4, 5, 4, 6)],
    [replay(crowdedPawns('red')), '三兵进一', move(2, 4, 2, 3)],
  ]) assert.ok(sameMove(decodeNotation(game, notation), expected), `Decoder self-check failed: ${notation}`);
  for (const [, history] of seeds) replay(history);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = resolve(root, 'artifacts/ai-notation-v053/live-engine-verification.json');
const notationPath = resolve(root, 'web/move-notation.js');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const toUci = (p) => `${String.fromCharCode(97 + p.x)}${9 - p.y}`;

async function main() {
  selfCheckDecoder();
  if (process.argv.includes('--preflight')) {
    console.log('Independent decoder self-check passed, including both sides and 三卒/三兵 ordinals. All 9 seed histories are legal.');
    return;
  }
  const notationHash = sha256(await readFile(notationPath));
  const engine = createPikafish({ moveTimeMs: 1000, maxConcurrent: 1 });
  const report = {
    startedAt: new Date().toISOString(), status: 'running', engine: 'real Pikafish',
    executablePath: resolvePikafishPath(), moveTimeMs: 1000, formatterSha256: notationHash,
    method: 'Replay legal history; real engine bestMove; shared legal check; independent four-character inverse geometric decoder; changed-action/destination negative checks; decode every legal alternative.',
    cases: [],
  };
  await mkdir(dirname(reportPath), { recursive: true });
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  const seen = new Set();
  const notationCoverage = new Map();
  const engineCoverage = new Map();
  let alternatives = 0;
  try {
    assert.equal((await engine.getInfo()).available, true, 'Real Pikafish resources unavailable');
    for (const [branch, seed] of seeds) {
      let game = replay(seed);
      for (let step = 0; step < 5 && !game.result; step++) {
        const positionKey = sha256(JSON.stringify([game.board, game.turn]));
        const record = {
          index: report.cases.length + 1, branch, step, side: game.turn, positionKey,
          uniquePosition: !seen.has(positionKey), history: game.history.map(({ from, to }) => ({ from, to })),
          pieces: game.board.flatMap((piece, index) => piece ? [{ ...piece, ...point(index) }] : []),
        };
        report.cases.push(record);
        seen.add(positionKey);
        const start = performance.now();
        const suggested = await engine.bestMove(record.history);
        record.elapsedMs = Math.round(performance.now() - start);
        record.move = suggested;
        record.uci = toUci(suggested.from) + toUci(suggested.to);
        record.piece = game.board[suggested.from.y * 9 + suggested.from.x];
        assert.ok(validateMove(game, suggested.from, suggested.to).ok, 'Real engine suggestion is illegal');
        record.notation = chineseMoveNotation(game, suggested);
        record.decoded = decodeNotation(game, record.notation);
        assert.ok(sameMove(record.decoded, suggested), 'Independent notation decoder disagrees with engine coordinates');
        record.mutations = mutationCheck(game, record.notation, suggested);
        engineCoverage.set(record.piece.type, (engineCoverage.get(record.piece.type) ?? 0) + 1);
        let checked = 0;
        for (const [index, piece] of game.board.entries()) {
          if (piece?.side !== game.turn) continue;
          const from = point(index);
          for (const to of legalMoves(game, from)) {
            const alternative = { from, to };
            const notation = chineseMoveNotation(game, alternative);
            let decoded;
            try { decoded = decodeNotation(game, notation); }
            catch (error) {
              record.failedAlternative = { piece, move: alternative, notation };
              throw error;
            }
            if (!sameMove(decoded, alternative)) record.failedAlternative = { piece, move: alternative, notation, decoded };
            assert.ok(sameMove(decoded, alternative), 'An alternative legal move has incorrect notation');
            notationCoverage.set(piece.type, (notationCoverage.get(piece.type) ?? 0) + 1);
            checked++;
          }
        }
        record.legalAlternativeChecks = checked;
        alternatives += checked;
        record.pass = true;
        await save();
        console.log(`${record.index}/45 ${branch} ${record.side} ${record.uci} ${record.notation}: coordinates match; ${checked} legal alternatives decoded (${record.elapsedMs}ms)`);
        const applied = applyMove(game, suggested.from, suggested.to);
        assert.ok(applied.ok);
        game = applied.game;
      }
    }
    assert.ok(seen.size >= 36, `Only ${seen.size} different reachable positions; expected at least 36`);
    assert.ok(report.cases.some((c) => c.history.length === 0), 'Initial position missing');
    for (const side of ['red', 'black']) assert.ok(report.cases.some((c) => c.side === side), `${side} coverage missing`);
    for (const type of ['horse', 'cannon', 'rook', 'pawn']) assert.ok(notationCoverage.has(type), `${type} notation coverage missing`);
    assert.equal(sha256(await readFile(notationPath)), notationHash, 'Formatter changed during verification; rerun against stable version');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = { message: error.message, stack: error.stack };
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.summary = {
      engineCases: report.cases.length, passedCases: report.cases.filter((c) => c.pass).length,
      uniqueReachablePositions: seen.size, sides: Object.fromEntries(['red', 'black'].map((side) => [side, report.cases.filter((c) => c.side === side).length])),
      negativeMutationChecks: report.cases.reduce((n, c) => n + (c.mutations?.length ?? 0), 0),
      legalAlternativeChecks: alternatives, enginePieceTypes: Object.fromEntries(engineCoverage),
      alternativePieceTypes: Object.fromEntries(notationCoverage),
    };
    await engine.close();
    await save();
    console.log(JSON.stringify({ status: report.status, ...report.summary, reportPath, error: report.error?.message }));
  }
}

await main();
