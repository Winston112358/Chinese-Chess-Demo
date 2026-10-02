import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { applyMove, createInitialGame } from '../shared/rules.js';

export function attachRooms(wss) {
  const rooms = new Map();
  const sessions = new WeakMap();
  const send = (socket, message) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const fail = (socket, error) => send(socket, { type: 'error', error });
  const online = (seat) => seat?.socket?.readyState === WebSocket.OPEN;
  const snapshot = (room) => ({
    code: room.code, game: room.game, revision: room.revision,
    players: { red: online(room.red), black: online(room.black) },
    pendingRestart: room.pendingRestart,
  });
  const broadcast = (room) => {
    const message = { type: 'state', room: snapshot(room) };
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
    broadcast(room);
  }

  function enterRoom(socket, message) {
    if (sessions.has(socket)) return fail(socket, '你已经在房间内，请先退出');
    if (message.type === 'create') {
      if (rooms.size >= 100) return fail(socket, '房间已满，请稍后再试');
      let code;
      do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
      const room = { code, game: createInitialGame(), revision: 0, pendingRestart: null, updated: Date.now() };
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
    if (!online(room.red) || !online(room.black)) return fail(socket, '等待双方连接后再操作');
    if (message.type === 'move') {
      if (room.pendingRestart) return fail(socket, '请先处理重新开局请求');
      if (room.game.turn !== side) return fail(socket, '还没有轮到你');
      if (message.revision !== room.revision) {
        send(socket, { type: 'state', room: snapshot(room) });
        return fail(socket, '棋盘已更新，请重新选择棋子');
      }
      const result = applyMove(room.game, message.from, message.to);
      if (!result.ok) return fail(socket, result.error);
      room.game = result.game;
      room.revision++;
    } else if (message.type === 'restart-request') {
      if (room.pendingRestart) return fail(socket, '已有重新开局请求');
      room.pendingRestart = side;
    } else if (message.type === 'restart-answer') {
      if (!room.pendingRestart || room.pendingRestart === side) return fail(socket, '没有需要你回应的请求');
      if (typeof message.accept !== 'boolean') return fail(socket, '重新开局回复格式错误');
      if (message.accept) {
        room.game = createInitialGame();
        room.revision++;
      }
      room.pendingRestart = null;
    } else {
      return fail(socket, '不支持的操作');
    }
    broadcast(room);
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
      if (!online(room.red) && !online(room.black) && Date.now() - room.updated > 30 * 60_000) rooms.delete(code);
    }
  }, 30_000);
  timer.unref();
  wss.on('close', () => clearInterval(timer));
}
