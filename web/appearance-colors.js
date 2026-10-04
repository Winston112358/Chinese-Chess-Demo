// Natural wood keeps its grain; only selected pale/dark materials vary their finish.
const paleBoards = new Set(['ivory', 'celadon', 'mist', 'lotus', 'beech', 'walnut', 'maple', 'ash']);
const paleSolidBoards = new Set(['ivory', 'celadon', 'mist', 'lotus']);
const darkBoards = new Set(['rosewood', 'zitan', 'suan-zhi', 'wenge', 'black-walnut', 'ebony']);

export function pieceTone(boardSkin, pieceSkin) {
  if (pieceSkin === 'ivory' && paleSolidBoards.has(boardSkin)) return 'warm';
  if (pieceSkin === 'horn-ivory' && paleBoards.has(boardSkin)) return 'warm';
  if (pieceSkin === 'jade-white' && paleSolidBoards.has(boardSkin)) return 'warm';
  if (pieceSkin === 'jade-celadon' && boardSkin === 'celadon') return 'warm';
  if (pieceSkin === 'horn-black' && darkBoards.has(boardSkin)) return 'warm';
  return 'light';
}
