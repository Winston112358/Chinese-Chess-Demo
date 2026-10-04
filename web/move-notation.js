const numerals = '〇一二三四五六七八九';
const pieceNames = {
  red: { general: '帅', advisor: '仕', elephant: '相', horse: '马', rook: '车', cannon: '炮', pawn: '兵' },
  black: { general: '将', advisor: '士', elephant: '象', horse: '马', rook: '车', cannon: '炮', pawn: '卒' },
};
const fileNumber = (side, x) => side === 'red' ? 9 - x : x + 1;
const validPoint = (point) => point && Number.isInteger(point.x) && Number.isInteger(point.y)
  && point.x >= 0 && point.x < 9 && point.y >= 0 && point.y < 10;

// Traditional four-character notation uses the position before the move.
// Crowded pawns are numbered from the player's right, front to back per file.
export function chineseMoveNotation(game, { from, to }) {
  if (!validPoint(from) || !validPoint(to)) throw new Error('无法记录无效坐标的着法');
  const piece = game.board[from.y * 9 + from.x];
  const name = pieceNames[piece?.side]?.[piece?.type];
  if (!name) throw new Error('无法记录空位的着法');
  const number = (value) => piece.side === 'red' ? numerals[value] : String(value);
  const companions = game.board.flatMap((candidate, index) => candidate?.side === piece.side
    && candidate.type === piece.type ? [{ x: index % 9, y: Math.floor(index / 9) }] : []);
  const frontFirst = (a, b) => piece.side === 'red' ? a.y - b.y : b.y - a.y;
  const sameFile = companions.filter(({ x }) => x === from.x).sort(frontFirst);
  let prefix = `${name}${number(fileNumber(piece.side, from.x))}`;
  if (sameFile.length > 1 && !['advisor', 'elephant'].includes(piece.type)) {
    let rank = sameFile.findIndex(({ y }) => y === from.y);
    let count = sameFile.length;
    if (piece.type === 'pawn') {
      const crowdedFiles = [...new Set(companions.map(({ x }) => x))]
        .filter((x) => companions.filter((point) => point.x === x).length > 1)
        .sort((a, b) => fileNumber(piece.side, a) - fileNumber(piece.side, b));
      if (crowdedFiles.length > 1) {
        const ordered = crowdedFiles.flatMap((x) => companions.filter((point) => point.x === x).sort(frontFirst));
        rank = ordered.findIndex((point) => point.x === from.x && point.y === from.y);
        count = ordered.length;
      }
      if (crowdedFiles.length > 1 || count > 3) prefix = `${numerals[rank + 1]}${name}`;
      else prefix = `${count === 2 ? ['前', '后'][rank] : ['前', '中', '后'][rank]}${name}`;
    } else prefix = `${rank === 0 ? '前' : '后'}${name}`;
  }
  const action = from.y === to.y ? '平' : (piece.side === 'red' ? to.y < from.y : to.y > from.y) ? '进' : '退';
  const target = action === '平' || ['horse', 'advisor', 'elephant'].includes(piece.type)
    ? fileNumber(piece.side, to.x) : Math.abs(to.y - from.y);
  return `${prefix}${action}${number(target)}`;
}
