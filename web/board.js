import { COLS, ROWS, PIECE_NAMES, SIDE_NAMES, indexOf } from '/shared/rules.js';
import { pieceGlyph, setPieceGlyph, setChessText } from '/piece-glyph.js';

const samePoint = (a, b) => a && b && a.x === b.x && a.y === b.y;
const line = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
const boardViews = new WeakMap();
const MOVE_DURATION_MS = 160;

function singleMove(previous, game, board, context, flipped) {
  if (!previous || previous.context !== context || previous.flipped !== flipped
    || game.history.length !== previous.historyLength + 1) return null;
  const move = game.history.at(-1);
  if (!move) return null;
  const from = indexOf(move.from);
  const to = indexOf(move.to);
  if (!previous.board[from] || board[from] !== null || board[to] !== previous.board[from]) return null;
  return board.every((piece, index) => index === from || index === to || piece === previous.board[index])
    ? move : null;
}

function slidePiece(state, button, origin) {
  if (!origin.width || typeof button.animate !== 'function') return;
  // A recently vacated square may still be finishing its selection transition.
  button.classList.add('moving');
  const target = button.getBoundingClientRect();
  if (!target.width) { button.classList.remove('moving'); return; }
  const dx = origin.left + origin.width / 2 - target.left - target.width / 2;
  const dy = origin.top + origin.height / 2 - target.top - target.height / 2;
  const animation = button.animate([
    { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(${origin.width / target.width})` },
    { transform: 'translate(-50%, -50%) translate(0px, 0px) scale(1)' },
  ], { duration: MOVE_DURATION_MS, easing: 'linear' });
  state.motion = { button, animation };
  const finish = () => {
    if (state.motion?.animation !== animation) return;
    button.classList.remove('moving');
    state.motion = null;
  };
  animation.onfinish = finish;
  animation.oncancel = finish;
}

function gridSvg() {
  let lines = '';
  for (let y = 0; y < ROWS; y++) lines += line(30, 30 + y * 60, 510, 30 + y * 60);
  for (let x = 0; x < COLS; x++) {
    const px = 30 + x * 60;
    if (x === 0 || x === 8) lines += line(px, 30, px, 570);
    else lines += line(px, 30, px, 270) + line(px, 330, px, 570);
  }
  for (const y of [30, 450]) lines += line(210, y, 330, y + 120) + line(330, y, 210, y + 120);
  return `<svg viewBox="0 0 540 600" aria-hidden="true"><g class="board-grid-halo" stroke-width="3">${lines}</g><g class="board-grid" stroke-width="1.5">${lines}</g>
    <g class="board-river" text-anchor="middle">${['楚', '河', '汉', '界'].map((character, index) =>
      `<text x="${[102, 198, 342, 438][index]}" y="314.4" font-size="48" data-character="${character}" data-letter-size="48" data-center-x="${[102, 198, 342, 438][index]}" data-center-y="300">${character}</text>`
    ).join('')}</g></svg>`;
}

export function renderBoard(element, { game, selected, moves, flipped, canSelect, onClick, danger = [], context = 'real' }) {
  let state = boardViews.get(element);
  let buttons = element.querySelectorAll('.point');
  // Keep the nodes so a selection change animates the lift and preserves keyboard focus.
  if (buttons.length !== COLS * ROWS) {
    state?.motion?.animation.cancel();
    state = undefined;
    element.innerHTML = gridSvg();
    for (let i = 0; i < COLS * ROWS; i++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'point';
      element.append(button);
    }
    buttons = element.querySelectorAll('.point');
  }
  for (const river of element.querySelectorAll('.board-river text')) {
    setChessText(river, river.getAttribute('data-character'), element.dataset.font);
  }
  const board = game.board.map((piece) => piece ? `${piece.side}:${piece.type}` : null);
  const move = singleMove(state, game, board, context, flipped);
  const origin = move ? buttons[indexOf(move.from)].getBoundingClientRect() : null;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const changed = !state || state.context !== context || state.flipped !== flipped
    || state.historyLength !== game.history.length || board.some((piece, index) => piece !== state.board[index]);
  if (state?.motion && (changed || reducedMotion)) {
    state.motion.button.classList.remove('moving');
    state.motion.animation.cancel();
    state.motion = null;
  }
  state ||= {};
  Object.assign(state, { board, context, flipped, historyLength: game.history.length });
  boardViews.set(element, state);
  const last = game.history.at(-1);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const point = { x, y };
      const piece = game.board[indexOf(point)];
      const button = buttons[indexOf(point)];
      const threatened = Boolean(piece && danger.some((target) => samePoint(target, point)));
      const classes = ['point'];
      // AI status and selection updates can redraw this same position mid-slide.
      if (state.motion?.button === button) classes.push('moving');
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
          glyph = pieceGlyph(PIECE_NAMES[piece.side][piece.type], piece.side);
          button.replaceChildren(glyph);
        } else {
          setPieceGlyph(glyph, PIECE_NAMES[piece.side][piece.type], element.dataset.font, piece.side);
        }
      } else button.replaceChildren();
      button.setAttribute('aria-label', `${name}，第${x + 1}列第${y + 1}行${threatened ? '，有被吃危险' : ''}`);
      button.setAttribute('aria-pressed', String(Boolean(samePoint(point, selected))));
      button.title = `${name} (${x + 1}, ${y + 1})${threatened ? '，有被吃危险' : ''}`;
      button.onclick = () => onClick(point);
    }
  }
  if (move && !reducedMotion) slidePiece(state, buttons[indexOf(move.to)], origin);
}
