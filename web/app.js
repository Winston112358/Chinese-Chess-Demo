import { createInitialGame, applyMove, undoMove, legalMoves, isInCheck, pieceAt, PIECE_NAMES, SIDE_NAMES } from '/shared/rules.js';
import { renderBoard } from '/board.js';

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
const storageKey = 'xiangqi-last-room';

function savedSeat() {
  try { return JSON.parse(sessionStorage.getItem(storageKey)); } catch { return null; }
}

function notify(message, error = false) {
  $('message').textContent = message;
  $('message').classList.toggle('error', error);
}

function render() {
  const ready = !room || (room.players.red && room.players.black && socket?.readyState === WebSocket.OPEN);
  $('mode').textContent = room ? `局域网 · 你是${SIDE_NAMES[side]}` : '同机双人';
  $('turn').textContent = `${SIDE_NAMES[game.turn]}走棋 · 已走 ${game.history.length} 步${isInCheck(game.board, game.turn) ? ' · 将军！请应将' : ''}`;
  $('turn').className = `turn ${game.turn}`;
  $('undo').disabled = Boolean(room) || !game.history.length || connecting;
  $('restart').disabled = connecting || (room && (!ready || Boolean(room.pendingRestart)));
  $('local').hidden = !room && !connecting;
  $('create').disabled = Boolean(room) || connecting;
  $('join').disabled = Boolean(room) || connecting;
  $('server').disabled = Boolean(room) || connecting;
  $('room-code').disabled = Boolean(room) || connecting;
  $('resume').hidden = !savedSeat() || Boolean(room);
  $('resume').disabled = connecting;
  $('restart-request').hidden = !room?.pendingRestart || room.pendingRestart === side;
  if (room) {
    const connected = socket?.readyState === WebSocket.OPEN;
    $('network-status').textContent = `房间码：${room.code}\n${connected ? (ready ? '双方已连接，可以对弈' : '等待对手连接；棋盘已暂停') : '连接已断开，请恢复房间'}${room.pendingRestart === side ? '\n已请求重新开局，等待对手回应' : ''}`;
    $('resume').hidden = connected;
  }
  renderBoard($('board'), {
    game, selected, flipped,
    canSelect: ready && !connecting && !movePending && !room?.pendingRestart && (!room || game.turn === side),
    moves: selected ? legalMoves(game, selected) : [],
    onClick: clickPoint,
  });
  const captured = game.history.filter((move) => move.captured);
  $('captures').textContent = captured.length ? captured.map((move) => `${SIDE_NAMES[move.captured.side]}${PIECE_NAMES[move.captured.side][move.captured.type]}`).join('、') : '尚未吃子';
  $('history').replaceChildren();
  game.history.forEach((move) => {
    const item = document.createElement('li');
    item.textContent = `${SIDE_NAMES[move.piece.side]}${PIECE_NAMES[move.piece.side][move.piece.type]} (${move.from.x + 1},${move.from.y + 1}) → (${move.to.x + 1},${move.to.y + 1})${move.captured ? ` 吃${PIECE_NAMES[move.captured.side][move.captured.type]}` : ''}`;
    $('history').append(item);
  });
  $('history').scrollTop = $('history').scrollHeight;
}

function clickPoint(point) {
  if (connecting || movePending) return notify('请等待服务器回应', true);
  if (room && (!room.players.red || !room.players.black || socket?.readyState !== WebSocket.OPEN)) return notify('等待双方连接后再落子', true);
  if (room?.pendingRestart) return notify('请先处理重新开局请求', true);
  if (room && game.turn !== side) return notify('现在是对手的回合', true);
  const piece = pieceAt(game.board, point);
  if (piece?.side === game.turn) {
    selected = selected?.x === point.x && selected?.y === point.y ? null : point;
    notify(selected ? `已选择${PIECE_NAMES[piece.side][piece.type]}，请选择落点` : '已取消选择');
    render();
    return;
  }
  if (!selected) return notify('请先选择当前回合的棋子', true);
  const result = applyMove(game, selected, point);
  if (!result.ok) return notify(result.error, true);
  if (room) {
    movePending = true;
    send({ type: 'move', from: selected, to: point, revision: room.revision });
    render();
  } else {
    game = localGame = result.game;
    selected = null;
    notify('落子成功，轮到对方');
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
      room = message.room;
      game = room.game;
      connecting = false;
      movePending = false;
      selected = null;
      notify(room.players.red && room.players.black ? '棋盘已同步，按回合落子' : '等待好友加入房间');
    } else if (message.type === 'error') {
      connecting = false;
      movePending = false;
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
    selected = null;
    if (!room) $('network-status').textContent = '连接未建立，可以重新创建或加入房间。';
    else notify('连接已断开，点击“恢复上次房间”继续', true);
    render();
  });
  render();
}

$('restart').addEventListener('click', () => {
  if (room) { send({ type: 'restart-request' }); return; }
  game = localGame = createInitialGame();
  selected = null;
  notify('新对局开始，红方先行');
  render();
});
$('undo').addEventListener('click', () => { game = localGame = undoMove(localGame); selected = null; notify('已悔棋一步'); render(); });
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
  game = localGame;
  selected = null;
  flipped = false;
  $('network-status').textContent = '已返回同机双人，上次联机房间可以恢复。';
  notify('同机双人，按回合落子');
  render();
});
$('create').addEventListener('click', () => connect({ type: 'create' }));
$('join').addEventListener('click', () => {
  const code = $('room-code').value.trim().toUpperCase();
  if (!/^[A-F0-9]{6}$/.test(code)) return notify('请输入完整的 6 位房间码', true);
  connect({ type: 'join', code });
});
$('resume').addEventListener('click', () => {
  const saved = savedSeat();
  if (saved) connect({ type: 'resume', code: saved.code, token: saved.token }, saved.base);
});
$('accept').addEventListener('click', () => send({ type: 'restart-answer', accept: true }));
$('decline').addEventListener('click', () => send({ type: 'restart-answer', accept: false }));
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
const saved = savedSeat();
if (saved && saved.base === location.origin) connect({ type: 'resume', code: saved.code, token: saved.token }, saved.base);
