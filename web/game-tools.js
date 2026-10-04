import { PIECE_NAMES, SIDE_NAMES } from '/shared/rules.js';
import { pieceGlyph } from '/piece-glyph.js';

const pieceVariables = ['--piece-bg', '--piece-red', '--piece-black'];

function renderCaptureRow(element, side, captures, boardStyle, skin) {
  element.classList.add('capture-row', 'skin-capture');
  element.dataset.side = side;
  if (skin) element.dataset.skin = skin;
  else delete element.dataset.skin;
  element.setAttribute('aria-label', `${SIDE_NAMES[side]}已吃的棋子`);
  for (const variable of pieceVariables) {
    const value = boardStyle?.getPropertyValue(variable).trim();
    if (value) element.style.setProperty(variable, value);
    else element.style.removeProperty(variable);
  }

  const label = document.createElement('span');
  label.className = 'capture-label';
  label.textContent = `${SIDE_NAMES[side]}已吃（${captures.length}）`;
  const pieces = document.createElement('div');
  pieces.className = 'captured-pieces';
  pieces.setAttribute('role', 'list');
  if (!captures.length) {
    const empty = document.createElement('span');
    empty.className = 'capture-empty';
    empty.textContent = '尚未吃子';
    pieces.append(empty);
  }
  for (const { piece, ply } of captures) {
    const name = PIECE_NAMES[piece.side][piece.type];
    const token = document.createElement('span');
    token.className = `captured-piece ${piece.side}`;
    token.dataset.side = piece.side;
    token.dataset.type = piece.type;
    token.dataset.ply = ply;
    token.setAttribute('role', 'listitem');
    token.setAttribute('aria-label', `${SIDE_NAMES[piece.side]}${name}，第${ply}步被吃`);
    token.title = `${SIDE_NAMES[piece.side]}${name}，第${ply}步被吃`;
    token.append(pieceGlyph(name, piece.side));
    pieces.append(token);
  }
  element.replaceChildren(label, pieces);
}

export function renderCaptured(topElement, bottomElement, { game, flipped }) {
  const captures = { red: [], black: [] };
  game.history.forEach((move, index) => {
    if (move.captured) captures[move.piece.side].push({ piece: move.captured, ply: index + 1 });
  });
  const board = document.getElementById('board');
  const boardStyle = board ? getComputedStyle(board) : null;
  const topSide = flipped ? 'red' : 'black';
  const bottomSide = flipped ? 'black' : 'red';
  renderCaptureRow(topElement, topSide, captures[topSide], boardStyle, board?.dataset.skin);
  renderCaptureRow(bottomElement, bottomSide, captures[bottomSide], boardStyle, board?.dataset.skin);
}
