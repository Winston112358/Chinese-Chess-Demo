import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer as startRealServer } from '../src/server/server.js';
import { createInitialGame } from '../src/shared/rules.js';

const startServer = (options) => startRealServer({ ...options, roomOptions: { countdownMs: 0, ...options.roomOptions } });

async function client(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const pending = [];
  let latestRoom;
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'state') latestRoom = message.room;
    const index = pending.findIndex((wait) => wait.predicate(message));
    if (index < 0) return inbox.push(message);
    const [wait] = pending.splice(index, 1);
    clearTimeout(wait.timer);
    wait.resolve(message);
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    socket,
    get room() { return latestRoom; },
    discardPreparing: () => { for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].type === 'state' && !inbox[i].room.clock.started) inbox.splice(i, 1); },
    send: (message) => socket.send(JSON.stringify(message.type === 'restart-answer'
      ? { requestId: latestRoom?.pendingRestart?.id, ...message } : message)),
    wait: (predicate) => new Promise((resolve, reject) => {
      const index = inbox.findIndex(predicate);
      if (index >= 0) return resolve(inbox.splice(index, 1)[0]);
      const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error('Timed out waiting for message')), 3000) };
      pending.push(waiter);
    }),
  };
}
const state = (revision, extra = () => true) => (message) => message.type === 'state'
  && message.room.revision === revision && extra(message.room);
const error = (message) => message.type === 'error';

// These older move/clock tests start explicitly; countdown timing is covered separately.
async function prepare(red, black) {
  for (const player of [red, black]) player.send({ type: 'ready', ready: true, round: player.room.round });
  const initial = (await red.wait((message) => message.type === 'state' && message.room.clock.started)).room;
  assert.deepEqual((await black.wait((message) => message.type === 'state' && message.room.clock.started)).room, initial);
  red.discardPreparing();
  black.discardPreparing();
  return initial;
}

async function setup(t, timeControl = { red: 6000, black: 9000 }, clockTickMs = 60_000) {
  let elapsed = 0;
  const server = await startServer({
    port: 0, host: '127.0.0.1', roomOptions: { now: () => elapsed, clockTickMs },
  });
  t.after(() => server.close());
  const red = await client(server.port);
  red.send({ type: 'create', timeControl });
  const redSeat = await red.wait((message) => message.type === 'seat');
  const waiting = (await red.wait(state(0))).room;
  const connectBlack = async () => {
    const black = await client(server.port);
    black.send({ type: 'join', code: redSeat.code });
    const blackSeat = await black.wait((message) => message.type === 'seat');
    const initial = await prepare(red, black);
    return { black, blackSeat, initial };
  };
  return { server, red, redSeat, waiting, connectBlack, advance: (milliseconds) => { elapsed += milliseconds; } };
}

async function broadcast(red, black, revision, predicate = () => true) {
  const latest = (await red.wait(state(revision, predicate))).room;
  assert.deepEqual((await black.wait(state(revision, predicate))).room, latest);
  return latest;
}
async function move(red, black, player, revision, [x, y, tx, ty]) {
  player.send({ type: 'move', from: { x, y }, to: { x: tx, y: ty }, revision });
  return broadcast(red, black, revision + 1);
}
async function request(red, black, player, action, revision) {
  player.send({ type: 'action-request', action, revision });
  return broadcast(red, black, revision, (room) => room.pendingAction?.action === action);
}
async function answer(red, black, player, pending, accept, revision) {
  player.send({ type: 'action-answer', requestId: pending.id, accept });
  return broadcast(red, black, revision, (room) => room.pendingAction === null);
}

test('negotiation requires connected seats, valid format, current board and a single request', async (t) => {
  const { red, waiting, connectBlack } = await setup(t);
  assert.equal(waiting.pendingAction, null);
  red.send({ type: 'action-request', action: 'draw', revision: 0 });
  assert.match((await red.wait(error)).error, /等待/);
  const { black, initial } = await connectBlack();
  for (const message of [
    { action: 'unknown', revision: 0 }, { action: 'draw' }, { action: 'draw', revision: '0' },
    { action: 'draw', revision: -1 }, { action: 'draw', revision: 0.5 },
  ]) {
    red.send({ type: 'action-request', ...message });
    assert.match((await red.wait(error)).error, /格式/);
  }
  red.send({ type: 'action-request', action: 'undo', revision: 0 });
  assert.match((await red.wait(error)).error, /没有/);
  const pending = (await request(red, black, red, 'draw', 0)).pendingAction;
  assert.deepEqual({ ...pending, id: 'id' }, { id: 'id', action: 'draw', side: 'red', revision: 0 });
  for (const player of [red, black]) {
    player.send({ type: 'action-request', action: 'resign', revision: 0 });
    assert.match((await player.wait(error)).error, /已有/);
    player.send({ type: 'restart-request' });
    assert.match((await player.wait(error)).error, /已有/);
  }
  red.send({ type: 'action-answer', requestId: pending.id, accept: true });
  assert.match((await red.wait(error)).error, /回应/);
  for (const message of [{ accept: true }, { requestId: pending.id, accept: 1 }, { requestId: 3, accept: false }]) {
    black.send({ type: 'action-answer', ...message });
    assert.match((await black.wait(error)).error, /格式/);
  }
  const declined = await answer(red, black, black, pending, false, 0);
  assert.deepEqual(declined.game, initial.game);
  assert.equal(declined.revision, 0);
  black.send({ type: 'restart-request' });
  await broadcast(red, black, 0, (room) => room.pendingRestart?.side === 'black');
  red.send({ type: 'action-request', action: 'draw', revision: 0 });
  assert.match((await red.wait(error)).error, /已有/);
});

test('refusal keeps the board and does not pause either clock', async (t) => {
  const { red, connectBlack, advance } = await setup(t);
  const { black, initial } = await connectBlack();
  advance(100);
  const requested = await request(red, black, black, 'resign', 0);
  assert.equal(requested.clock.runningSide, 'red');
  assert.equal(requested.clock.remainingMs.red, 5900);
  advance(250);
  const declined = await answer(red, black, red, requested.pendingAction, false, 0);
  assert.deepEqual(declined.game, initial.game);
  assert.deepEqual(declined.clock.remainingMs, { red: 5650, black: 9000 });
  assert.equal(declined.clock.runningSide, 'red');
});

for (const action of ['undo', 'draw', 'resign']) for (const requesterSide of ['red', 'black']) {
  test(`${action} vote by ${requesterSide} locks both clients until a valid response, with clocks running`, async (t) => {
    const { red, connectBlack, advance } = await setup(t);
    const { black } = await connectBlack();
    const current = await move(red, black, red, 0, [0, 6, 0, 5]);
    const requester = requesterSide === 'red' ? red : black;
    const responder = requesterSide === 'red' ? black : red;
    advance(100);
    const old = (await request(red, black, requester, action, 1)).pendingAction;
    const attemptMove = async (player, from, to, revision = 1) => {
      player.send({ type: 'move', from, to, revision });
      assert.match((await player.wait(error)).error, /投票/);
    };
    await attemptMove(red, { x: 0, y: 5 }, { x: 0, y: 4 });
    await attemptMove(black, { x: 0, y: 3 }, { x: 0, y: 4 });
    advance(200);
    requester.send({ type: 'action-answer', requestId: old.id, accept: false });
    assert.match((await requester.wait(error)).error, /回应/);
    responder.send({ type: 'action-answer', requestId: old.id, accept: 'false' });
    assert.match((await responder.wait(error)).error, /格式/);
    await attemptMove(black, { x: 0, y: 3 }, { x: 0, y: 4 });
    // A stale request returns the authoritative snapshot without unlocking the vote.
    requester.send({ type: 'action-request', action, revision: 0 });
    const locked = (await requester.wait(state(1))).room;
    assert.match((await requester.wait(error)).error, /更新/);
    assert.deepEqual(locked.game, current.game);
    assert.deepEqual(locked.pendingAction, old);
    assert.equal(locked.clock.runningSide, 'black');
    assert.deepEqual(locked.clock.remainingMs, { red: 6000, black: 8700 });
    advance(300);
    const declined = await answer(red, black, responder, old, false, 1);
    assert.deepEqual(declined.game, current.game);
    assert.equal(declined.pendingAction, null);
    const moved = await move(red, black, black, 1, [0, 3, 0, 4]);
    assert.equal(moved.game.history.length, 2);
    assert.deepEqual(moved.clock.remainingMs, { red: 6000, black: 8400 });
    const fresh = (await request(red, black, requester, action, 2)).pendingAction;
    assert.notEqual(fresh.id, old.id);
    responder.send({ type: 'action-answer', requestId: old.id, accept: true });
    assert.match((await responder.wait(error)).error, /失效/);
    await attemptMove(red, { x: 0, y: 5 }, { x: 0, y: 4 }, 2);
    const released = await answer(red, black, responder, fresh, false, 2);
    assert.deepEqual(released.game, moved.game);
    const resumed = await move(red, black, red, 2, [0, 5, 0, 4]);
    assert.equal(resumed.game.history.length, 3);
  });
}

test('single-step undo restores a captured piece, alternates turns and keeps all elapsed time', async (t) => {
  const { red, connectBlack, advance } = await setup(t);
  const { black } = await connectBlack();
  advance(100);
  await move(red, black, red, 0, [0, 6, 0, 5]);
  advance(200);
  await move(red, black, black, 1, [0, 3, 0, 4]);
  advance(300);
  const captured = await move(red, black, red, 2, [0, 5, 0, 4]);
  assert.equal(captured.game.history.at(-1).captured.side, 'black');
  advance(400);
  const requested = await request(red, black, black, 'undo', 3);
  advance(500);
  const restored = await answer(red, black, red, requested.pendingAction, true, 4);
  assert.equal(restored.game.history.length, 2);
  assert.deepEqual(restored.game.board[4 * 9], { side: 'black', type: 'pawn' });
  assert.deepEqual(restored.game.board[5 * 9], { side: 'red', type: 'pawn' });
  assert.equal(restored.game.turn, 'red');
  assert.equal(restored.clock.runningSide, 'red');
  assert.deepEqual(restored.clock.remainingMs, { red: 5600, black: 7900 });
  advance(100);
  const second = (await request(red, black, red, 'undo', 4)).pendingAction;
  const secondUndo = await answer(red, black, black, second, true, 5);
  assert.equal(secondUndo.game.turn, 'black');
  assert.equal(secondUndo.clock.runningSide, 'black');
  assert.deepEqual(secondUndo.clock.remainingMs, { red: 5500, black: 7900 });
  advance(200);
  const third = (await request(red, black, black, 'undo', 5)).pendingAction;
  const resetBoard = await answer(red, black, red, third, true, 6);
  assert.deepEqual(resetBoard.game, createInitialGame());
  assert.equal(resetBoard.clock.runningSide, 'red');
  assert.deepEqual(resetBoard.clock.remainingMs, { red: 5500, black: 7700 });
});

for (const [action, requesterSide, expected] of [
  ['draw', 'red', { winner: null, loser: null, reason: 'draw' }],
  ['resign', 'red', { winner: 'black', loser: 'red', reason: 'resignation' }],
  ['resign', 'black', { winner: 'red', loser: 'black', reason: 'resignation' }],
]) {
  test(`agreement ends ${action} requested by ${requesterSide} and locks the result`, async (t) => {
    const { red, connectBlack, advance } = await setup(t);
    const { black } = await connectBlack();
    await move(red, black, red, 0, [0, 6, 0, 5]);
    const requester = requesterSide === 'red' ? red : black;
    const responder = requesterSide === 'red' ? black : red;
    advance(300);
    const pending = (await request(red, black, requester, action, 1)).pendingAction;
    advance(200);
    const ended = await answer(red, black, responder, pending, true, 2);
    assert.deepEqual(ended.game.result, expected);
    assert.deepEqual(ended.clock.remainingMs, { red: 6000, black: 8500 });
    assert.equal(ended.clock.runningSide, null);
    for (const next of ['undo', 'draw', 'resign']) {
      requester.send({ type: 'action-request', action: next, revision: 2 });
      assert.match((await requester.wait(error)).error, /结束/);
    }
    black.send({ type: 'move', from: { x: 0, y: 3 }, to: { x: 0, y: 4 }, revision: 2 });
    assert.match((await black.wait(error)).error, /结束/);
    requester.send({ type: 'restart-request' });
    const restart = await broadcast(red, black, 2, (room) => room.pendingRestart?.side === requesterSide);
    assert.deepEqual(restart.clock.remainingMs, ended.clock.remainingMs);
    responder.send({ type: 'restart-answer', accept: true });
    const fresh = await broadcast(red, black, 3);
    assert.deepEqual(fresh.game, createInitialGame());
    assert.equal(fresh.pendingAction, null);
    assert.equal(fresh.phase, 'preparing');
    assert.equal(fresh.clock.runningSide, null);
    assert.deepEqual(fresh.clock.remainingMs, { red: 6000, black: 9000 });
  });
}

test('timeout has priority over consent and cannot be undone or replaced by a draw', async (t) => {
  const { red, connectBlack, advance } = await setup(t);
  const { black } = await connectBlack();
  await move(red, black, red, 0, [0, 6, 0, 5]);
  const pending = (await request(red, black, black, 'undo', 1)).pendingAction;
  advance(9000);
  red.send({ type: 'action-answer', requestId: pending.id, accept: true });
  const expired = await broadcast(red, black, 2);
  assert.deepEqual(expired.game.result, { winner: 'red', loser: 'black', reason: 'timeout' });
  assert.equal(expired.game.history.length, 1);
  assert.equal(expired.pendingAction, null);
  assert.equal(expired.clock.remainingMs.black, 0);
  assert.match((await red.wait(error)).error, /失效/);
  for (const action of ['undo', 'draw', 'resign']) {
    red.send({ type: 'action-request', action, revision: 2 });
    assert.match((await red.wait(error)).error, /结束/);
  }
});

test('pending negotiation survives reconnect without permitting offline consent or self-consent', async (t) => {
  const { server, red, redSeat, connectBlack, advance } = await setup(t);
  const { black, blackSeat } = await connectBlack();
  const pending = (await request(red, black, red, 'draw', 0)).pendingAction;
  advance(500);
  black.socket.close();
  const disconnected = (await red.wait(state(0, (room) => !room.players.black))).room;
  assert.deepEqual(disconnected.pendingAction, pending);
  assert.equal(disconnected.clock.remainingMs.red, 5500);
  red.send({ type: 'action-answer', requestId: pending.id, accept: true });
  assert.match((await red.wait(error)).error, /等待/);
  advance(200);
  const resumed = await client(server.port);
  resumed.send({ type: 'resume', code: redSeat.code, token: blackSeat.token });
  await resumed.wait((message) => message.type === 'seat');
  const recovered = await broadcast(red, resumed, 0, (room) => room.players.black);
  assert.deepEqual(recovered.pendingAction, pending);
  assert.equal(recovered.clock.remainingMs.red, 5300);
  red.send({ type: 'action-answer', requestId: pending.id, accept: false });
  assert.match((await red.wait(error)).error, /回应/);
  const ended = await answer(red, resumed, resumed, pending, true, 1);
  assert.deepEqual(ended.game.result, { winner: null, loser: null, reason: 'draw' });
  assert.equal(ended.clock.remainingMs.red, 5300);
});

test('heartbeat timeout clears offline negotiation and reconnect cannot revive its vote', async (t) => {
  const { server, red, redSeat, connectBlack, advance } = await setup(t, { red: 6000, black: 9000 }, 10);
  const { black } = await connectBlack();
  const pending = (await request(red, black, red, 'draw', 0)).pendingAction;
  advance(1000);
  red.socket.close();
  const disconnected = (await black.wait(state(0, (room) => !room.players.red))).room;
  assert.deepEqual(disconnected.pendingAction, pending);
  advance(5000);
  const expired = (await black.wait(state(1))).room;
  assert.deepEqual(expired.game.result, { winner: 'black', loser: 'red', reason: 'timeout' });
  assert.equal(expired.pendingAction, null);
  assert.equal(expired.clock.runningSide, null);
  assert.equal(expired.clock.remainingMs.red, 0);
  const resumed = await client(server.port);
  resumed.send({ type: 'resume', code: redSeat.code, token: redSeat.token });
  await resumed.wait((message) => message.type === 'seat');
  const recovered = await broadcast(resumed, black, 1, (room) => room.players.red);
  assert.equal(recovered.pendingAction, null);
  assert.deepEqual(recovered.game.result, expired.game.result);
  black.send({ type: 'action-answer', requestId: pending.id, accept: true });
  assert.match((await black.wait(error)).error, /失效/);
});

test('agreed undo can reopen a real checkmate without restoring either time budget', async (t) => {
  const { red, connectBlack, advance } = await setup(t, { red: 600_000, black: 900_000 });
  const { black } = await connectBlack();
  const moves = [[4, 6, 4, 5], [4, 3, 4, 4], [3, 9, 4, 8], [4, 4, 4, 5], [1, 7, 4, 7],
    [4, 5, 3, 5], [4, 7, 4, 2], [3, 5, 2, 5], [7, 7, 4, 7]];
  let ended;
  for (const [revision, coordinates] of moves.entries()) {
    advance(100);
    ended = await move(red, black, revision % 2 ? black : red, revision, coordinates);
  }
  assert.equal(ended.game.result.reason, 'checkmate');
  assert.equal(ended.clock.runningSide, null);
  advance(50_000);
  const pending = (await request(red, black, black, 'undo', 9)).pendingAction;
  const reopened = await answer(red, black, red, pending, true, 10);
  assert.equal(reopened.game.result, null);
  assert.equal(reopened.game.turn, 'red');
  assert.equal(reopened.game.history.length, 8);
  assert.equal(reopened.clock.runningSide, 'red');
  assert.deepEqual(reopened.clock.remainingMs, ended.clock.remainingMs);
  advance(200);
  const next = await move(red, black, red, 10, moves.at(-1));
  assert.equal(next.game.result.reason, 'checkmate');
  assert.equal(next.clock.remainingMs.red, ended.clock.remainingMs.red - 200);
});
