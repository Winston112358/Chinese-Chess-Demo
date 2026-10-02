import { COLS, indexOf, legalMoves, otherSide, pieceAt } from './rules.js';

// Show only captures available on the opponent's next move, including general safety.
export function dangerousPieces(game, side) {
  const enemy = otherSide(side);
  const nextTurn = { ...game, turn: enemy, result: null };
  const threatened = new Set();
  game.board.forEach((piece, index) => {
    if (piece?.side !== enemy) return;
    const from = { x: index % COLS, y: Math.floor(index / COLS) };
    for (const to of legalMoves(nextTurn, from)) {
      if (pieceAt(game.board, to)?.side === side) threatened.add(indexOf(to));
    }
  });
  return [...threatened].sort((a, b) => a - b)
    .map((index) => ({ x: index % COLS, y: Math.floor(index / COLS) }));
}
