import { COLS, ROWS, PIECE_NAMES, SIDE_NAMES, indexOf } from '/shared/rules.js';
import { pieceGlyph } from '/piece-glyph.js';

const samePoint = (a, b) => a && b && a.x === b.x && a.y === b.y;
const line = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;

function gridSvg() {
  let lines = '';
  for (let y = 0; y < ROWS; y++) lines += line(30, 30 + y * 60, 510, 30 + y * 60);
  for (let x = 0; x < COLS; x++) {
    const px = 30 + x * 60;
    if (x === 0 || x === 8) lines += line(px, 30, px, 570);
    else lines += line(px, 30, px, 270) + line(px, 330, px, 570);
  }
  for (const y of [30, 450]) lines += line(210, y, 330, y + 120) + line(330, y, 210, y + 120);
  return `<svg viewBox="0 0 540 600" aria-hidden="true"><g class="board-grid" stroke-width="1.5">${lines}</g>
    <g class="board-river" font-size="48" text-anchor="middle"><text x="150" y="314.4">楚 河</text><text x="390" y="314.4">汉 界</text></g></svg>`;
}

export function renderBoard(element, { game, selected, moves, flipped, canSelect, onClick, danger = [] }) {
  let buttons = element.querySelectorAll('.point');
  // Keep the nodes so a selection change animates the lift and preserves keyboard focus.
  if (buttons.length !== COLS * ROWS) {
    element.innerHTML = gridSvg();
    for (let i = 0; i < COLS * ROWS; i++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'point';
      element.append(button);
    }
    buttons = element.querySelectorAll('.point');
  }
  const last = game.history.at(-1);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const point = { x, y };
      const piece = game.board[indexOf(point)];
      const button = buttons[indexOf(point)];
      const threatened = Boolean(piece && danger.some((target) => samePoint(target, point)));
      const classes = ['point'];
      if (piece) classes.push('piece', piece.side);
      if (threatened) classes.push('danger');
      if (piece && canSelect && piece.side === game.turn) classes.push('selectable');
      if (samePoint(point, selected)) classes.push('selected');
      if (moves.some((move) => samePoint(move, point))) classes.push('legal');
      if (samePoint(point, last?.from) || samePoint(point, last?.to)) classes.push('last');
      button.className = classes.join(' ');
      button.style.left = `${((flipped ? 8 - x : x) + .5) / COLS * 100}%`;
      button.style.top = `${((flipped ? 9 - y : y) + .5) / ROWS * 100}%`;
      button.dataset.x = x;
      button.dataset.y = y;
      const name = piece ? `${SIDE_NAMES[piece.side]}${PIECE_NAMES[piece.side][piece.type]}` : '空位';
      if (piece) {
        let glyph = button.querySelector('.piece-glyph');
        if (!glyph) {
          glyph = pieceGlyph(PIECE_NAMES[piece.side][piece.type]);
          button.replaceChildren(glyph);
        } else {
          glyph.firstElementChild.textContent = PIECE_NAMES[piece.side][piece.type];
        }
      } else button.replaceChildren();
      button.setAttribute('aria-label', `${name}，第${x + 1}列第${y + 1}行${threatened ? '，有被吃危险' : ''}`);
      button.setAttribute('aria-pressed', String(Boolean(samePoint(point, selected))));
      button.title = `${name} (${x + 1}, ${y + 1})${threatened ? '，有被吃危险' : ''}`;
      button.onclick = () => onClick(point);
    }
  }
}
