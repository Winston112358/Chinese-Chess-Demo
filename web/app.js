import { createInitialGame, applyMove, validateMove, undoMove, legalMoves, isInCheck, pieceAt, PIECE_NAMES, SIDE_NAMES } from '/shared/rules.js';
import { renderBoard } from '/board.js';
import { createSandbox, rebaseSandbox, sandboxApplyMove, sandboxUndo } from '/shared/sandbox.js';
import { dangerousPieces } from '/shared/analysis.js';
import { renderCaptured } from '/game-tools.js';

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
let sandbox = null;
let actionSending = false;
let dangerCache = { board: null, side: null, points: [] };
const storageKey = 'xiangqi-last-room';
const ACTION_NAMES = { undo: '单步悔棋', draw: '求和', resign: '认输', restart: '重新开局' };

function savedSeat() {
  try { return JSON.parse(sessionStorage.getItem(storageKey)); } catch { return null; }
}

function notify(message, error = false) {
  $('message').textContent = message;
  $('message').classList.toggle('error', error);
}

function resultDescription(result) {
  if (result.reason === 'draw') return '双方同意和棋，对局结束。';
  const reasons = {
    checkmate: `${SIDE_NAMES[result.loser]}被将死`,
    stalemate: `${SIDE_NAMES[result.loser]}无合法着法（困毙）`,
    'general-captured': `${SIDE_NAMES[result.loser]}将帅被吃`,
    timeout: `${SIDE_NAMES[result.loser]}超时`,
    resignation: `${SIDE_NAMES[result.loser]}认输（双方已同意）`,
  };
  return `${SIDE_NAMES[result.winner]}获胜：${reasons[result.reason] || '对局结束'}。`;
}

function resultKey(result) {
  return result ? `${result.winner}:${result.loser}:${result.reason}` : '';
}

function formatTime(milliseconds) {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderClocks() {
  const clock = room?.clock;
  $('clock-panel').hidden = !clock;
  if (!clock) return;
  const elapsed = Math.max(0, performance.now() - clockReceivedAt);
  let awaitingResult = false;
  for (const color of ['red', 'black']) {
    const running = clock.runningSide === color && !game.result;
    const remaining = Math.max(0, clock.remainingMs[color] - (running ? elapsed : 0));
    const text = formatTime(remaining);
    if ($(`time-${color}`).textContent !== text) $(`time-${color}`).textContent = text;
    $(`clock-${color}`).classList.toggle('running', running);
    $(`clock-${color}`).classList.toggle('low', clock.started && !game.result && remaining <= 60_000);
    if (running && remaining === 0) awaitingResult = true;
  }
  const minutes = (milliseconds) => String(Number((milliseconds / 60_000).toFixed(2)));
  const summary = `房间时限：红方 ${minutes(clock.initialMs.red)} 分钟 · 黑方 ${minutes(clock.initialMs.black)} 分钟`;
  if ($('time-control-summary').textContent !== summary) $('time-control-summary').textContent = summary;
  let info;
  if (game.result) info = '对局已结束，计时停止。双方同意重新开局后恢复本房间时限。';
  else if (!clock.started) info = '等待双方首次连接，尚未开钟；红方先走。';
  else if (socket?.readyState !== WebSocket.OPEN) info = '连接已断开，计时继续；恢复房间后同步剩余时间。';
  else if (awaitingResult) info = '剩余时间已到零，等待服务器确认对局结果。';
  else info = `${SIDE_NAMES[clock.runningSide || game.turn]}计时中；沙盘、协商与断线均不停钟。`;
  if ($('clock-info').textContent !== info) $('clock-info').textContent = info;
}

function pendingVote() {
  return room?.pendingAction || (room?.pendingRestart ? { action: 'restart', side: room.pendingRestart } : null);
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
    restart: '同意后重置真实棋局和双方时间，红方先行。',
  };
  $('vote-description').textContent = explanation[request.action];
  $('vote-wait').hidden = !own;
  $('vote-wait').textContent = game.result ? '等待对手投票；本局计时已停止。' : '等待对手投票；暂不可落子，计时继续。';
  $('vote-buttons').hidden = own;
  $('accept').disabled = $('decline').disabled = actionSending || connecting
    || socket?.readyState !== WebSocket.OPEN || !room.players.red || !room.players.black;
}

function dangerPoints(view) {
  if (!$('danger-toggle').checked || view.result) return [];
  const color = side || view.turn;
  if (dangerCache.board !== view.board || dangerCache.side !== color) {
    dangerCache = { board: view.board, side: color, points: dangerousPieces(view, color) };
  }
  return dangerCache.points;
}

function render() {
  const connected = socket?.readyState === WebSocket.OPEN;
  const bothOnline = room?.players.red && room?.players.black;
  const ready = !room || (room.clock?.started && connected);
  const view = sandbox?.game || game;
  const request = pendingVote();
  const canNegotiate = Boolean(room && connected && bothOnline && room.clock?.started && !connecting && !actionSending && !request);
  $('mode').textContent = room ? `局域网 · 你是${SIDE_NAMES[side]}` : '同机双人';
  $('turn').textContent = sandbox
    ? `沙盘 · ${view.result ? '推演结束' : `${SIDE_NAMES[view.turn]}走棋`} · 已推演 ${view.history.length} 步`
    : game.result ? `对局结束 · 已走 ${game.history.length} 步` : `${SIDE_NAMES[game.turn]}走棋 · 已走 ${game.history.length} 步${isInCheck(game.board, game.turn) ? ' · 将军！请应将' : ''}`;
  $('turn').className = `turn ${view.result?.winner || view.turn}`;
  if (!sandbox && request && !game.result) $('turn').textContent += ' · 等待投票';
  $('game-result').hidden = !game.result;
  $('game-result').textContent = game.result ? resultDescription(game.result) : '';
  const undoable = !game.result || ['checkmate', 'stalemate', 'general-captured'].includes(game.result.reason);
  $('undo').textContent = room ? '请求单步悔棋' : '悔棋一步';
  $('undo').disabled = !game.history.length || !undoable || connecting || (room && !canNegotiate);
  $('draw').disabled = $('resign').disabled = !canNegotiate || Boolean(game.result);
  $('restart').disabled = connecting || (room && (!connected || !bothOnline || actionSending || Boolean(request)));
  $('sandbox-toggle').textContent = sandbox ? '退出沙盘' : '进入沙盘';
  $('sandbox-toggle').setAttribute('aria-pressed', String(Boolean(sandbox)));
  $('sandbox-toggle').disabled = !sandbox && (!ready || connecting || movePending || Boolean(game.result));
  $('sandbox-undo').hidden = !sandbox;
  $('sandbox-undo').disabled = !sandbox?.game.history.length;
  $('sandbox-banner').hidden = !sandbox;
  $('board').classList.toggle('sandbox-board', Boolean(sandbox));
  if (sandbox) {
    const real = game.result ? resultDescription(game.result) : request
      ? `真实棋局：等待投票，${SIDE_NAMES[game.turn]}计时中。`
      : `真实棋局：${SIDE_NAMES[game.turn]}走棋，计时继续。`;
    const analysis = view.result ? `推演结果：${resultDescription(view.result)}` : `${SIDE_NAMES[view.turn]}走棋${isInCheck(view.board, view.turn) ? ' · 将军' : ''}。`;
    $('sandbox-banner').textContent = `沙盘模式 · ${analysis} ${real}`;
  }
  $('local').hidden = !room && !connecting;
  $('create').disabled = Boolean(room) || connecting;
  $('join').disabled = Boolean(room) || connecting;
  $('server').disabled = Boolean(room) || connecting;
  $('room-code').disabled = Boolean(room) || connecting;
  $('time-settings').disabled = Boolean(room) || connecting;
  $('time-settings').hidden = Boolean(room);
  $('resume').hidden = !savedSeat() || Boolean(room);
  $('resume').disabled = connecting;
  renderVote();
  if (room) {
    let status;
    if (!connected) status = `连接已断开，请恢复房间${room.clock?.started && !game.result ? '；计时继续' : ''}`;
    else if (game.result) status = `对局已结束${bothOnline ? '，可双方同意重新开局' : '，等待对手重连后重新开局'}`;
    else if (!room.clock?.started) status = '等待好友首次连接；尚未开钟，不能落子';
    else if (request) status = `等待投票，暂不可落子；计时继续${bothOnline ? '' : '，等待对手重连'}`;
    else status = bothOnline ? '双方已连接，可以对弈' : '对手已断线；计时继续，你仍可在己方回合落子';
    $('network-status').textContent = `房间码：${room.code}\n${status}${request?.side === side ? `\n已请求${ACTION_NAMES[request.action]}，等待对手回应` : ''}`;
    $('resume').hidden = connected;
  }
  renderClocks();
  renderBoard($('board'), {
    game: view, selected, flipped,
    canSelect: !view.result && (sandbox ? true : ready && !connecting && !movePending && !actionSending && !request && (!room || game.turn === side)),
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
  if (room && !room.clock?.started) return notify('等待好友首次连接后开钟落子', true);
  if (room && game.turn !== side) return notify('现在是对手的回合', true);
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
  if (room) {
    movePending = true;
    send({ type: 'move', from: selected, to: point, revision: room.revision });
    render();
  } else {
    game = localGame = result.game;
    selected = null;
    notify(game.result ? resultDescription(game.result) : '落子成功，轮到对方');
    render();
  }
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) { movePending = false; notify('连接已断开，请恢复房间', true); return; }
  socket.send(JSON.stringify(message));
}

function serverBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入 http:// 或 https:// 开头的服务器地址');
  return url.origin;
}

function connect(action, address = $('server').value.trim()) {
  let base;
  try { base = serverBase(address); } catch (error) { notify(error.message, true); return; }
  if (socket) socket.close();
  clearTimeout(connectionTimer);
  connecting = true;
  movePending = false;
  actionSending = false;
  sandbox = null;
  selected = null;
  notify('正在连接房主的服务器…');
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
  let assigned = false;
  socket = ws;
  connectionTimer = setTimeout(() => {
    if (socket !== ws) return;
    ws.close();
    notify('连接超时，请检查地址、网络和防火墙', true);
  }, 8000);
  ws.addEventListener('open', () => { if (socket === ws) ws.send(JSON.stringify(action)); });
  ws.addEventListener('message', (event) => {
    if (socket !== ws) return;
    const message = JSON.parse(event.data);
    if (message.type === 'clock') {
      if (room && message.code === room.code && message.revision === room.revision) {
        room.clock = message.clock;
        clockReceivedAt = performance.now();
        renderClocks();
      }
      return;
    }
    clearTimeout(connectionTimer);
    if (message.type === 'seat') {
      assigned = true;
      side = message.side;
      flipped = side === 'black';
      $('server').value = base;
      $('room-code').value = message.code;
      try { sessionStorage.setItem(storageKey, JSON.stringify({ base, code: message.code, token: message.token })); }
      catch { notify('浏览器未允许保存席位；关闭页面后需重新建房', true); }
    } else if (message.type === 'state') {
      const previous = room;
      room = message.room;
      game = room.game;
      clockReceivedAt = performance.now();
      const positionChanged = !previous || previous.code !== room.code || previous.revision !== room.revision;
      const resultChanged = resultKey(previous?.game.result) !== resultKey(game.result);
      const wasMovePending = movePending;
      connecting = false;
      actionSending = false;
      let sandboxRebased = false;
      if (sandbox && positionChanged) {
        sandbox = rebaseSandbox(sandbox, game, room.revision);
        sandboxRebased = true;
      }
      if (sandbox && game.result) sandbox = null;
      if (positionChanged || resultChanged) movePending = false;
      if (positionChanged || game.result || (!sandbox && (!room.clock?.started || game.turn !== side || pendingVote()))) selected = null;
      if (game.result) notify(resultDescription(game.result));
      else if (sandboxRebased) notify('真实棋局已更新，沙盘推演已重置');
      else if (positionChanged) notify(room.clock?.started ? (wasMovePending ? '落子成功，轮到对方' : '棋盘已同步，按回合落子') : '等待好友加入房间，尚未开钟');
      else if (previous?.pendingAction && !room.pendingAction) notify('协商已处理，继续正常对局');
      else if (previous.players.red !== room.players.red || previous.players.black !== room.players.black) {
        notify(pendingVote() ? '等待投票，暂不可落子；计时继续' : room.players.red && room.players.black ? '双方已连接' : (room.clock?.started ? '对手已断线；计时继续，己方回合仍可落子' : '等待好友加入房间，尚未开钟'));
      } else if (previous.pendingRestart !== room.pendingRestart) {
        notify(room.pendingRestart ? '等待重新开局投票，暂不可落子；计时继续' : '重新开局请求已结束');
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
  });
  ws.addEventListener('error', () => { if (socket === ws) notify('无法连接，请检查房主地址、网络和防火墙', true); });
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
  if (room) { actionSending = true; if (!sandbox) selected = null; send({ type: 'restart-request' }); render(); return; }
  game = localGame = createInitialGame();
  sandbox = null;
  selected = null;
  notify('新对局开始，红方先行');
  render();
});
$('undo').addEventListener('click', () => {
  if (room) return requestAction('undo');
  game = localGame = undoMove(localGame);
  if (sandbox) sandbox = createSandbox(game, null);
  selected = null;
  notify('已悔棋一步');
  render();
});
$('draw').addEventListener('click', () => requestAction('draw'));
$('resign').addEventListener('click', () => requestAction('resign'));
function requestAction(action) {
  if (!room) return;
  actionSending = true;
  if (!sandbox) selected = null;
  send({ type: 'action-request', action, revision: room.revision });
  notify(`已发起${ACTION_NAMES[action]}，等待投票；暂不可落子，计时继续`);
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
  game = localGame;
  selected = null;
  flipped = false;
  $('network-status').textContent = '已返回同机双人，上次联机房间可以恢复。';
  notify('同机双人，按回合落子');
  render();
});
function readTimeControl() {
  const timeControl = {};
  for (const color of ['red', 'black']) {
    const choice = $(`${color}-time-choice`).value;
    const input = $(`${color}-time-custom`);
    const value = choice === 'custom' ? input.value.trim() : choice;
    const minutes = Number(value);
    if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(value) || minutes < 0.1 || minutes > 180) {
      input.focus();
      throw new Error(`${SIDE_NAMES[color]}总时间请输入 0.1–180 分钟，最多两位小数`);
    }
    timeControl[color] = Math.round(minutes * 60_000);
  }
  return timeControl;
}
for (const color of ['red', 'black']) {
  $(`${color}-time-choice`).addEventListener('change', () => {
    const custom = $(`${color}-time-choice`).value === 'custom';
    $(`${color}-custom-label`).hidden = !custom;
    if (custom) $(`${color}-time-custom`).focus();
  });
}
$('create').addEventListener('click', () => {
  let timeControl;
  try { timeControl = readTimeControl(); } catch (error) { notify(error.message, true); return; }
  connect({ type: 'create', timeControl });
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
    ? { type: 'restart-answer', accept }
    : { type: 'action-answer', requestId: request.id, accept });
  renderVote();
}
$('accept').addEventListener('click', () => answerVote(true));
$('decline').addEventListener('click', () => answerVote(false));

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
fetch('/api/server-info').then((response) => response.json()).then(({ addresses }) => {
  for (const address of addresses) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = address;
    link.textContent = address;
    item.append(link);
    $('addresses').append(item);
  }
  if (!addresses.length) $('addresses').textContent = '未找到可用的局域网地址';
}).catch(() => { $('addresses').textContent = '无法读取本机地址'; });
render();
setInterval(renderClocks, 100);
const saved = savedSeat();
if (saved && saved.base === location.origin) connect({ type: 'resume', code: saved.code, token: saved.token }, saved.base);
