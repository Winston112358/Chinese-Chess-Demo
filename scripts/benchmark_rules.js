import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { createInitialGame, applyMove, legalMoves, getGameResult, indexOf } from '../src/shared/rules.js';

const samples = 20_000;
const warmup = 3000;
const scenarios = new Map([['standard opening', createInitialGame()]]);

let middle = createInitialGame();
for (let ply = 0; ply < 32; ply++) {
  const moves = middle.board.flatMap((piece, index) => {
    if (piece?.side !== middle.turn) return [];
    const from = { x: index % 9, y: Math.floor(index / 9) };
    return legalMoves(middle, from).map((to) => ({ from, to }));
  });
  if (!moves.length) throw new Error('Benchmark middle-game sequence ended early');
  const move = moves[(ply * 17 + 3) % moves.length];
  middle = applyMove(middle, move.from, move.to).game;
}
scenarios.set('32-ply middle game', middle);

let mate = createInitialGame();
for (const [x, y, tx, ty] of [[4, 6, 4, 5], [4, 3, 4, 4], [3, 9, 4, 8], [4, 4, 4, 5],
  [1, 7, 4, 7], [4, 5, 3, 5], [4, 7, 4, 2], [3, 5, 2, 5], [7, 7, 4, 7]]) {
  const move = applyMove(mate, { x, y }, { x: tx, y: ty });
  if (!move.ok) throw new Error(move.error);
  mate = move.game;
}
if (mate.result?.reason !== 'checkmate') throw new Error('Expected an actual checkmate');
scenarios.set('full-army checkmate', mate);

const stalemate = { board: Array(90).fill(null), turn: 'red', history: [], result: null };
for (const [side, type, x, y] of [['red', 'general', 4, 9], ['black', 'general', 5, 0],
  ['black', 'rook', 3, 8], ['black', 'rook', 5, 8]]) {
  stalemate.board[indexOf({ x, y })] = { side, type };
}
if (getGameResult(stalemate)?.reason !== 'stalemate') throw new Error('Expected a stalemate');
scenarios.set('stalemate', stalemate);

const results = [];
for (const [name, game] of scenarios) {
  const times = [];
  for (let i = 0; i < warmup; i++) getGameResult(game);
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    getGameResult(game);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const percentile = (fraction) => times[Math.ceil(times.length * fraction) - 1].toFixed(4);
  results.push({ scenario: name, samples, 'p50 ms': percentile(.5), 'p95 ms': percentile(.95),
    'p99 ms': percentile(.99), 'max ms': times.at(-1).toFixed(4) });
}
console.log(`Node ${process.version}; ${cpus()[0]?.model}; ${warmup} warm-up calls per scenario`);
console.table(results);
console.log('These measurements cover adjudication only; network, rendering and OS scheduling vary by computer.');
