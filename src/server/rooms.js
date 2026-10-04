import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { applyMove, createInitialGame, otherSide, undoMove, canUndoResult } from '../shared/rules.js';
import { parseTimeControl, parseMoveTime, createClock, startClock, settleClock, clockSnapshot } from './clock.js';
import { parseRoundConfig, START_COUNTDOWN_MS } from './round.js';

export function attachRooms(wss, { now = () => performance.now(), clockTickMs = 1000, countdownMs = START_COUNTDOWN_MS } = {}) {
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
    round: room.round, phase: room.phase, ready: { ...room.ready },
    countdownMs: room.phase === 'countdown' ? Math.max(0, room.countdownEndsAt - at) : null,
    clock: clockSnapshot(room.clock, at),
  });
  function updateClock(room, at) {
    const loser = settleClock(room.clock, at);
    if (!loser || room.game.result) return false;
    room.game = { ...room.game, result: { winner: otherSide(loser), loser, reason: room.clock.timeoutReason } };
    room.pendingAction = null;
    room.pendingRestart = null;
    room.revision++;
    room.updated = Date.now();
    return true;
  }
  function advanceRound(room, at) {
    if (room.phase !== 'countdown' || at < room.countdownEndsAt) return false;
    clearTimeout(room.countdownTimer);
    room.countdownTimer = null;
    room.phase = 'playing';
    startClock(room.clock, room.game.turn, at);
    return true;
  }
  const broadcast = (room, at = now()) => {
    advanceRound(room, at);
    updateClock(room, at);
    const message = { type: 'state', room: snapshot(room, at) };
    send(room.red?.socket, message);
    send(room.black?.socket, message);
  };

  function countdown(room, at) {
    room.phase = 'countdown';
    room.countdownEndsAt = at + countdownMs;
    const finish = () => {
      if (room.phase !== 'countdown') return;
      const remaining = room.countdownEndsAt - now();
      if (remaining > 0) room.countdownTimer = setTimeout(finish, remaining);
      else broadcast(room);
      room.countdownTimer?.unref();
    };
    room.countdownTimer = setTimeout(finish, countdownMs);
    room.countdownTimer.unref();
  }

  function sendSeat(room, color) {
    const seat = room[color];
    if (!seat) return;
    if (seat.socket) sessions.set(seat.socket, { room, side: color });
    send(seat.socket, { type: 'seat', code: room.code, side: color, token: seat.token });
  }

  function resetRound(room, config) {
    clearTimeout(room.countdownTimer);
    if (config.redSide === 'black') [room.red, room.black] = [room.black, room.red];
    room.game = createInitialGame();
    room.revision++;
    room.round++;
    room.clock = createClock(config.timeControl, config.timed, config.moveTimeMs);
    room.phase = 'preparing';
    room.ready = { red: false, black: false };
    room.countdownEndsAt = null;
    room.countdownTimer = null;
    room.pendingAction = null;
    room.pendingRestart = null;
    sendSeat(room, 'red');
    sendSeat(room, 'black');
  }

  function assignSeat(socket, room, side, seat) {
    const previous = seat.socket;
    seat.socket = socket;
    room[side] = seat;
    room.updated = Date.now();
    sessions.set(socket, { room, side });
    send(socket, { type: 'seat', code: room.code, side, token: seat.token });
    if (previous && previous !== socket) previous.close(1000, 'Session resumed elsewhere');
    broadcast(room);
  }

  function enterRoom(socket, message) {
    if (sessions.has(socket)) return fail(socket, '你已经在房间内，请先退出');
    if (message.type === 'create') {
      if (rooms.size >= 100) return fail(socket, '房间已满，请稍后再试');
      const settings = parseTimeControl(message.timeControl);
      if (!settings.ok) return fail(socket, settings.error);
      if (message.timed !== undefined && typeof message.timed !== 'boolean') return fail(socket, '计时设置格式错误');
      const moveTime = parseMoveTime(message.timed === false ? null : message.moveTimeMs);
      if (!moveTime.ok) return fail(socket, moveTime.error);
      let code;
      do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
      const room = {
        code, game: createInitialGame(), revision: 0, pendingRestart: null, pendingAction: null, updated: Date.now(),
        clock: createClock(settings.timeControl, message.timed !== false, moveTime.moveTimeMs),
        round: 0, phase: 'preparing', ready: { red: false, black: false }, countdownEndsAt: null, countdownTimer: null,
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
    if (advanceRound(room, at)) broadcast(room, at);
    if (updateClock(room, at)) broadcast(room, at);
    if (message.type === 'ready') {
      if (message.round !== room.round || typeof message.ready !== 'boolean') return fail(socket, '准备请求已失效或格式错误');
      if (room.phase !== 'preparing' || room.pendingRestart) return fail(socket, '等待准备阶段且处理完重开投票后再操作');
      room.ready[side] = message.ready;
      if (room.ready.red && room.ready.black && online(room.red) && online(room.black)) countdown(room, at);
    } else if (message.type === 'move') {
      if (room.game.result) return fail(socket, '本局已结束，请双方同意后重新开局');
      if (room.phase !== 'playing') return fail(socket, '等待双方准备和开局倒数结束后再操作');
      if (room.pendingAction || room.pendingRestart) return fail(socket, '等待投票回应，请先同意或拒绝请求后再走棋');
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
      if (room.game.result) room.clock.runningSide = null;
      else startClock(room.clock, room.game.turn, at);
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
        if (!canUndoResult(room.game.result)) {
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
        if (room.game.result) room.clock.runningSide = null;
        else startClock(room.clock, room.game.turn, at);
      }
      room.pendingAction = null;
    } else if (message.type === 'restart-request') {
      if (!online(room.red) || !online(room.black)) return fail(socket, '等待双方连接后再操作');
      if (room.pendingRestart) return fail(socket, '已有重新开局请求');
      if (room.pendingAction) return fail(socket, '已有等待对方回应的请求');
      if (room.phase === 'countdown') return fail(socket, '请等待开局倒数结束');
      if (message.revision !== undefined && message.revision !== room.revision) return fail(socket, '棋盘已更新，请重新发起请求');
      const settings = parseRoundConfig(message.config, {
        redSide: 'red', timed: room.clock.enabled, timeControl: room.clock.initialMs, moveTimeMs: room.clock.moveTimeMs,
      });
      if (!settings.ok) return fail(socket, settings.error);
      room.pendingRestart = { id: randomBytes(12).toString('hex'), action: 'restart', side, revision: room.revision, config: settings.config };
    } else if (message.type === 'restart-answer') {
      if (!online(room.red) || !online(room.black)) return fail(socket, '等待双方连接后再操作');
      const request = room.pendingRestart;
      if (!request || request.id !== message.requestId || request.revision !== room.revision) return fail(socket, '重新开局请求已失效');
      if (request.side === side) return fail(socket, '没有需要你回应的请求');
      if (typeof message.accept !== 'boolean') return fail(socket, '重新开局回复格式错误');
      if (message.accept) {
        resetRound(room, request.config);
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
      if (session.room.phase !== 'playing') {
        if (session.room.phase === 'countdown') {
          clearTimeout(session.room.countdownTimer);
          session.room.phase = 'preparing';
          session.room.countdownEndsAt = null;
          session.room.ready = { red: false, black: false };
        } else session.room.ready[session.side] = false;
      }
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
      if (advanceRound(room, at)) broadcast(room, at);
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
  wss.on('close', () => {
    clearInterval(timer);
    clearInterval(clockTimer);
    for (const room of rooms.values()) clearTimeout(room.countdownTimer);
  });
}
