import { createInitialGame, applyMove, validateMove, undoMove, canUndoResult, legalMoves, isInCheck, pieceAt, PIECE_NAMES, SIDE_NAMES } from '/shared/rules.js';
import { renderBoard } from '/board.js';
import { createSandbox, rebaseSandbox, sandboxApplyMove, sandboxUndo } from '/shared/sandbox.js';
import { dangerousPieces } from '/shared/analysis.js';
import { renderCaptured } from '/game-tools.js';
import { aiUndoCount, createAiSearch } from '/ai-game.js';
import { chineseMoveNotation } from '/move-notation.js';
import { createRoomControls, roomIsPlaying, restartDescription, readTimes, readMoveTime } from '/room-controls.js';

const $ = (id) => document.getElementById(id);
let localGame = createInitialGame();
let game = localGame;
let selected = null;
let flipped = false;
let socket = null;
let room = null;
let side = null;
let connecting = false;
let movePending = false;
let connectionTimer;
let clockReceivedAt = 0;
let clockExpired = false;
let sandbox = null;
let actionSending = false;
let dangerCache = { board: null, side: null, points: [] };
let displayedResultKey = '';
let resultReturnFocus = null;
let aiHumanSide = null;
let aiThinking = false;
let aiError = '';
let aiInfo = null;
let aiInfoLoading = false;
const aiSearch = createAiSearch();
const assistSearch = createAiSearch();
let assistJob = null;
let assistSuggestion = null;
const storageKey = 'xiangqi-last-room';
const ACTION_NAMES = { undo: '单步悔棋', draw: '求和', resign: '认输', restart: '重新开局' };
const roomControls = createRoomControls({
  document, now: () => performance.now(), notify,
  getState: () => ({ room, side, connected: socket?.readyState === WebSocket.OPEN,
    busy: connecting || movePending || actionSending || Boolean(pendingVote()), receivedAt: clockReceivedAt }),
  onReady: (message) => { actionSending = true; send(message); render(); },
  onRestart: (message) => {
    cancelAssist();
    actionSending = true;
    selected = null;
    send(message);
    notify('已发送下一局配置，等待对方同意');
    render();
  },
});

function timingStatus() {
  if (!roomIsPlaying(room)) return '尚未开局，不扣时';
  return room?.clock?.enabled === false ? '本局不计时' : '计时继续';
}

function savedSeat() {
  try { return JSON.parse(sessionStorage.getItem(storageKey)); } catch { return null; }
}

function notify(message, error = false) {
  $('message').textContent = message;
  $('message').classList.toggle('error', error);
}

function notifyAssist(message, error = false) {
  $('ai-assist-message').textContent = message;
  $('ai-assist-message').classList.toggle('error', error);
}

function resultDescription(result) {
  if (result.winner === null) {
    const reasons = {
      draw: '双方同意和棋',
      repetition: '重复局面，判和',
      'no-capture': '达到无吃子自然限着，判和',
      'insufficient-material': '双方均无进攻子力，判和',
    };
    return `${reasons[result.reason] || '和棋'}，对局结束。`;
  }
  const reasons = {
    checkmate: `${SIDE_NAMES[result.loser]}被将死`,
    stalemate: `${SIDE_NAMES[result.loser]}无合法着法（困毙）`,
    'general-captured': `${SIDE_NAMES[result.loser]}将帅被吃`,
    timeout: `${SIDE_NAMES[result.loser]}超时`,
    'move-timeout': `${SIDE_NAMES[result.loser]}单步超时`,
    'perpetual-check': `${SIDE_NAMES[result.loser]}长将违例`,
    'perpetual-chase': `${SIDE_NAMES[result.loser]}长捉违例`,
    resignation: `${SIDE_NAMES[result.loser]}认输${room ? '（双方已同意）' : ''}`,
  };
  return `${SIDE_NAMES[result.winner]}获胜：${reasons[result.reason] || '对局结束'}。`;
}

function resultKey(result) {
  return result ? `${result.winner}:${result.loser}:${result.reason}` : '';
}

function openResult() {
  if (!game.result) return;
  const overlay = $('result-overlay');
  const alreadyOpen = !overlay.hidden;
  overlay.hidden = false;
  $('result-summary').setAttribute('aria-expanded', 'true');
  if (alreadyOpen || pendingVote() || (!$('vote-popup').hidden && $('vote-popup').contains(document.activeElement))) return;
  resultReturnFocus = document.activeElement;
  $('result-dismiss').focus({ preventScroll: true });
}

function closeResult() {
  const overlay = $('result-overlay');
  const restoreFocus = overlay.contains(document.activeElement);
  overlay.hidden = true;
  $('result-summary').setAttribute('aria-expanded', 'false');
  if (restoreFocus) {
    const visible = (element) => element?.isConnected && !element.disabled
      && element.matches('button, input, select, textarea, a[href], summary, [tabindex]')
      && element.getClientRects().length > 0;
    const request = pendingVote();
    const voteTarget = request && !$('vote-popup').hidden
      ? (request.side !== side && !$('accept').disabled ? $('accept') : $('vote-position')) : null;
    const fallback = $('result-summary').hidden ? $('flip') : $('result-summary');
    const target = visible(voteTarget) ? voteTarget : visible(resultReturnFocus) ? resultReturnFocus : fallback;
    target.focus({ preventScroll: true });
  }
  resultReturnFocus = null;
}

function renderResult() {
  const result = game.result;
  const key = result ? `${room ? `room:${room.code}` : aiHumanSide ? 'ai' : 'local'}:${resultKey(result)}` : '';
  $('result-summary').hidden = !result;
  $('result-summary').textContent = result ? resultDescription(result) : '';
  $('result-title').textContent = result ? (result.winner === null ? '和棋' : `${SIDE_NAMES[result.winner]}获胜`) : '';
  $('game-result').hidden = !result;
  $('game-result').textContent = result ? resultDescription(result) : '';
  $('result-overlay').querySelector('.result-card').setAttribute('aria-modal', String(!pendingVote()));
  if (key !== displayedResultKey) {
    displayedResultKey = key;
    if (key) openResult();
    else closeResult();
  }
}

function formatTime(milliseconds) {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderClocks() {
  roomControls.renderCountdown();
  const clock = room?.clock;
  $('clock-panel').hidden = !clock || clock.enabled === false;
  $('clock-details').hidden = !clock;
  if (!clock) {
    const changed = clockExpired;
    clockExpired = false;
    return changed;
  }
  const elapsed = Math.max(0, performance.now() - clockReceivedAt);
  const moveTimed = clock.enabled !== false && clock.moveTimeMs != null;
  const movingSide = clock.runningSide || game.turn;
  const runningClock = clock.enabled !== false && clock.started && clock.runningSide && !game.result;
  const charged = runningClock ? Math.max(0, Math.min(elapsed, clock.remainingMs[clock.runningSide],
    moveTimed ? clock.moveRemainingMs ?? clock.moveTimeMs : Infinity)) : 0;
  const moveRemaining = moveTimed ? Math.max(0, (clock.moveRemainingMs ?? clock.moveTimeMs)
    - charged) : null;
  for (const color of ['red', 'black']) {
    const running = clock.started && clock.runningSide === color && !game.result;
    const remaining = Math.max(0, clock.remainingMs[color] - (running ? charged : 0));
    const text = formatTime(remaining);
    if ($(`time-${color}`).textContent !== text) $(`time-${color}`).textContent = text;
    $(`clock-${color}`).classList.toggle('running', running);
    $(`clock-${color}`).classList.toggle('low', clock.started && !game.result && remaining <= 60_000);
    const moveText = !moveTimed ? '未启用' : color === movingSide ? formatTime(moveRemaining) : '—';
    if ($(`move-time-${color}`).textContent !== moveText) $(`move-time-${color}`).textContent = moveText;
    $(`clock-${color}`).classList.toggle('move-low', Boolean(running && moveTimed && moveRemaining <= 10_000));
  }
  const expiredReason = clockUnavailableReason();
  const awaitingResult = Boolean(expiredReason);
  const expiryChanged = awaitingResult !== clockExpired;
  clockExpired = awaitingResult;
  const minutes = (milliseconds) => String(Number((milliseconds / 60_000).toFixed(2)));
  const summary = clock.enabled === false ? '本局不计时' : `房间时限：红方 ${minutes(clock.initialMs.red)} 分钟 · 黑方 ${minutes(clock.initialMs.black)} 分钟 · ${moveTimed ? `每步 ${clock.moveTimeMs / 1000} 秒` : '单步不限时'}`;
  if ($('time-control-summary').textContent !== summary) $('time-control-summary').textContent = summary;
  let info;
  if (game.result) info = '对局已结束。可配置下一局并请求对方同意。';
  else if (!roomIsPlaying(room)) info = '双方准备并倒数结束后开局；准备和倒数不扣时。';
  else if (clock.enabled === false) info = '本局不限时；红方先走。';
  else if (socket?.readyState !== WebSocket.OPEN) info = '连接已断开，计时继续；恢复房间后同步剩余时间。';
  else if (awaitingResult) info = `${expiredReason}。`;
  else info = `${SIDE_NAMES[clock.runningSide || game.turn]}计时中；沙盘、协商与断线均不停钟。`;
  if ($('clock-info').textContent !== info) $('clock-info').textContent = info;
  if (awaitingResult) {
    selected = null;
    if (assistJob || assistSuggestion) {
      cancelAssist();
      notifyAssist(`${expiredReason}，已取消 AI 辅助。`);
    }
    renderAi();
  }
  return expiryChanged;
}

function pendingVote() {
  const restart = room?.pendingRestart;
  return room?.pendingAction || (typeof restart === 'string' ? { action: 'restart', side: restart } : restart) || null;
}

function renderVote() {
  const request = pendingVote();
  $('vote-popup').hidden = !request;
  if (!request) return;
  const own = request.side === side;
  const label = ACTION_NAMES[request.action];
  $('vote-title').textContent = own ? `已发起${label}` : `${SIDE_NAMES[request.side]}请求${label}`;
  const explanation = {
    undo: '同意后仅撤销真实对局的最后一步，恢复该步之前的棋权和吃子；已用时间不返还。',
    draw: '同意后本局按和棋结束，双方停止计时。',
    resign: `同意后${SIDE_NAMES[request.side]}认输，对方获胜，双方停止计时。`,
    restart: restartDescription(request.config, side),
  };
  $('vote-description').textContent = explanation[request.action];
  $('vote-wait').hidden = !own;
  $('vote-wait').textContent = game.result ? '等待对手投票；本局已结束。' : `等待对手投票；暂不可落子，${timingStatus()}。`;
  $('vote-buttons').hidden = own;
  $('accept').disabled = $('decline').disabled = actionSending || connecting
    || socket?.readyState !== WebSocket.OPEN || !room.players.red || !room.players.black;
}

function dangerPoints(view) {
  if (!$('danger-toggle').checked || view.result) return [];
  const color = side || aiHumanSide || view.turn;
  if (dangerCache.board !== view.board || dangerCache.side !== color) {
    dangerCache = { board: view.board, side: color, points: dangerousPieces(view, color) };
  }
  return dangerCache.points;
}

function render() {
  if (assistJob && !currentAssist(assistJob)) {
    cancelAssist();
    notifyAssist('对局状态已变化，已取消 AI 辅助');
  }
  if (assistSuggestion && (assistUnavailableReason() || !sameAssistPosition(assistSuggestion))) {
    cancelAssist();
    notifyAssist('局面已变化，请重新构思。');
  }
  const connected = socket?.readyState === WebSocket.OPEN;
  const bothOnline = room?.players.red && room?.players.black;
  const ready = roomIsPlaying(room) && (!room || connected);
  const view = sandbox?.game || game;
  const request = pendingVote();
  const canNegotiate = Boolean(room && connected && bothOnline && room.clock?.started && !connecting && !actionSending && !request);
  $('mode').textContent = room ? `局域网 · 你是${SIDE_NAMES[side]}` : aiHumanSide ? `人机 · 你是${SIDE_NAMES[aiHumanSide]}` : '同机双人';
  $('turn').textContent = sandbox
    ? `沙盘 · ${view.result ? '推演结束' : `${SIDE_NAMES[view.turn]}走棋`} · 已推演 ${view.history.length} 步`
    : game.result ? `对局结束 · 已走 ${game.history.length} 步` : `${SIDE_NAMES[game.turn]}走棋 · 已走 ${game.history.length} 步${isInCheck(game.board, game.turn) ? ' · 将军！请应将' : ''}`;
  $('turn').className = `turn ${view.result?.winner || view.turn}`;
  if (!sandbox && room && !roomIsPlaying(room)) $('turn').textContent = room.phase === 'countdown' ? '双方已准备 · 即将开局' : '准备阶段';
  if (!sandbox && request && !game.result) $('turn').textContent += ' · 等待投票';
  if (!sandbox && aiHumanSide && !game.result && game.turn !== aiHumanSide) {
    $('turn').textContent += aiThinking ? ' · 皮卡鱼思考中…' : ' · 等待电脑走棋';
  }
  const undoable = canUndoResult(game.result);
  $('undo').textContent = room ? '请求单步悔棋' : aiHumanSide ? '撤回我的上一步' : '悔棋一步';
  $('undo').disabled = !(aiHumanSide ? aiUndoCount(game, aiHumanSide) : game.history.length) || !undoable || connecting || (room && !canNegotiate);
  $('draw').disabled = !canNegotiate || Boolean(game.result);
  $('draw').hidden = Boolean(aiHumanSide);
  $('resign').disabled = (aiHumanSide ? connecting : !canNegotiate) || Boolean(game.result);
  $('restart').disabled = connecting || (room && (!connected || !bothOnline || actionSending || Boolean(request) || room.phase === 'countdown'));
  $('sandbox-toggle').textContent = sandbox ? '退出沙盘' : '进入沙盘';
  $('sandbox-toggle').setAttribute('aria-pressed', String(Boolean(sandbox)));
  $('sandbox-toggle').disabled = !sandbox && (!ready || connecting || movePending || Boolean(game.result));
  $('sandbox-undo').hidden = !sandbox;
  $('sandbox-undo').disabled = !sandbox?.game.history.length;
  $('sandbox-banner').hidden = !sandbox;
  $('board').classList.toggle('sandbox-board', Boolean(sandbox));
  if (sandbox) {
    const real = game.result ? resultDescription(game.result) : request
      ? `真实棋局：等待投票，${timingStatus()}。`
      : aiHumanSide ? `真实棋局：${game.turn === aiHumanSide ? '轮到你走棋' : aiThinking ? '皮卡鱼思考中' : '等待电脑走棋'}。`
        : room ? `真实棋局：${SIDE_NAMES[game.turn]}走棋，${timingStatus()}。` : `真实棋局：${SIDE_NAMES[game.turn]}走棋。`;
    const analysis = view.result ? `推演结果：${resultDescription(view.result)}` : `${SIDE_NAMES[view.turn]}走棋${isInCheck(view.board, view.turn) ? ' · 将军' : ''}。`;
    $('sandbox-banner').textContent = `沙盘模式 · ${analysis} ${real}`;
  }
  $('local').hidden = !room && !connecting && !aiHumanSide;
  $('create').disabled = Boolean(room) || connecting;
  $('join').disabled = Boolean(room) || connecting;
  $('server').disabled = Boolean(room) || connecting;
  $('room-code').disabled = Boolean(room) || connecting;
  $('time-settings').disabled = Boolean(room) || connecting;
  $('time-settings').hidden = Boolean(room);
  $('resume').hidden = !savedSeat() || Boolean(room);
  $('resume').disabled = connecting;
  roomControls.render();
  renderVote();
  renderResult();
  if (room) {
    let status;
    if (!connected) status = `连接已断开，请恢复房间；${timingStatus()}`;
    else if (game.result) status = `对局已结束${bothOnline ? '，可双方同意重新开局' : '，等待对手重连后重新开局'}`;
    else if (!roomIsPlaying(room)) status = bothOnline ? '双方已连接；准备后倒数开局，不扣时' : '等待好友加入；准备阶段不扣时';
    else if (request) status = `等待投票，暂不可落子；${timingStatus()}${bothOnline ? '' : '，等待对手重连'}`;
    else status = bothOnline ? '双方已连接，可以对弈' : `对手已断线；${timingStatus()}，己方回合仍可落子`;
    $('network-status').textContent = `房间码：${room.code}\n${status}${request?.side === side ? `\n已请求${ACTION_NAMES[request.action]}，等待对手回应` : ''}`;
    $('resume').hidden = connected;
  }
  renderClocks();
  renderAi();
  renderBoard($('board'), {
    game: view, selected, flipped,
    context: `${room ? `room:${room.code}` : aiHumanSide ? `ai:${aiHumanSide}` : 'local'}:${sandbox ? 'sandbox' : 'real'}`,
    canSelect: !view.result && (sandbox ? true : ready && !clockUnavailableReason() && !connecting && !movePending && !actionSending && !request && (!room || game.turn === side) && (!aiHumanSide || game.turn === aiHumanSide)),
    moves: selected ? legalMoves(view, selected) : [],
    danger: dangerPoints(view),
    onClick: clickPoint,
  });
  const showCaptures = $('captures-toggle').checked;
  $('captures-top').hidden = $('captures-bottom').hidden = !showCaptures;
  $('danger-legend').hidden = !$('danger-toggle').checked;
  const captureGame = sandbox ? { ...view, history: [...game.history, ...view.history] } : game;
  if (showCaptures) renderCaptured($('captures-top'), $('captures-bottom'), { game: captureGame, flipped });
  const captured = captureGame.history.filter((move) => move.captured);
  $('captures').textContent = captured.length ? captured.map((move) => `${SIDE_NAMES[move.captured.side]}${PIECE_NAMES[move.captured.side][move.captured.type]}`).join('、') : '尚未吃子';
  $('history').replaceChildren();
  view.history.forEach((move) => {
    const item = document.createElement('li');
    item.textContent = `${SIDE_NAMES[move.piece.side]}${PIECE_NAMES[move.piece.side][move.piece.type]} (${move.from.x + 1},${move.from.y + 1}) → (${move.to.x + 1},${move.to.y + 1})${move.captured ? ` 吃${PIECE_NAMES[move.captured.side][move.captured.type]}` : ''}`;
    $('history').append(item);
  });
  $('history').scrollTop = $('history').scrollHeight;
}

function clickPoint(point) {
  const view = sandbox?.game || game;
  if (sandbox) {
    if (view.result) return notify('沙盘推演已结束，可以撤销一步或退出沙盘', true);
    const piece = pieceAt(view.board, point);
    if (piece?.side === view.turn) {
      selected = selected?.x === point.x && selected?.y === point.y ? null : point;
      notify('');
      render();
      return;
    }
    if (!selected) return notify(`沙盘：请选择${SIDE_NAMES[view.turn]}棋子`, true);
    const result = sandboxApplyMove(sandbox, selected, point);
    if (!result.ok) return;
    sandbox = result.sandbox;
    selected = null;
    notify(`沙盘已推演 ${sandbox.game.history.length} 步；真实棋局不变`);
    render();
    return;
  }
  if (connecting || movePending) return notify('请等待服务器回应', true);
  if (game.result) return notify(`对局已结束。${resultDescription(game.result)}`, true);
  if (room && (pendingVote() || actionSending)) return notify('请先完成投票，再继续走棋', true);
  if (room && socket?.readyState !== WebSocket.OPEN) return notify('连接已断开，请恢复房间后落子；计时继续', true);
  if (room && !roomIsPlaying(room)) return;
  if (room && game.turn !== side) return notify('现在是对手的回合', true);
  const clockReason = clockUnavailableReason();
  if (clockReason) return notify(clockReason, true);
  if (aiHumanSide && game.turn !== aiHumanSide) return notify(aiThinking ? '皮卡鱼正在思考，你可以进入沙盘推演' : '等待电脑走棋，请点击“重试电脑走棋”', Boolean(aiError));
  const piece = pieceAt(game.board, point);
  if (piece?.side === game.turn) {
    selected = selected?.x === point.x && selected?.y === point.y ? null : point;
    notify('');
    render();
    return;
  }
  if (!selected) return notify('请先选择当前回合的棋子', true);
  const result = room ? validateMove(game, selected, point) : applyMove(game, selected, point);
  if (!result.ok) return;
  cancelAssist();
  if (room) {
    movePending = true;
    send({ type: 'move', from: selected, to: point, revision: room.revision });
    render();
  } else {
    game = result.game;
    if (!aiHumanSide) localGame = game;
    selected = null;
    notify(game.result ? resultDescription(game.result) : '落子成功，轮到对方');
    render();
    if (aiHumanSide) void playAiMove();
  }
}

function renderAi() {
  const assistReason = assistUnavailableReason();
  $('ai-assist').hidden = Boolean(aiHumanSide);
  $('ai-assist').disabled = !assistJob && Boolean(assistReason);
  $('ai-assist').textContent = assistJob?.mode === 'move' ? '取消 AI 辅助' : 'AI 帮我走一步';
  $('ai-assist').title = assistJob?.mode === 'move' ? '取消本次分析，继续自行走棋'
    : assistReason || (assistSuggestion ? '执行当前显示的建议着法；联机提交期间继续计时' : '分析当前局面并直接走一步；联机分析期间继续计时');
  $('ai-suggest').hidden = Boolean(aiHumanSide);
  $('ai-suggest').disabled = !assistJob && Boolean(assistReason);
  $('ai-suggest').textContent = assistJob?.mode === 'suggest' ? '取消 AI 构思' : 'AI 帮我构思一步';
  $('ai-suggest').title = assistJob?.mode === 'suggest' ? '取消本次构思，继续自行走棋' : assistReason || '给出中文着法供你参考，棋子不会自动移动；联机分析期间继续计时';
  $('ai-assist-message').hidden = Boolean(aiHumanSide);
  $('ai-start').disabled = connecting || aiInfoLoading || aiInfo?.available === false;
  $('ai-start').textContent = aiHumanSide ? '按所选执子重新开局' : '开始人机对战';
  $('ai-retry').hidden = !aiHumanSide || !aiError || Boolean(game.result);
  $('ai-retry').disabled = aiThinking;
  $('ai-refresh').hidden = aiInfo?.available !== false;
  $('ai-refresh').disabled = aiInfoLoading;
  $('ai-status').classList.toggle('error', Boolean(aiError || aiInfo?.available === false));
  $('ai-status').textContent = aiHumanSide
    ? game.result ? `本局已结束。${resultDescription(game.result)}`
      : aiError ? `电脑走棋失败：${aiError}`
        : aiThinking ? '皮卡鱼正在思考…首次走棋可能稍慢。'
          : `你执${SIDE_NAMES[aiHumanSide]}，轮到你走棋。`
    : aiInfoLoading ? '正在检查皮卡鱼…'
      : aiInfo?.available ? '皮卡鱼已就绪 · 离线引擎'
        : aiInfo?.error || '正在检查皮卡鱼…';
}

function assistUnavailableReason() {
  if (aiHumanSide) return 'AI 辅助用于同机双人或局域网对局';
  if (sandbox) return '请先退出沙盘，再使用 AI 辅助走真实棋局';
  if (game.result) return '对局已结束';
  if (connecting || movePending) return '请等待服务器回应';
  if (actionSending || pendingVote()) return '请先完成投票，再使用 AI 辅助';
  if (room && socket?.readyState !== WebSocket.OPEN) return '请先恢复房间连接';
  if (room && !roomIsPlaying(room)) return '等待双方准备并倒数结束后才能走棋';
  if (room && game.turn !== side) return '轮到你走棋时才能使用 AI 辅助';
  const clockReason = clockUnavailableReason();
  if (clockReason) return clockReason;
  if (aiInfoLoading || !aiInfo) return '正在检查皮卡鱼…';
  if (!aiInfo.available) return aiInfo.error || '皮卡鱼不可用，请在右侧重新检查';
  return '';
}

function currentAssist(job) {
  if (assistJob !== job || assistUnavailableReason()) return false;
  return sameAssistPosition(job);
}

function sameAssistPosition(job) {
  // Room state messages rebuild game objects even when only a player reconnects.
  return room
    ? job.socket === socket && job.code === room.code && job.revision === room.revision && job.round === room.round
      && job.side === side && job.positionKey === assistPositionKey(game)
    : job.code === null && job.position === game && job.positionKey === assistPositionKey(game);
}

function assistPositionKey(position) {
  return JSON.stringify([position.board, position.turn, position.history, position.result]);
}

function clockUnavailableReason() {
  const clock = room?.clock;
  if (!clock || clock.enabled === false || !clock.started || !roomIsPlaying(room)
    || (clock.runningSide && clock.runningSide !== game.turn) || game.result) return '';
  const elapsed = clock.runningSide ? Math.max(0, performance.now() - clockReceivedAt) : 0;
  const total = clock.remainingMs[game.turn];
  const move = clock.moveTimeMs != null ? clock.moveRemainingMs ?? clock.moveTimeMs : null;
  if (move != null && move <= elapsed && move < total) return '本步剩余时间已到零，请等待服务器确认对局结果';
  if (total <= elapsed) return '剩余总时间已到零，请等待服务器确认对局结果';
  return '';
}

function cancelAssist() {
  assistSearch.cancel();
  assistJob = null;
  assistSuggestion = null;
  notifyAssist('');
}

function playAssistMove(job, move, notation) {
  if (assistUnavailableReason() || !sameAssistPosition(job)) throw new Error('局面已变化，请重新构思');
  const result = room ? validateMove(game, move.from, move.to) : applyMove(game, move.from, move.to);
  if (!result.ok) throw new Error('皮卡鱼返回的着法不符合本局规则，请重试');
  // Consume the suggestion before changing local state or submitting a move.
  assistJob = null;
  assistSuggestion = null;
  selected = null;
  if (room) {
    movePending = true;
    send({ type: 'move', from: move.from, to: move.to, revision: job.revision });
    notifyAssist(`AI 已选好：${notation}，正在提交落子…`);
  } else {
    game = localGame = result.game;
    notifyAssist(`AI 已代走：${notation}，${game.result ? resultDescription(game.result) : '轮到对方'}`);
  }
}

async function assistMove(mode = 'move') {
  if (assistJob && currentAssist(assistJob)) {
    if (assistJob.mode === mode) {
      cancelAssist();
      notifyAssist('已取消 AI 辅助，可以自行走棋');
    } else {
      // Reuse the same current-position search: aborting and immediately
      // restarting could hit the engine slot while its old process exits.
      assistJob.mode = mode;
      if (mode === 'move') selected = null;
      notifyAssist(mode === 'move' ? '分析完成后将走一步，可点击按钮取消。' : '正在构思，棋子不会自动移动。');
    }
    render();
    return;
  }
  if (mode === 'move' && assistSuggestion && !assistUnavailableReason() && sameAssistPosition(assistSuggestion)) {
    const suggestion = assistSuggestion;
    try {
      playAssistMove(suggestion, suggestion.move, suggestion.notation);
    } catch (error) {
      cancelAssist();
      notifyAssist(`AI 辅助失败：${error.message}`, true);
    }
    render();
    return;
  }
  cancelAssist();
  const reason = assistUnavailableReason();
  if (reason) return notifyAssist(reason, true);
  const job = { position: game, positionKey: assistPositionKey(game), code: room?.code ?? null,
    revision: room?.revision, round: room?.round, socket, side, mode };
  assistJob = job;
  if (mode === 'move') selected = null;
  notifyAssist(mode === 'suggest' ? `正在构思，棋子不会自动移动${room ? '；计时继续' : ''}。` : '');
  render();
  try {
    const move = await assistSearch.search(job.position);
    if (!move || !currentAssist(job)) return;
    const result = validateMove(game, move.from, move.to);
    if (!result.ok) throw new Error('皮卡鱼返回的着法不符合本局规则，请重试');
    const chosenMove = { from: { x: move.from.x, y: move.from.y }, to: { x: move.to.x, y: move.to.y } };
    const notation = chineseMoveNotation(job.position, chosenMove);
    if (job.mode === 'suggest') {
      assistJob = null;
      assistSuggestion = { ...job, move: chosenMove, notation };
      notifyAssist(`${SIDE_NAMES[job.position.turn]}建议：${notation}。可自行走棋，或点击“AI 帮我走一步”。`);
      return;
    }
    playAssistMove(job, chosenMove, notation);
  } catch (error) {
    if (!currentAssist(job)) return;
    notifyAssist(`AI 辅助失败：${error.message || '无法连接皮卡鱼，请重试'}`, true);
  } finally {
    // A cancelled request must not clear a newer search or its status message.
    if (assistJob === job) assistJob = null;
    render();
  }
}

async function checkAi() {
  aiInfoLoading = true;
  renderAi();
  try {
    const response = await fetch('/api/ai/info', { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('无法检查皮卡鱼，请重新检查');
    aiInfo = await response.json();
  } catch (error) {
    aiInfo = { available: false, error: error.name === 'TimeoutError' ? '检查皮卡鱼超时，请重新检查' : error.message };
  }
  aiInfoLoading = false;
  renderAi();
}

function cancelAi() {
  cancelAssist();
  aiSearch.cancel();
  aiThinking = false;
  aiError = '';
}

async function playAiMove() {
  if (!aiHumanSide || room || connecting || game.result || game.turn === aiHumanSide || aiThinking) return;
  const position = game;
  const player = aiHumanSide;
  aiThinking = true;
  aiError = '';
  render();
  try {
    const move = await aiSearch.search(position);
    if (!move || game !== position || aiHumanSide !== player || room || connecting) return;
    const result = applyMove(game, move.from, move.to);
    if (!result.ok) throw new Error('皮卡鱼返回的着法不符合本局规则，请重试');
    game = result.game;
    aiThinking = false;
    selected = null;
    const hadSandbox = Boolean(sandbox);
    if (sandbox) sandbox = game.result ? null : createSandbox(game, null);
    notify(game.result ? resultDescription(game.result) : hadSandbox ? '皮卡鱼已落子，沙盘已从最新棋局重新开始' : '皮卡鱼已落子，轮到你');
    render();
  } catch (error) {
    if (game !== position || aiHumanSide !== player || room || connecting) return;
    aiThinking = false;
    aiError = error.message || '无法连接皮卡鱼，请重试';
    notify(`电脑走棋失败：${aiError}`, true);
    render();
  }
}

// Stop callbacks from the former online seat before changing local modes.
function disconnectRoom() {
  const old = socket;
  socket = null;
  old?.close();
  clearTimeout(connectionTimer);
  room = null;
  side = null;
  connecting = false;
  movePending = false;
  actionSending = false;
  sandbox = null;
  selected = null;
}

$('ai-start').addEventListener('click', () => {
  cancelAi();
  disconnectRoom();
  aiHumanSide = $('ai-side').value === 'black' ? 'black' : 'red';
  game = createInitialGame();
  flipped = aiHumanSide === 'black';
  $('network-status').textContent = '人机对战已开始，上次联机房间可以恢复。';
  notify(`人机对战开始，你执${SIDE_NAMES[aiHumanSide]}，红方先行`);
  render();
  void playAiMove();
});
$('ai-retry').addEventListener('click', () => { notify('正在重试电脑走棋…'); void playAiMove(); });
$('ai-refresh').addEventListener('click', () => { void checkAi(); });
$('ai-assist').addEventListener('click', () => { void assistMove(); });
$('ai-suggest').addEventListener('click', () => { void assistMove('suggest'); });

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) { movePending = false; notify('连接已断开，请恢复房间', true); return; }
  socket.send(JSON.stringify(message));
}

function serverBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入 http:// 或 https:// 开头的服务器地址');
  return url.origin;
}

function connectionFailure(base) {
  return `${base} 连接失败。请核对当前房主 IP、实际端口和服务是否运行；换用房主的 Wi-Fi / 有线地址。若仍失败，请检查双方网络是否允许互访及房主防火墙。VPN 地址需双方处于同一虚拟网络。`;
}

function connectionCheckStatus(message, error = false) {
  $('connection-check-status').textContent = message;
  $('connection-check-status').classList.toggle('error', error);
}

$('check-connection').addEventListener('click', () => {
  let base;
  try { base = serverBase($('server').value.trim()); }
  catch (error) { connectionCheckStatus(error.message, true); return; }
  const button = $('check-connection');
  button.disabled = true;
  connectionCheckStatus(`正在检测 ${base}…`);
  let probe;
  let timer;
  let finished = false;
  const finish = (message, error = false) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    button.disabled = false;
    connectionCheckStatus(message, error);
    probe?.close();
  };
  try { probe = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`); }
  catch { finish(connectionFailure(base), true); return; }
  // A separate, seatless socket tests the guest's actual path without leaving a room.
  timer = setTimeout(() => finish(`检测超时。${connectionFailure(base)}`, true), 8000);
  probe.addEventListener('open', () => finish(`${base} 的对弈连接可达，可以创建或加入房间。本次检测未创建房间；只证明当前电脑到此地址可达。`));
  probe.addEventListener('error', () => finish(connectionFailure(base), true));
  probe.addEventListener('close', () => finish(connectionFailure(base), true));
});

function connect(action, address = $('server').value.trim()) {
  let base;
  try { base = serverBase(address); } catch (error) { notify(error.message, true); return; }
  cancelAi();
  if (aiHumanSide) { aiHumanSide = null; game = localGame; flipped = false; }
  if (socket) socket.close();
  clearTimeout(connectionTimer);
  connecting = true;
  movePending = false;
  actionSending = false;
  sandbox = null;
  selected = null;
  notify('正在连接房主的服务器…');
  let ws;
  try { ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`); }
  catch { connecting = false; connectionCheckStatus(connectionFailure(base), true); render(); return; }
  let assigned = false;
  socket = ws;
  connectionTimer = setTimeout(() => {
    if (socket !== ws) return;
    connectionCheckStatus(`连接超时。${connectionFailure(base)}`, true);
    ws.close();
    notify('连接超时，请检查地址、网络和防火墙', true);
  }, 8000);
  ws.addEventListener('open', () => {
    if (socket !== ws) return;
    connectionCheckStatus('');
    ws.send(JSON.stringify(action));
  });
  ws.addEventListener('message', (event) => {
    if (socket !== ws) return;
    const message = JSON.parse(event.data);
    let revealReady = false;
    if (message.type === 'clock') {
      if (room && message.code === room.code && message.revision === room.revision) {
        room.clock = message.clock;
        clockReceivedAt = performance.now();
        if (renderClocks()) render();
        else renderAi();
      }
      return;
    }
    clearTimeout(connectionTimer);
    if (message.type === 'seat') {
      assigned = true;
      const sameSeat = room?.code === message.code && side === message.side;
      side = message.side;
      if (!sameSeat) { flipped = side === 'black'; cancelAssist(); sandbox = null; selected = null; }
      $('server').value = base;
      $('room-code').value = message.code;
      try { sessionStorage.setItem(storageKey, JSON.stringify({ base, code: message.code, token: message.token })); }
      catch { notify('浏览器未允许保存席位；关闭页面后需重新建房', true); }
    } else if (message.type === 'state') {
      const previous = room;
      room = message.room;
      revealReady = room.phase === 'preparing' && (!previous || previous.code !== room.code
        || previous.round !== room.round || previous.phase !== 'preparing');
      game = room.game;
      clockReceivedAt = performance.now();
      const positionChanged = !previous || previous.code !== room.code || previous.revision !== room.revision;
      const resultChanged = resultKey(previous?.game.result) !== resultKey(game.result);
      const wasMovePending = movePending;
      connecting = false;
      actionSending = false;
      let sandboxRebased = false;
      if (sandbox && previous?.round !== room.round) sandbox = null;
      if (sandbox && positionChanged) {
        sandbox = rebaseSandbox(sandbox, game, room.revision);
        sandboxRebased = true;
      }
      if (sandbox && game.result) sandbox = null;
      if (positionChanged || resultChanged) movePending = false;
      if (positionChanged || game.result || (!sandbox && (!roomIsPlaying(room) || game.turn !== side || pendingVote()))) selected = null;
      if (game.result) notify(resultDescription(game.result));
      else if (sandboxRebased) notify('真实棋局已更新，沙盘推演已重置');
      else if (positionChanged) notify(roomIsPlaying(room) ? (wasMovePending ? '落子成功，轮到对方' : '棋盘已同步，按回合落子') : '准备阶段；双方准备后倒数开局');
      else if (previous?.phase !== room.phase) notify(room.phase === 'playing' ? '对局开始，红方先行' : room.phase === 'countdown' ? '双方已准备，正在倒数' : '开局倒数已取消，请重新准备');
      else if (previous?.pendingAction && !room.pendingAction) notify('协商已处理，继续正常对局');
      else if (previous.players.red !== room.players.red || previous.players.black !== room.players.black) {
        notify(pendingVote() ? `等待投票，暂不可落子；${timingStatus()}` : room.players.red && room.players.black ? '双方已连接' : (roomIsPlaying(room) ? `对手已断线；${timingStatus()}，己方回合仍可落子` : '等待好友加入房间，准备阶段不扣时'));
      } else if (previous.pendingRestart?.id !== room.pendingRestart?.id) {
        notify(room.pendingRestart ? `等待重新开局投票，暂不可落子；${timingStatus()}` : '重新开局请求已结束');
      }
    } else if (message.type === 'error') {
      connecting = false;
      movePending = false;
      actionSending = false;
      notify(message.error, true);
      if (!assigned) {
        room = null;
        side = null;
        game = localGame;
        if (action.type === 'resume') sessionStorage.removeItem(storageKey);
        ws.close();
      }
    }
    render();
    if (revealReady) $('ready-panel').scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
  });
  ws.addEventListener('error', () => {
    if (socket !== ws) return;
    connectionCheckStatus(connectionFailure(base), true);
    notify('无法连接，请查看“检测连接”下方的排查提示', true);
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    clearTimeout(connectionTimer);
    connecting = false;
    movePending = false;
    actionSending = false;
    selected = null;
    if (!room) $('network-status').textContent = '连接未建立，可以重新创建或加入房间。';
    else notify('连接已断开，点击“恢复上次房间”继续', true);
    render();
  });
  render();
}

$('restart').addEventListener('click', () => {
  if (room) { cancelAssist(); roomControls.open(); render(); return; }
  cancelAi();
  game = createInitialGame();
  if (!aiHumanSide) localGame = game;
  sandbox = null;
  selected = null;
  notify('新对局开始，红方先行');
  render();
  if (aiHumanSide) void playAiMove();
});
$('undo').addEventListener('click', () => {
  if (room) return requestAction('undo');
  if (aiHumanSide) {
    const count = aiUndoCount(game, aiHumanSide);
    if (!count) return;
    cancelAi();
    for (let i = 0; i < count; i++) game = undoMove(game);
    if (sandbox) sandbox = createSandbox(game, null);
    selected = null;
    notify('已撤回你的上一步，轮到你重新走棋');
    render();
    return;
  }
  game = localGame = undoMove(localGame);
  if (sandbox) sandbox = createSandbox(game, null);
  selected = null;
  notify('已悔棋一步');
  render();
});
$('draw').addEventListener('click', () => requestAction('draw'));
$('resign').addEventListener('click', () => {
  if (!aiHumanSide) return requestAction('resign');
  if (game.result) return;
  cancelAi();
  game = { ...game, result: { winner: aiHumanSide === 'red' ? 'black' : 'red', loser: aiHumanSide, reason: 'resignation' } };
  sandbox = null;
  selected = null;
  notify(resultDescription(game.result));
  render();
});
function requestAction(action) {
  if (!room) return;
  actionSending = true;
  if (!sandbox) selected = null;
  send({ type: 'action-request', action, revision: room.revision });
  notify(`已发起${ACTION_NAMES[action]}，等待投票；暂不可落子，${timingStatus()}`);
  render();
}
$('sandbox-toggle').addEventListener('click', () => {
  if (sandbox) {
    sandbox = null;
    notify('已退出沙盘，回到最新真实棋局');
  } else {
    sandbox = createSandbox(game, room?.revision ?? null);
    notify('');
  }
  selected = null;
  render();
});
$('sandbox-undo').addEventListener('click', () => {
  if (!sandbox) return;
  sandbox = sandboxUndo(sandbox);
  selected = null;
  notify(`沙盘已撤销一步，轮到${SIDE_NAMES[sandbox.game.turn]}；剩余推演 ${sandbox.game.history.length} 步`);
  render();
});
for (const id of ['danger-toggle', 'captures-toggle']) $(id).addEventListener('change', render);
// Appearance updates happen locally in another module. Keep captured glyphs in the same skin.
new MutationObserver(() => {
  if ($('captures-toggle').checked) render();
}).observe($('board'), { attributes: true, attributeFilter: ['data-skin'] });
$('flip').addEventListener('click', () => { flipped = !flipped; render(); });
$('local').addEventListener('click', () => {
  cancelAi();
  disconnectRoom();
  aiHumanSide = null;
  game = localGame;
  selected = null;
  flipped = false;
  $('network-status').textContent = '已返回同机双人，上次联机房间可以恢复。';
  notify('同机双人，按回合落子');
  render();
});
$('create').addEventListener('click', () => {
  const timed = $('timed-toggle').checked;
  let timeControl, moveTimeMs;
  try {
    timeControl = timed ? readTimes(document) : undefined;
    moveTimeMs = readMoveTime(document, '', timed);
  } catch (error) { notify(error.message, true); return; }
  connect({ type: 'create', timeControl, timed, moveTimeMs });
});
$('join').addEventListener('click', () => {
  const code = $('room-code').value.trim().toUpperCase();
  if (!/^[A-F0-9]{6}$/.test(code)) return notify('请输入完整的 6 位房间码', true);
  connect({ type: 'join', code });
});
$('resume').addEventListener('click', () => {
  const saved = savedSeat();
  if (saved) connect({ type: 'resume', code: saved.code, token: saved.token }, saved.base);
});
function answerVote(accept) {
  const request = pendingVote();
  if (!request || request.side === side) return;
  actionSending = true;
  send(request.action === 'restart'
    ? { type: 'restart-answer', requestId: request.id, accept }
    : { type: 'action-answer', requestId: request.id, accept });
  renderVote();
}
$('accept').addEventListener('click', () => answerVote(true));
$('decline').addEventListener('click', () => answerVote(false));
$('result-dismiss').addEventListener('click', closeResult);
$('result-summary').addEventListener('click', openResult);
window.addEventListener('keydown', (event) => {
  if ($('restart-config').open) return;
  if ($('result-overlay').hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeResult();
  } else if (event.key === 'Tab' && !pendingVote()) {
    event.preventDefault();
    $('result-dismiss').focus({ preventScroll: true });
  }
});

// A modeless, small voting window: move by pointer or with the keyboard-friendly button.
let voteDrag = null;
const popup = $('vote-popup');
const header = $('vote-header');
function placeVote(left, top) {
  const bounds = popup.getBoundingClientRect();
  popup.style.left = `${Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8))}px`;
  popup.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8))}px`;
  popup.style.right = 'auto';
  popup.style.bottom = 'auto';
}
header.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const bounds = popup.getBoundingClientRect();
  voteDrag = { pointerId: event.pointerId, dx: event.clientX - bounds.left, dy: event.clientY - bounds.top };
  header.setPointerCapture(event.pointerId);
});
header.addEventListener('pointermove', (event) => {
  if (voteDrag?.pointerId === event.pointerId) placeVote(event.clientX - voteDrag.dx, event.clientY - voteDrag.dy);
});
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  header.addEventListener(eventName, () => { voteDrag = null; });
}
$('vote-position').addEventListener('click', () => {
  const bounds = popup.getBoundingClientRect();
  if (window.innerWidth < bounds.width * 2 + 32) {
    placeVote(bounds.left, bounds.top > (window.innerHeight - bounds.height) / 2 ? 8 : window.innerHeight - bounds.height - 8);
  } else {
    placeVote(bounds.left > (window.innerWidth - bounds.width) / 2 ? 8 : window.innerWidth - bounds.width - 8, bounds.top);
  }
});
window.addEventListener('resize', () => {
  if (popup.hidden || !popup.style.left) return;
  const bounds = popup.getBoundingClientRect();
  placeVote(bounds.left, bounds.top);
});
$('server').value = location.origin;
async function refreshAddresses() {
  const button = $('refresh-addresses');
  button.disabled = true;
  $('addresses').textContent = '正在读取房主网卡…';
  $('other-addresses').replaceChildren();
  $('other-networks').hidden = true;
  try {
    const response = await fetch('/api/server-info');
    if (!response.ok) throw new Error('无法读取服务器网卡');
    const { addresses = [], candidates = addresses.map((url) => ({ url, interfaceName: '未识别网卡', kind: 'unknown' })) } = await response.json();
    $('addresses').replaceChildren();
    for (const candidate of candidates) {
      const item = document.createElement('li');
      item.className = 'network-address';
      const label = document.createElement('label');
      const kind = candidate.recommended ? 'Wi-Fi / 有线，优先尝试' : candidate.kind === 'virtual' ? 'VPN / 虚拟网络' : '网卡类型待确认';
      label.textContent = `${candidate.interfaceName} · ${kind}${candidate.accessed ? ' · 当前访问路径' : ''}`;
      const input = document.createElement('input');
      input.type = 'text';
      input.readOnly = true;
      input.value = candidate.url;
      input.addEventListener('click', () => input.select());
      label.append(input);
      item.append(label);
      $(candidate.kind === 'virtual' ? 'other-addresses' : 'addresses').append(item);
    }
    $('other-networks').hidden = !candidates.some((candidate) => candidate.kind === 'virtual');
    if (!candidates.some((candidate) => candidate.kind !== 'virtual')) $('addresses').textContent = '未找到 Wi-Fi / 有线地址。请确认房主已联网且服务允许局域网访问。';
  } catch {
    $('addresses').textContent = '无法读取房主网卡，请确认提供此页面的服务器仍在运行，再刷新。';
  } finally {
    button.disabled = false;
  }
}
$('refresh-addresses').addEventListener('click', () => { void refreshAddresses(); });
void refreshAddresses();
render();
void checkAi();
setInterval(() => { if (renderClocks()) render(); }, 100);
const saved = savedSeat();
if (saved && saved.base === location.origin) connect({ type: 'resume', code: saved.code, token: saved.token }, saved.base);
