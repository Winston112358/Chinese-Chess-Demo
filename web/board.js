import { COLS, ROWS, PIECE_NAMES, SIDE_NAMES, indexOf } from '/shared/rules.js';

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
  return `<svg viewBox="0 0 540 600" aria-hidden="true"><g stroke="#80633d" stroke-width="1.5">${lines}</g>
    <g font-size="22" fill="#80633d" text-anchor="middle"><text x="150" y="307">楚 河</text><text x="390" y="307">汉 界</text></g></svg>`;
}

export function renderBoard(element, { game, selected, moves, flipped, onClick }) {
  element.innerHTML = gridSvg();
  const last = game.history.at(-1);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const point = { x, y };
      const piece = game.board[indexOf(point)];
      const button = document.createElement('button');
      const classes = ['point'];
      if (piece) classes.push('piece', piece.side);
      if (samePoint(point, selected)) classes.push('selected');
      if (moves.some((move) => samePoint(move, point))) classes.push('legal');
      if (samePoint(point, last?.from) || samePoint(point, last?.to)) classes.push('last');
      button.className = classes.join(' ');
      button.style.left = `${((flipped ? 8 - x : x) + .5) / COLS * 100}%`;
      button.style.top = `${((flipped ? 9 - y : y) + .5) / ROWS * 100}%`;
      button.dataset.x = x;
      button.dataset.y = y;
      const name = piece ? `${SIDE_NAMES[piece.side]}${PIECE_NAMES[piece.side][piece.type]}` : '空位';
      button.textContent = piece ? PIECE_NAMES[piece.side][piece.type] : '';
      button.setAttribute('aria-label', `${name}，第${x + 1}列第${y + 1}行`);
      button.setAttribute('aria-pressed', String(Boolean(samePoint(point, selected))));
      button.title = `${name} (${x + 1}, ${y + 1})`;
      button.addEventListener('click', () => onClick(point));
      element.append(button);
    }
  }
}
