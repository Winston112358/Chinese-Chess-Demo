import { chineseMoveNotation } from './move-notation.js';

const sideNames = { red: '红方', black: '黑方' };
// Match the canonical captured-piece names displayed on the board.
const pieceNames = {
  red: { general: '帅', advisor: '仕', elephant: '相', horse: '马', rook: '车', cannon: '炮', pawn: '兵' },
  black: { general: '将', advisor: '士', elephant: '象', horse: '马', rook: '车', cannon: '砲', pawn: '卒' },
};
const indexOf = ({ x, y }) => y * 9 + x;

export function formatMoveRecord(positionBefore, move, ply) {
  const notation = chineseMoveNotation(positionBefore, move);
  const side = move.piece.side;
  const coordinates = `(${move.from.x + 1},${move.from.y + 1}) → (${move.to.x + 1},${move.to.y + 1})`;
  const capture = move.captured
    ? `吃${sideNames[move.captured.side]}${pieceNames[move.captured.side][move.captured.type]}` : '';
  return {
    ply,
    side,
    notation,
    coordinates,
    capture,
    text: `${sideNames[side]} ${notation} · ${coordinates}${capture ? ` ${capture}` : ''}`,
  };
}

// The history is the adopted branch after undo. Reconstruct its starting board
// from the final position so sandbox/custom positions use their own baseline.
export function getMoveRecords(game) {
  const board = game.board.slice();
  for (let index = game.history.length - 1; index >= 0; index--) {
    const move = game.history[index];
    board[indexOf(move.from)] = move.piece;
    board[indexOf(move.to)] = move.captured ?? null;
  }
  return game.history.map((move, index) => {
    const record = formatMoveRecord({ board }, move, index + 1);
    board[indexOf(move.from)] = null;
    board[indexOf(move.to)] = move.piece;
    return record;
  });
}
