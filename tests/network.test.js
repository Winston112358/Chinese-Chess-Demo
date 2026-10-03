import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../src/server/server.js';

async function client(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const pending = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const index = pending.findIndex((wait) => wait.predicate(message));
    if (index >= 0) {
      const [wait] = pending.splice(index, 1);
      clearTimeout(wait.timer);
      wait.resolve(message);
    } else inbox.push(message);
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    socket,
    send: (message) => socket.send(JSON.stringify(message)),
    wait: (predicate) => new Promise((resolve, reject) => {
      const index = inbox.findIndex(predicate);
      if (index >= 0) { resolve(inbox.splice(index, 1)[0]); return; }
      const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error('Timed out waiting for message')), 3000) };
      pending.push(waiter);
    }),
  };
}
const state = (revision, extra = () => true) => (message) => message.type === 'state' && message.room.revision === revision && extra(message.room);
const error = (message) => message.type === 'error';

test('occupied ports reject cleanly and the caller can retry on an available port', async (t) => {
  const first = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => first.close());
  await assert.rejects(startServer({ port: first.port, host: '127.0.0.1' }), { code: 'EADDRINUSE' });
  const fallback = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => fallback.close());
  assert.notEqual(fallback.port, first.port);
  assert.equal((await fetch(`http://127.0.0.1:${fallback.port}/`)).status, 200);
});

test('HTTP serves only app assets and reports LAN addresses', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  for (const path of ['/', '/style.css', '/appearance.css', '/game-tools.css', '/app.js', '/appearance.js', '/board.js', '/piece-glyph.js', '/game-tools.js', '/shared/rules.js', '/shared/sandbox.js', '/shared/analysis.js']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 20);
  }
  for (const path of ['/fonts/xiangqi-running.woff2', '/fonts/xiangqi-kai.woff2', '/fonts/xiangqi-xingkai.woff2']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'font/woff2');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.toString('ascii', 0, 4), 'wOF2');
    const head = await fetch(base + path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  const info = await (await fetch(base + '/api/server-info')).json();
  assert.deepEqual(info.addresses, [], 'A loopback-only service must not advertise LAN access');
  assert.deepEqual(info.candidates, []);
  assert.equal(info.listeningOn, '127.0.0.1');
  for (const path of ['/package.json', '/.git/config', '/src/server/rooms.js']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});

test('two clients synchronize, server rejects illegal moves, reconnect restores seat, restart requires consent', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const red = await client(server.port);
  red.send({ type: 'create' });
  const redSeat = await red.wait((message) => message.type === 'seat');
  const waiting = await red.wait(state(0));
  assert.equal(waiting.room.players.black, false);
  const invalidResume = await client(server.port);
  invalidResume.send({ type: 'resume', code: redSeat.code });
  assert.match((await invalidResume.wait(error)).error, /恢复/);
  red.send({ type: 'move', from: { x: 0, y: 6 }, to: { x: 0, y: 5 }, revision: 0 });
  assert.match((await red.wait(error)).error, /等待/);
  const black = await client(server.port);
  black.send({ type: 'join', code: redSeat.code.toLowerCase() });
  const blackSeat = await black.wait((message) => message.type === 'seat');
  assert.equal(blackSeat.side, 'black');
  const initial = await black.wait(state(0, (room) => room.players.black));
  assert.deepEqual((await red.wait(state(0, (room) => room.players.black))).room.game, initial.room.game);

  const third = await client(server.port);
  third.send({ type: 'join', code: redSeat.code });
  assert.match((await third.wait(error)).error, /两名/);
  third.send({ type: 'resume', code: redSeat.code, token: 'wrong-token' });
  assert.match((await third.wait(error)).error, /恢复/);
  third.socket.send('not JSON');
  assert.match((await third.wait(error)).error, /格式/);

  black.send({ type: 'move', from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 0 });
  assert.match((await black.wait(error)).error, /轮到/);
  red.send({ type: 'move', from: { x: 0, y: 6 }, to: { x: 1, y: 6 }, revision: 0 });
  assert.match((await red.wait(error)).error, /兵卒/);
  red.send({ type: 'move', from: { x: 0, y: 6 }, to: { x: 0, y: 5 }, revision: 0 });
  const first = await red.wait(state(1));
  assert.deepEqual(first.room, (await black.wait(state(1))).room);
  assert.equal(first.room.game.turn, 'black');
  black.send({ type: 'move', from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 0 });
  assert.match((await black.wait(error)).error, /更新/);
  black.send({ type: 'move', from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 1 });
  await red.wait(state(2));
  await black.wait(state(2));
  red.send({ type: 'move', from: { x: 0, y: 5 }, to: { x: 0, y: 4 }, revision: 2 });
  const capture = await red.wait(state(3));
  assert.equal(capture.room.game.history.at(-1).captured.type, 'pawn');
  assert.deepEqual(capture.room.game, (await black.wait(state(3))).room.game);

  black.socket.close();
  await red.wait(state(3, (room) => !room.players.black));
  const resumed = await client(server.port);
  resumed.send({ type: 'resume', code: redSeat.code, token: blackSeat.token });
  assert.equal((await resumed.wait((message) => message.type === 'seat')).side, 'black');
  assert.deepEqual((await resumed.wait(state(3))).room.game, capture.room.game);
  await red.wait(state(3, (room) => room.players.black));
  red.send({ type: 'restart-request' });
  await red.wait(state(3, (room) => room.pendingRestart === 'red'));
  await resumed.wait(state(3, (room) => room.pendingRestart === 'red'));
  red.send({ type: 'restart-answer', accept: true });
  assert.match((await red.wait(error)).error, /回应/);
  resumed.send({ type: 'restart-answer', accept: false });
  const declined = await red.wait(state(3, (room) => !room.pendingRestart));
  assert.equal(declined.room.game.history.length, 3);
  await resumed.wait(state(3, (room) => !room.pendingRestart));
  red.send({ type: 'restart-request' });
  await resumed.wait(state(3, (room) => room.pendingRestart === 'red'));
  resumed.send({ type: 'restart-answer', accept: true });
  const restarted = await red.wait(state(4));
  assert.equal(restarted.room.game.history.length, 0);
  assert.equal(restarted.room.game.turn, 'red');
  assert.deepEqual((await resumed.wait(state(4))).room, restarted.room);
});

async function timedRoom(t, timeControl = { red: 6000, black: 900_000 }) {
  let elapsed = 0;
  const server = await startServer({ port: 0, host: '127.0.0.1', roomOptions: { now: () => elapsed, clockTickMs: 10 } });
  t.after(() => server.close());
  const red = await client(server.port);
  red.send({ type: 'create', timeControl });
  const seat = await red.wait((message) => message.type === 'seat');
  const waiting = await red.wait(state(0));
  return { server, red, seat, waiting, advance: (milliseconds) => { elapsed += milliseconds; } };
}

test('room clocks start together, change only after legal moves, and reject expired moves at the exact deadline', async (t) => {
  const { server, red, seat, waiting, advance } = await timedRoom(t, { red: 6000, black: 9000 });
  assert.equal(waiting.room.clock.started, false);
  assert.deepEqual(waiting.room.clock.initialMs, { red: 6000, black: 9000 });
  advance(50_000);
  const black = await client(server.port);
  black.send({ type: 'join', code: seat.code, timeControl: { red: 10_800_000, black: 10_800_000 } });
  await black.wait((message) => message.type === 'seat');
  const initial = (await red.wait(state(0, (room) => room.clock.started))).room;
  await black.wait(state(0));
  assert.equal(initial.clock.runningSide, 'red');
  assert.deepEqual(initial.clock.remainingMs, { red: 6000, black: 9000 });
  advance(1000);
  red.send({ type: 'move', from: { x: 0, y: 6 }, to: { x: 1, y: 6 }, revision: 0 });
  assert.match((await red.wait(error)).error, /兵卒/);
  advance(500);
  red.send({ type: 'move', from: { x: 0, y: 6 }, to: { x: 0, y: 5 }, revision: 0 });
  const moved = (await red.wait(state(1))).room;
  assert.deepEqual((await black.wait(state(1))).room, moved);
  assert.deepEqual(moved.clock.remainingMs, { red: 4500, black: 9000 });
  assert.equal(moved.clock.runningSide, 'black');
  advance(9000);
  black.send({ type: 'move', from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 1 });
  const ended = (await black.wait(state(2, (room) => room.game.result))).room;
  assert.deepEqual(ended.game.result, { winner: 'red', loser: 'black', reason: 'timeout' });
  assert.equal(ended.game.history.length, 1);
  assert.equal(ended.clock.runningSide, null);
  assert.equal(ended.clock.remainingMs.black, 0);
  assert.match((await black.wait(error)).error, /结束/);
  assert.deepEqual((await red.wait(state(2))).room.game, ended.game);
});

test('idle and disconnected players still time out, reconnect preserves the result, and agreed restart restores both budgets', async (t) => {
  const { server, red, seat, advance } = await timedRoom(t);
  const black = await client(server.port);
  black.send({ type: 'join', code: seat.code });
  await black.wait((message) => message.type === 'seat');
  await red.wait(state(0, (room) => room.clock.started));
  await black.wait(state(0));
  advance(1000);
  red.socket.close();
  const disconnected = (await black.wait(state(0, (room) => !room.players.red))).room;
  assert.equal(disconnected.clock.runningSide, 'red');
  assert.equal(disconnected.clock.remainingMs.red, 5000);
  advance(5000);
  const ended = (await black.wait(state(1, (room) => room.game.result))).room;
  assert.deepEqual(ended.game.result, { winner: 'black', loser: 'red', reason: 'timeout' });
  const resumed = await client(server.port);
  resumed.send({ type: 'resume', code: seat.code, token: seat.token });
  await resumed.wait((message) => message.type === 'seat');
  assert.deepEqual((await resumed.wait(state(1))).room.game.result, ended.game.result);
  await black.wait(state(1, (room) => room.players.red));
  resumed.send({ type: 'restart-request' });
  await black.wait(state(1, (room) => room.pendingRestart === 'red'));
  black.send({ type: 'restart-answer', accept: true });
  const restarted = (await resumed.wait(state(2))).room;
  assert.equal(restarted.game.result, null);
  assert.equal(restarted.game.history.length, 0);
  assert.deepEqual(restarted.clock.remainingMs, { red: 6000, black: 900_000 });
  assert.equal(restarted.clock.runningSide, 'red');
});

test('restart voting locks both clients without pausing clocks; refusal restores play and offline clocks still run', async (t) => {
  const { server, red, seat, advance } = await timedRoom(t);
  const black = await client(server.port);
  black.send({ type: 'join', code: seat.code });
  await black.wait((message) => message.type === 'seat');
  await red.wait(state(0, (room) => room.clock.started));
  await black.wait(state(0));
  red.send({ type: 'restart-request' });
  await red.wait(state(0, (room) => room.pendingRestart === 'red'));
  await black.wait(state(0, (room) => room.pendingRestart === 'red'));
  advance(1000);
  for (const [player, from, to] of [
    [red, { x: 0, y: 6 }, { x: 0, y: 5 }], [black, { x: 0, y: 3 }, { x: 0, y: 4 }],
  ]) {
    player.send({ type: 'move', from, to, revision: 0 });
    assert.match((await player.wait(error)).error, /投票/);
  }
  red.send({ type: 'restart-answer', accept: false });
  assert.match((await red.wait(error)).error, /回应/);
  black.send({ type: 'restart-answer', accept: 'false' });
  assert.match((await black.wait(error)).error, /格式/);
  red.send({ type: 'move', from: { x: 0, y: 6 }, to: { x: 0, y: 5 }, revision: 0 });
  assert.match((await red.wait(error)).error, /投票/);
  black.send({ type: 'restart-answer', accept: false });
  const declined = (await red.wait(state(0, (room) => !room.pendingRestart))).room;
  assert.deepEqual((await black.wait(state(0, (room) => !room.pendingRestart))).room, declined);
  assert.equal(declined.game.history.length, 0);
  assert.deepEqual(declined.clock.remainingMs, { red: 5000, black: 900_000 });
  assert.equal(declined.clock.runningSide, 'red');
  red.send({ type: 'move', from: { x: 0, y: 6 }, to: { x: 0, y: 5 }, revision: 0 });
  const moved = (await red.wait(state(1))).room;
  await black.wait(state(1));
  assert.equal(moved.clock.remainingMs.red, 5000);
  assert.equal(moved.clock.runningSide, 'black');
  assert.equal(moved.pendingRestart, null);
  black.send({ type: 'restart-request' });
  await red.wait(state(1, (room) => room.pendingRestart === 'black'));
  await black.wait(state(1, (room) => room.pendingRestart === 'black'));
  advance(500);
  for (const [player, from, to] of [
    [red, { x: 0, y: 5 }, { x: 0, y: 4 }], [black, { x: 0, y: 3 }, { x: 0, y: 4 }],
  ]) {
    player.send({ type: 'move', from, to, revision: 1 });
    assert.match((await player.wait(error)).error, /投票/);
  }
  red.send({ type: 'restart-answer', accept: false });
  const secondDecline = (await red.wait(state(1, (room) => !room.pendingRestart))).room;
  await black.wait(state(1, (room) => !room.pendingRestart));
  assert.equal(secondDecline.game.history.length, 1);
  assert.deepEqual(secondDecline.clock.remainingMs, { red: 5000, black: 899_500 });
  black.send({ type: 'move', from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 1 });
  await red.wait(state(2));
  await black.wait(state(2));
  black.socket.close();
  await red.wait(state(2, (room) => !room.players.black));
  advance(500);
  red.send({ type: 'move', from: { x: 0, y: 5 }, to: { x: 0, y: 4 }, revision: 2 });
  const offlineMove = (await red.wait(state(3))).room;
  assert.equal(offlineMove.pendingRestart, null);
  assert.equal(offlineMove.game.history.length, 3);
  assert.deepEqual(offlineMove.clock.remainingMs, { red: 4500, black: 899_500 });
  advance(899_500);
  assert.equal((await red.wait(state(4, (room) => room.game.result))).room.game.result.loser, 'black');
});

test('invalid room times cannot create a seat and a joiner cannot change the host settings', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const red = await client(server.port);
  for (const timeControl of [null, {}, { red: 0, black: 900_000 }, { red: '600000', black: 900_000 }]) {
    red.send({ type: 'create', timeControl });
    assert.match((await red.wait(error)).error, /总时间/);
  }
  red.send({ type: 'create', timeControl: { red: 600_000, black: 900_000 } });
  await red.wait((message) => message.type === 'seat');
  assert.deepEqual((await red.wait(state(0))).room.clock.initialMs, { red: 600_000, black: 900_000 });
});

test('a real checkmate from the starting position synchronizes the winner, stops both clocks and locks play', async (t) => {
  const { server, red, seat, advance } = await timedRoom(t, { red: 600_000, black: 900_000 });
  const black = await client(server.port);
  black.send({ type: 'join', code: seat.code });
  await black.wait((message) => message.type === 'seat');
  await red.wait(state(0, (room) => room.clock.started));
  await black.wait(state(0));
  const moves = [[4, 6, 4, 5], [4, 3, 4, 4], [3, 9, 4, 8], [4, 4, 4, 5], [1, 7, 4, 7],
    [4, 5, 3, 5], [4, 7, 4, 2], [3, 5, 2, 5], [7, 7, 4, 7]];
  let latest;
  for (const [revision, [x, y, tx, ty]] of moves.entries()) {
    advance(100);
    const player = revision % 2 ? black : red;
    player.send({ type: 'move', from: { x, y }, to: { x: tx, y: ty }, revision });
    latest = (await red.wait(state(revision + 1))).room;
    assert.deepEqual((await black.wait(state(revision + 1))).room, latest);
    if (revision < moves.length - 1) assert.equal(latest.game.result, null);
  }
  assert.deepEqual(latest.game.result, { winner: 'red', loser: 'black', reason: 'checkmate' });
  assert.equal(latest.clock.runningSide, null);
  assert.deepEqual(latest.clock.remainingMs, { red: 599_500, black: 899_600 });
  advance(50_000);
  black.send({ type: 'move', from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: moves.length });
  assert.match((await black.wait(error)).error, /结束/);
  red.send({ type: 'restart-request' });
  const stopped = (await red.wait(state(moves.length, (room) => room.pendingRestart))).room;
  assert.deepEqual(stopped.clock.remainingMs, latest.clock.remainingMs);
});

test('both armies cross the river, move and capture sideways, synchronize clocks, and restore a sideways capture by consent', async (t) => {
  const budgets = { red: 600_000, black: 900_000 };
  const { server, red, seat, advance } = await timedRoom(t, budgets);
  const black = await client(server.port);
  black.send({ type: 'join', code: seat.code });
  await black.wait((message) => message.type === 'seat');
  await red.wait(state(0, (room) => room.clock.started));
  await black.wait(state(0));
  const moves = [
    [0, 6, 0, 5], [8, 3, 8, 4], [0, 5, 0, 4], [8, 4, 8, 5],
    [0, 4, 1, 4], [8, 5, 7, 5], [6, 6, 6, 5], [2, 3, 2, 4],
    [1, 4, 2, 4], [7, 5, 6, 5],
  ];
  const positions = [];
  for (const [revision, [x, y, tx, ty]] of moves.entries()) {
    advance(100);
    const movingSide = revision % 2 ? 'black' : 'red';
    const nextSide = movingSide === 'red' ? 'black' : 'red';
    const player = movingSide === 'red' ? red : black;
    player.send({ type: 'move', from: { x, y }, to: { x: tx, y: ty }, revision });
    const latest = (await red.wait(state(revision + 1))).room;
    assert.deepEqual((await black.wait(state(revision + 1))).room, latest);
    assert.equal(latest.game.result, null);
    assert.equal(latest.game.turn, nextSide);
    assert.equal(latest.clock.runningSide, nextSide);
    assert.equal(latest.game.history.length, revision + 1);
    assert.equal(latest.game.board[y * 9 + x], null);
    assert.deepEqual(latest.game.board[ty * 9 + tx], { side: movingSide, type: 'pawn' });
    assert.deepEqual(latest.clock.remainingMs, {
      red: budgets.red - Math.ceil((revision + 1) / 2) * 100,
      black: budgets.black - Math.floor((revision + 1) / 2) * 100,
    });
    assert.deepEqual(latest.game.history.at(-1).captured,
      revision >= 8 ? { side: nextSide, type: 'pawn' } : null);
    assert.equal(latest.game.history.filter((move) => move.captured).length, Math.max(0, revision - 7));
    positions.push(latest.game);
  }
  const finishedVariation = positions.at(-1);
  assert.deepEqual(finishedVariation.history.slice(-2).map((move) => ({ from: move.from, to: move.to, captured: move.captured })), [
    { from: { x: 1, y: 4 }, to: { x: 2, y: 4 }, captured: { side: 'black', type: 'pawn' } },
    { from: { x: 7, y: 5 }, to: { x: 6, y: 5 }, captured: { side: 'red', type: 'pawn' } },
  ]);
  advance(200);
  black.send({ type: 'action-request', action: 'undo', revision: 10 });
  const requested = (await red.wait(state(10, (room) => room.pendingAction?.action === 'undo'))).room;
  assert.deepEqual((await black.wait(state(10, (room) => room.pendingAction?.action === 'undo'))).room, requested);
  assert.deepEqual(requested.clock.remainingMs, { red: 599_300, black: 899_500 });
  advance(300);
  red.send({ type: 'action-answer', requestId: requested.pendingAction.id, accept: true });
  const restored = (await red.wait(state(11))).room;
  assert.deepEqual((await black.wait(state(11))).room, restored);
  assert.deepEqual(restored.game, positions[8]);
  assert.equal(restored.pendingAction, null);
  assert.equal(restored.game.turn, 'black');
  assert.equal(restored.clock.runningSide, 'black');
  assert.deepEqual(restored.game.board[5 * 9 + 6], { side: 'red', type: 'pawn' });
  assert.deepEqual(restored.game.board[5 * 9 + 7], { side: 'black', type: 'pawn' });
  assert.deepEqual(restored.game.history.filter((move) => move.captured).map((move) => move.captured), [{ side: 'black', type: 'pawn' }]);
  assert.deepEqual(restored.clock.remainingMs, { red: 599_000, black: 899_500 }, 'agreement must not refund move or voting time');
  advance(100);
  black.send({ type: 'move', from: { x: 7, y: 5 }, to: { x: 6, y: 5 }, revision: 11 });
  const replayed = (await red.wait(state(12))).room;
  assert.deepEqual((await black.wait(state(12))).room, replayed);
  assert.deepEqual(replayed.game, finishedVariation);
  assert.equal(replayed.clock.runningSide, 'red');
  assert.deepEqual(replayed.clock.remainingMs, { red: 599_000, black: 899_400 });
});
