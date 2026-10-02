import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { applyMove, createInitialGame, otherSide, undoMove } from '../shared/rules.js';
import { parseTimeControl, createClock, startClock, settleClock, clockSnapshot } from './clock.js';

export function attachRooms(wss, { now = () => performance.now(), clockTickMs = 1000 } = {}) {
  const rooms = new Map();
  const sessions = new WeakMap();
  const send = (socket, message) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const fail = (socket, error) => send(socket, { type: 'error', error });
  const online = (seat) => seat?.socket?.readyState === WebSocket.OPEN;
  const snapshot = (room, at) => ({
    code: room.code, game: room.game, revision: room.revision,
    players: { red: online(room.red), black: online(room.black) },
    pendingRestart: room.pendingRestart,
    pendingAction: room.pendingAction,
    clock: clockSnapshot(room.clock, at),
  });
  function updateClock(room, at) {
    const loser = settleClock(room.clock, at);
    if (!loser || room.game.result) return false;
    room.game = { ...room.game, result: { winner: otherSide(loser), loser, reason: 'timeout' } };
    room.pendingAction = null;
    room.revision++;
    room.updated = Date.now();
    return true;
  }
  const broadcast = (room, at = now()) => {
    updateClock(room, at);
    const message = { type: 'state', room: snapshot(room, at) };
    send(room.red?.socket, message);
    send(room.black?.socket, message);
  };

  function assignSeat(socket, room, side, seat) {
    const previous = seat.socket;
    seat.socket = socket;
    room[side] = seat;
    room.updated = Date.now();
    sessions.set(socket, { room, side });
    send(socket, { type: 'seat', code: room.code, side, token: seat.token });
    if (previous && previous !== socket) previous.close(1000, 'Session resumed elsewhere');
    if (!room.clock.started && online(room.red) && online(room.black)) startClock(room.clock, room.game.turn, now());
    broadcast(room);
  }

  function enterRoom(socket, message) {
    if (sessions.has(socket)) return fail(socket, '你已经在房间内，请先退出');
    if (message.type === 'create') {
      if (rooms.size >= 100) return fail(socket, '房间已满，请稍后再试');
      const settings = parseTimeControl(message.timeControl);
      if (!settings.ok) return fail(socket, settings.error);
      let code;
      do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
      const room = {
        code, game: createInitialGame(), revision: 0, pendingRestart: null, pendingAction: null, updated: Date.now(),
        clock: createClock(settings.timeControl),
      };
      rooms.set(code, room);
      return assignSeat(socket, room, 'red', { token: randomBytes(24).toString('hex') });
    }
    const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
    const room = rooms.get(code);
    if (!room) return fail(socket, '房间不存在或已过期');
    if (message.type === 'join') {
      if (room.black) return fail(socket, '房间已有两名玩家');
      return assignSeat(socket, room, 'black', { token: randomBytes(24).toString('hex') });
    }
    const side = typeof message.token === 'string'
      ? ['red', 'black'].find((color) => room[color] && room[color].token === message.token) : null;
    if (!side) return fail(socket, '无法恢复席位，请检查服务器地址或重新建房');
    assignSeat(socket, room, side, room[side]);
  }

  function play(socket, message) {
    const session = sessions.get(socket);
    if (!session) return fail(socket, '请先创建或加入房间');
    const { room, side } = session;
    if (room[side].socket !== socket) return fail(socket, '这个席位已在其他页面恢复');
    room.updated = Date.now();
    // Charge the active player before validating any request or changing the turn.
    // Every action shares this timestamp, so agreement cannot erase thinking time.
    const at = now();
    if (updateClock(room, at)) broadcast(room, at);
    if (message.type === 'move') {
      if (room.game.result) return fail(socket, '本局已结束，请双方同意后重新开局');
      if (!room.clock.started) return fail(socket, '等待双方连接后再操作');
      if (room.game.turn !== side) return fail(socket, '还没有轮到你');
      if (message.revision !== room.revision) {
        send(socket, { type: 'state', room: snapshot(room, now()) });
        return fail(socket, '棋盘已更新，请重新选择棋子');
      }
      const result = applyMove(room.game, message.from, message.to);
      if (!result.ok) return fail(socket, result.error);
      room.game = result.game;
      room.revision++;
      room.pendingAction = null;
      room.clock.runningSide = room.game.result ? null : room.game.turn;
      room.clock.changedAt = at;
    } else if (message.type === 'action-request') {
      if (!online(room.red) || !online(room.black) || !room.clock.started) return fail(socket, '等待双方连接后再操作');
      if (!['undo', 'draw', 'resign'].includes(message.action)
        || !Number.isSafeInteger(message.revision) || message.revision < 0) return fail(socket, '协商请求格式错误');
      if (message.revision !== room.revision) {
        send(socket, { type: 'state', room: snapshot(room, at) });
        return fail(socket, '棋盘已更新，请重新发起请求');
      }
      if (room.pendingAction || room.pendingRestart) return fail(socket, '已有等待对方回应的请求');
      if (message.action === 'undo') {
        if (!room.game.history.length) return fail(socket, '没有可以悔棋的落子');
        if (room.game.result && !['checkmate', 'stalemate', 'general-captured'].includes(room.game.result.reason)) {
          return fail(socket, '本局已结束，无法悔棋，请双方同意后重新开局');
        }
      } else if (room.game.result) return fail(socket, '本局已结束，请双方同意后重新开局');
      room.pendingAction = { id: randomBytes(12).toString('hex'), action: message.action, side, revision: room.revision };
    } else if (message.type === 'action-answer') {
      if (!online(room.red) || !online(room.black) || !room.clock.started) return fail(socket, '等待双方连接后再操作');
      if (typeof message.requestId !== 'string' || typeof message.accept !== 'boolean') return fail(socket, '协商回复格式错误');
      const request = room.pendingAction;
      if (!request || request.id !== message.requestId || request.revision !== room.revision) return fail(socket, '请求已失效，请查看最新棋盘');
      if (request.side === side) return fail(socket, '没有需要你回应的请求');
      if (message.accept) {
        if (request.action === 'undo') room.game = undoMove(room.game);
        else {
          const result = request.action === 'draw'
            ? { winner: null, loser: null, reason: 'draw' }
            : { winner: otherSide(request.side), loser: request.side, reason: 'resignation' };
          room.game = { ...room.game, result };
        }
        room.revision++;
        room.clock.runningSide = room.game.result ? null : room.game.turn;
        room.clock.changedAt = at;
      }
      room.pendingAction = null;
    } else if (message.type === 'restart-request') {
      if (!online(room.red) || !online(room.black)) return fail(socket, '等待双方连接后再操作');
      if (room.pendingRestart) return fail(socket, '已有重新开局请求');
      if (room.pendingAction) return fail(socket, '已有等待对方回应的请求');
      room.pendingRestart = side;
    } else if (message.type === 'restart-answer') {
      if (!online(room.red) || !online(room.black)) return fail(socket, '等待双方连接后再操作');
      if (!room.pendingRestart || room.pendingRestart === side) return fail(socket, '没有需要你回应的请求');
      if (typeof message.accept !== 'boolean') return fail(socket, '重新开局回复格式错误');
      if (message.accept) {
        room.game = createInitialGame();
        room.revision++;
        room.clock = createClock(room.clock.initialMs);
        startClock(room.clock, 'red', at);
        room.pendingAction = null;
      }
      room.pendingRestart = null;
    } else {
      return fail(socket, '不支持的操作');
    }
    broadcast(room, at);
  }

  wss.on('connection', (socket) => {
    socket.alive = true;
    socket.on('pong', () => { socket.alive = true; });
    socket.on('error', () => {});
    socket.on('message', (data, isBinary) => {
      if (isBinary) return fail(socket, '消息必须是 JSON 文本');
      let message;
      try { message = JSON.parse(data.toString()); } catch { return fail(socket, '消息格式错误'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return fail(socket, '消息格式错误');
      if (['create', 'join', 'resume'].includes(message.type)) enterRoom(socket, message);
      else play(socket, message);
    });
    socket.on('close', () => {
      const session = sessions.get(socket);
      if (!session || session.room[session.side].socket !== socket) return;
      session.room[session.side].socket = null;
      session.room.updated = Date.now();
      broadcast(session.room);
    });
  });

  const timer = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.alive) socket.terminate();
      else { socket.alive = false; socket.ping(); }
    }
    for (const [code, room] of rooms) {
      if (!online(room.red) && !online(room.black) && !room.clock.runningSide
        && Date.now() - room.updated > 30 * 60_000) rooms.delete(code);
    }
  }, 30_000);
  // Tick messages update displays only. A deadline is also checked before every action.
  const clockTimer = setInterval(() => {
    const at = now();
    for (const room of rooms.values()) {
      if (!room.clock.runningSide) continue;
      if (updateClock(room, at)) broadcast(room, at);
      else {
        const message = { type: 'clock', code: room.code, revision: room.revision, clock: clockSnapshot(room.clock, at) };
        send(room.red?.socket, message);
        send(room.black?.socket, message);
      }
    }
  }, clockTickMs);
  timer.unref();
  clockTimer.unref();
  wss.on('close', () => { clearInterval(timer); clearInterval(clockTimer); });
}
