// Program competition rules, chapters 1 and 3:
// https://www.pikafish.com/rule.html (revision 2023-11-22).
// Capture legality is supplied by rules.js so adjudication shares its king-safety checks.
const PIECE_CODES = { general: 'k', advisor: 'a', elephant: 'b', horse: 'n', rook: 'r', cannon: 'c', pawn: 'p' };
const SIDES = ['red', 'black'];
const opposite = (side) => side === 'red' ? 'black' : 'red';
const draw = (reason) => ({ winner: null, loser: null, reason });

function positionKey(board, turn) {
  return turn + ':' + board.map((piece) => {
    if (!piece) return '.';
    const code = PIECE_CODES[piece.type];
    return piece.side === 'red' ? code.toUpperCase() : code;
  }).join('');
}

// Rebuild from move values rather than object identity: LAN snapshots and JSON copies
// must adjudicate exactly like local games. A capture makes all older positions irrelevant.
function historyWindow(game, cols) {
  const frames = [{ board: game.board, turn: game.turn }];
  const moves = [];
  let board = game.board;
  for (let i = (game.history?.length ?? 0) - 1; i >= 0; i--) {
    const move = game.history[i];
    if (move.captured) break;
    board = board.slice();
    board[move.from.y * cols + move.from.x] = move.piece;
    board[move.to.y * cols + move.to.x] = null;
    moves.push(move);
    frames.push({ board, turn: move.piece.side });
  }
  return { moves: moves.reverse(), frames: frames.reverse() };
}

function repetitionStart(frames) {
  const last = frames.at(-1);
  const key = positionKey(last.board, last.turn);
  let matches = 1;
  // Alternating turns mean only every second predecessor can be the same position.
  for (let i = frames.length - 3; i >= 0; i -= 2) {
    if (positionKey(frames[i].board, frames[i].turn) === key && ++matches === 3) return i;
  }
  return -1;
}

function trackPieces(frames, moves, cols) {
  let identities = frames[0].board.map((piece, index) => piece ? index : null);
  return frames.map((frame, index) => {
    if (index) {
      const move = moves[index - 1];
      const from = move.from.y * cols + move.from.x;
      const to = move.to.y * cols + move.to.x;
      identities = identities.slice();
      identities[to] = identities[from];
      identities[from] = null;
    }
    return { ...frame, identities };
  });
}

function chaseTargets({ board, identities }, side, { canCapture, cols }) {
  const targets = new Set();
  for (let from = 0; from < board.length; from++) {
    const attacker = board[from];
    if (attacker?.side !== side || ['general', 'pawn'].includes(attacker.type)) continue;
    for (let to = 0; to < board.length; to++) {
      const target = board[to];
      if (!target || target.side === side || target.type === 'general') continue;
      const y = Math.floor(to / cols);
      if (target.type === 'pawn' && (target.side === 'red' ? y >= 5 : y <= 4)) continue;
      if (!canCapture(board, from, to)) continue;
      // Same-type, mutually legal captures are exchanges rather than chasing.
      if (attacker.type === target.type && canCapture(board, to, from)) continue;
      const favorableExchange = (['horse', 'cannon'].includes(attacker.type) && target.type === 'rook')
        || (['advisor', 'elephant'].includes(attacker.type) && ['horse', 'cannon', 'rook'].includes(target.type));
      if (!favorableExchange) {
        const afterCapture = board.slice();
        afterCapture[to] = attacker;
        afterCapture[from] = null;
        const defended = afterCapture.some((piece, defender) => piece?.side === target.side
          && canCapture(afterCapture, defender, to));
        if (defended) continue;
      }
      targets.add(identities[to]);
    }
  }
  return targets;
}

function longChase(side, frames, moves, rules) {
  let commonTargets;
  for (let i = 0; i < moves.length; i++) {
    if (moves[i].piece.side !== side) continue;
    const attacked = chaseTargets(frames[i + 1], side, rules);
    const afterResponse = chaseTargets(frames[i + 2], side, rules);
    const escaped = new Set([...attacked].filter((id) => !afterResponse.has(id)));
    commonTargets = commonTargets === undefined ? escaped
      : new Set([...commonTargets].filter((id) => escaped.has(id)));
    if (!commonTargets.size) return false;
  }
  return Boolean(commonTargets?.size);
}

function repetitionResult(window, start, rules) {
  const moves = window.moves.slice(start);
  const frames = window.frames.slice(start);
  const checks = moves.map((move, i) => rules.isInCheck(frames[i + 1].board, opposite(move.piece.side)));
  const grades = Object.fromEntries(SIDES.map((side) => [side,
    moves.every((move, i) => move.piece.side !== side || checks[i]) ? 2 : 0]));

  // A sequence containing any checks cannot be classified as long chasing.
  if (!checks.some(Boolean)) {
    // The closing position connects back to the first move. Add that response to
    // classify the side moving last, keeping the identities at the closing position.
    const firstMove = moves[0];
    const closingBoard = frames.at(-1).board.slice();
    const from = firstMove.from.y * rules.cols + firstMove.from.x;
    const to = firstMove.to.y * rules.cols + firstMove.to.x;
    closingBoard[to] = closingBoard[from];
    closingBoard[from] = null;
    frames.push({ board: closingBoard, turn: opposite(firstMove.piece.side) });
    const tracked = trackPieces(frames, [...moves, firstMove], rules.cols);
    for (const side of SIDES) grades[side] = longChase(side, tracked, moves, rules) ? 1 : 0;
  }
  if (grades.red === grades.black) return draw('repetition');
  const loser = grades.red > grades.black ? 'red' : 'black';
  return { winner: opposite(loser), loser, reason: grades[loser] === 2 ? 'perpetual-check' : 'perpetual-chase' };
}

function naturalLimitReached({ moves, frames }, { isInCheck }) {
  if (moves.length < 120) return false;
  const checks = { red: 0, black: 0 };
  let effectiveMoves = 0;
  let excludedResponse = false;
  for (let i = 0; i < moves.length; i++) {
    const side = moves[i].piece.side;
    const checking = isInCheck(frames[i + 1].board, opposite(side));
    const excessCheck = checking && ++checks[side] > 10;
    if (!excludedResponse && !excessCheck) effectiveMoves++;
    excludedResponse = excessCheck;
  }
  return effectiveMoves >= 120;
}

export function getAutomaticResult(game, rules) {
  if (!game.board.some((piece) => piece && ['rook', 'horse', 'cannon', 'pawn'].includes(piece.type))) {
    return draw('insufficient-material');
  }
  const window = historyWindow(game, rules.cols);
  const start = repetitionStart(window.frames);
  if (start >= 0) return repetitionResult(window, start, rules);
  return naturalLimitReached(window, rules) ? draw('no-capture') : null;
}
