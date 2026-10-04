import { getAutomaticResult } from './adjudication.js';

export const COLS = 9;
export const ROWS = 10;
export const SIDE_NAMES = { red: '红方', black: '黑方' };
// Canonical names use simplified 车; local fonts may display traditional 俥/車.
export const PIECE_NAMES = {
  red: { general: '帅', advisor: '仕', elephant: '相', horse: '马', rook: '车', cannon: '炮', pawn: '兵' },
  black: { general: '将', advisor: '士', elephant: '象', horse: '马', rook: '车', cannon: '砲', pawn: '卒' },
};

export const otherSide = (side) => side === 'red' ? 'black' : 'red';
export const indexOf = ({ x, y }) => y * COLS + x;
export const pieceAt = (board, point) => board[indexOf(point)];
export const insideBoard = (point) => point && Number.isInteger(point.x) && Number.isInteger(point.y)
  && point.x >= 0 && point.x < COLS && point.y >= 0 && point.y < ROWS;

const MOVE_RESULT_REASONS = new Set([
  'general-captured', 'checkmate', 'stalemate', 'repetition', 'perpetual-check',
  'perpetual-chase', 'no-capture', 'insufficient-material',
]);
export const canUndoResult = (result) => !result || MOVE_RESULT_REASONS.has(result.reason);

export function createInitialGame() {
  const board = Array(COLS * ROWS).fill(null);
  const backRank = ['rook', 'horse', 'elephant', 'advisor', 'general', 'advisor', 'elephant', 'horse', 'rook'];
  for (const side of ['black', 'red']) {
    const backY = side === 'red' ? 9 : 0;
    backRank.forEach((type, x) => { board[indexOf({ x, y: backY })] = { side, type }; });
    for (const x of [1, 7]) board[indexOf({ x, y: side === 'red' ? 7 : 2 })] = { side, type: 'cannon' };
    for (const x of [0, 2, 4, 6, 8]) board[indexOf({ x, y: side === 'red' ? 6 : 3 })] = { side, type: 'pawn' };
  }
  return { board, turn: 'red', history: [], result: null };
}

function inPalace(side, { x, y }) {
  return x >= 3 && x <= 5 && (side === 'red' ? y >= 7 && y <= 9 : y >= 0 && y <= 2);
}

function interveningPieces(board, from, to) {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  let count = 0;
  for (let x = from.x + dx, y = from.y + dy; x !== to.x || y !== to.y; x += dx, y += dy) {
    if (pieceAt(board, { x, y })) count++;
  }
  return count;
}

// This checks piece geometry only. General safety is checked on the resulting board.
function movementError(board, from, to) {
  const piece = pieceAt(board, from);
  const target = pieceAt(board, to);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  switch (piece.type) {
    case 'general':
      if (target?.type === 'general' && target.side !== piece.side && dx === 0
        && interveningPieces(board, from, to) === 0) return null;
      return ax + ay === 1 && inPalace(piece.side, to) ? null : '将帅只能在九宫内直走一格';
    case 'advisor':
      return ax === 1 && ay === 1 && inPalace(piece.side, to) ? null : '士仕只能在九宫内斜走一格';
    case 'elephant':
      if (ax !== 2 || ay !== 2) return '象相必须走田字';
      if (piece.side === 'red' ? to.y < 5 : to.y > 4) return '象相不能过河';
      return pieceAt(board, { x: from.x + dx / 2, y: from.y + dy / 2 }) ? '象眼被堵住了' : null;
    case 'horse': {
      if (!((ax === 2 && ay === 1) || (ax === 1 && ay === 2))) return '马必须走日字';
      const leg = ax === 2 ? { x: from.x + Math.sign(dx), y: from.y }
        : { x: from.x, y: from.y + Math.sign(dy) };
      return pieceAt(board, leg) ? '马腿被蹩住了' : null;
    }
    case 'rook':
      if (dx !== 0 && dy !== 0) return '车只能沿直线移动';
      return interveningPieces(board, from, to) === 0 ? null : '车不能越过棋子';
    case 'cannon': {
      if (dx !== 0 && dy !== 0) return '炮只能沿直线移动';
      const count = interveningPieces(board, from, to);
      return target ? (count === 1 ? null : '炮吃子必须隔着恰好一枚棋子')
        : (count === 0 ? null : '炮不吃子时不能越过棋子');
    }
    case 'pawn': {
      const forward = piece.side === 'red' ? -1 : 1;
      const crossed = piece.side === 'red' ? from.y <= 4 : from.y >= 5;
      return (dx === 0 && dy === forward) || (crossed && ax === 1 && dy === 0)
        ? null : '兵卒只能前进一格，过河后可以横走，不能后退';
    }
    default:
      return '未知棋子';
  }
}

export function isInCheck(board, side) {
  const generalIndex = board.findIndex((piece) => piece?.side === side && piece.type === 'general');
  if (generalIndex < 0) return true;
  const general = { x: generalIndex % COLS, y: Math.floor(generalIndex / COLS) };
  return board.some((piece, index) => piece && piece.side !== side
    && movementError(board, { x: index % COLS, y: Math.floor(index / COLS) }, general) === null);
}

function movedBoard(board, from, to) {
  const next = board.slice();
  next[indexOf(to)] = next[indexOf(from)];
  next[indexOf(from)] = null;
  return next;
}

export function validateMove(game, from, to) {
  if (game.result) return { ok: false, error: '棋局已经结束，请重新开始或悔棋' };
  if (!insideBoard(from) || !insideBoard(to)) return { ok: false, error: '位置必须是棋盘内的交叉点' };
  if (from.x === to.x && from.y === to.y) return { ok: false, error: '请选择另一个落点' };
  const piece = pieceAt(game.board, from);
  if (!piece) return { ok: false, error: '起点没有棋子' };
  if (piece.side !== game.turn) return { ok: false, error: `现在轮到${SIDE_NAMES[game.turn]}` };
  if (pieceAt(game.board, to)?.side === piece.side) return { ok: false, error: '不能吃自己的棋子' };
  const error = movementError(game.board, from, to);
  if (error) return { ok: false, error };
  if (isInCheck(movedBoard(game.board, from, to), piece.side)) {
    return { ok: false, error: '这步会使己方将帅受攻击或与对方将帅照面' };
  }
  return { ok: true };
}

function candidateDestinations(board, from) {
  const piece = pieceAt(board, from);
  if (!piece) return [];
  const destinations = [];
  const seen = new Set();
  const add = (x, y) => {
    const to = { x, y };
    if (!insideBoard(to) || pieceAt(board, to)?.side === piece.side || seen.has(indexOf(to))) return;
    seen.add(indexOf(to));
    destinations.push(to);
  };
  const straight = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  switch (piece.type) {
    case 'rook':
    case 'cannon':
      for (const [dx, dy] of straight) {
        let screened = false;
        for (let x = from.x + dx, y = from.y + dy; insideBoard({ x, y }); x += dx, y += dy) {
          const target = pieceAt(board, { x, y });
          if (piece.type === 'rook') {
            add(x, y);
            if (target) break;
          } else if (!screened) {
            if (target) screened = true;
            else add(x, y);
          } else if (target) {
            add(x, y);
            break;
          }
        }
      }
      break;
    case 'horse':
      for (const [dx, dy] of [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [-1, 2], [1, -2], [-1, -2]]) {
        const leg = Math.abs(dx) === 2 ? { x: from.x + Math.sign(dx), y: from.y }
          : { x: from.x, y: from.y + Math.sign(dy) };
        if (!pieceAt(board, leg)) add(from.x + dx, from.y + dy);
      }
      break;
    case 'elephant':
      for (const dx of [-2, 2]) for (const dy of [-2, 2]) {
        const to = { x: from.x + dx, y: from.y + dy };
        if ((piece.side === 'red' ? to.y >= 5 : to.y <= 4)
          && !pieceAt(board, { x: from.x + dx / 2, y: from.y + dy / 2 })) add(to.x, to.y);
      }
      break;
    case 'advisor':
      for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
        const to = { x: from.x + dx, y: from.y + dy };
        if (inPalace(piece.side, to)) add(to.x, to.y);
      }
      break;
    case 'general':
      for (const [dx, dy] of straight) {
        const to = { x: from.x + dx, y: from.y + dy };
        if (inPalace(piece.side, to)) add(to.x, to.y);
      }
      // A flying-general capture can span the board and lies outside its own palace.
      for (const dy of [-1, 1]) {
        for (let y = from.y + dy; y >= 0 && y < ROWS; y += dy) {
          const target = pieceAt(board, { x: from.x, y });
          if (target) {
            if (target.type === 'general') add(from.x, y);
            break;
          }
        }
      }
      break;
    case 'pawn':
      add(from.x, from.y + (piece.side === 'red' ? -1 : 1));
      if (piece.side === 'red' ? from.y <= 4 : from.y >= 5) {
        add(from.x - 1, from.y);
        add(from.x + 1, from.y);
      }
      break;
  }
  return destinations;
}

export function legalMoves(game, from) {
  if (game.result) return [];
  if (!insideBoard(from) || pieceAt(game.board, from)?.side !== game.turn) return [];
  return candidateDestinations(game.board, from)
    .filter((to) => validateMove(game, from, to).ok)
    .sort((a, b) => indexOf(a) - indexOf(b));
}

export function getGameResult(game) {
  const sides = [game.turn, otherSide(game.turn)];
  const missingGeneral = sides.find((side) => !game.board.some(
    (piece) => piece?.side === side && piece.type === 'general',
  ));
  if (missingGeneral) {
    return { winner: otherSide(missingGeneral), loser: missingGeneral, reason: 'general-captured' };
  }

  // Recompute from the position, even when the caller already has a saved result.
  const activeGame = { ...game, result: null };
  for (let index = 0; index < game.board.length; index++) {
    if (game.board[index]?.side !== game.turn) continue;
    const from = { x: index % COLS, y: Math.floor(index / COLS) };
    for (const to of candidateDestinations(game.board, from)) {
      if (validateMove(activeGame, from, to).ok) {
        return getAutomaticResult(game, { cols: COLS, isInCheck, canCapture });
      }
    }
  }
  return {
    winner: otherSide(game.turn),
    loser: game.turn,
    reason: isInCheck(game.board, game.turn) ? 'checkmate' : 'stalemate',
  };
}

function canCapture(board, from, to) {
  const piece = board[from];
  if (!piece || !board[to] || piece.side === board[to].side) return false;
  return validateMove({ board, turn: piece.side, result: null },
    { x: from % COLS, y: Math.floor(from / COLS) },
    { x: to % COLS, y: Math.floor(to / COLS) }).ok;
}

export function applyMove(game, from, to) {
  const validation = validateMove(game, from, to);
  if (!validation.ok) return validation;
  const move = { from: { ...from }, to: { ...to }, piece: pieceAt(game.board, from), captured: pieceAt(game.board, to) };
  const nextGame = {
    board: movedBoard(game.board, from, to),
    turn: otherSide(game.turn),
    history: [...game.history, move],
    result: null,
  };
  nextGame.result = getGameResult(nextGame);
  return { ok: true, game: nextGame };
}

export function undoMove(game) {
  if (!game.history.length) return game;
  const move = game.history.at(-1);
  const board = game.board.slice();
  board[indexOf(move.from)] = move.piece;
  board[indexOf(move.to)] = move.captured;
  return { board, turn: move.piece.side, history: game.history.slice(0, -1), result: null };
}
