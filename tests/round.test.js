import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../src/server/server.js';

const state = (condition = () => true) => (message) => message.type === 'state' && condition(message.room);
const error = (message) => message.type === 'error';
const pawnMove = { type: 'move', from: { x: 0, y: 6 }, to: { x: 0, y: 5 } };
const budgets = { red: 6000, black: 9000 };

async function client(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waits = [];
  let room;
  socket.on('message', (bytes) => {
    const message = JSON.parse(bytes.toString());
    if (message.type === 'state') room = message.room;
    const index = waits.findIndex((wait) => wait.matches(message));
    if (index < 0) inbox.push(message);
    else { const [wait] = waits.splice(index, 1); clearTimeout(wait.timer); wait.resolve(message); }
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    socket, get room() { return room; }, send: (message) => socket.send(JSON.stringify(message)),
    wait: (matches) => new Promise((resolve, reject) => {
      const index = inbox.findIndex(matches);
      if (index >= 0) return resolve(inbox.splice(index, 1)[0]);
      const timeout = new Error('Room response timed out');
      const wait = { matches, resolve, timer: setTimeout(() => { timeout.message += `; latest round=${room?.round}, phase=${room?.phase}, revision=${room?.revision}`; reject(timeout); }, 1500) };
      waits.push(wait);
    }),
  };
}

async function setup(t, timed = true) {
  let elapsed = 0;
  const server = await startServer({ port: 0, host: '127.0.0.1', roomOptions: { now: () => elapsed, clockTickMs: 10 } });
  t.after(() => server.close());
  const red = await client(server.port);
  red.send({ type: 'create', timed, timeControl: budgets });
  const redSeat = await red.wait((message) => message.type === 'seat');
  await red.wait(state());
  const black = await client(server.port);
  black.send({ type: 'join', code: redSeat.code });
  const blackSeat = await black.wait((message) => message.type === 'seat');
  const joined = (await black.wait(state())).room;
  await red.wait(state((room) => room.players.black));
  const ready = async (player, value = true) => {
    player.send({ type: 'ready', ready: value, round: player.room.round });
    return (await player.wait(state((room) => room.ready[player === red ? 'red' : 'black'] === value))).room;
  };
  return { red, black, server, redSeat, blackSeat, joined, ready,
    advance: (ms) => { elapsed += ms; },
    start: async () => {
      await ready(red);
      await ready(black);
      elapsed += 3000;
      return (await red.wait(state((room) => room.phase === 'playing'))).room;
    },
  };
}

test('joining and one-sided readiness never start clocks; both ready begin a full 3-second countdown', async (t) => {
  const { red, black, joined, ready, advance } = await setup(t);
  assert.equal(joined.phase, 'preparing');
  assert.deepEqual(joined.ready, { red: false, black: false });
  assert.equal(joined.clock.started, false);
  advance(60_000);
  red.send({ ...pawnMove, revision: 0 });
  assert.match((await red.wait(error)).error, /准备/);
  const firstReady = await ready(red);
  assert.equal(firstReady.phase, 'preparing');
  assert.deepEqual(firstReady.clock.remainingMs, budgets);
  advance(60_000);
  const counting = await ready(black);
  assert.equal(counting.phase, 'countdown');
  assert.equal(counting.countdownMs, 3000);
  assert.equal(counting.clock.started, false);
  assert.deepEqual(counting.clock.remainingMs, budgets);
  advance(2999);
  red.send({ ...pawnMove, revision: 0 });
  assert.match((await red.wait(error)).error, /倒数/);
  advance(1);
  red.send({ ...pawnMove, revision: 0 });
  const played = (await red.wait(state((room) => room.revision === 1))).room;
  assert.equal(played.phase, 'playing');
  assert.equal(played.game.history.length, 1);
  assert.equal(played.clock.runningSide, 'black');
  assert.deepEqual(played.clock.remainingMs, budgets, 'Countdown must not consume either budget');
});

test('readiness can be cancelled and malformed or stale-round readiness cannot start a game', async (t) => {
  const { red, black, ready } = await setup(t);
  await ready(red);
  assert.equal((await ready(red, false)).ready.red, false);
  for (const message of [{ ready: true, round: 99 }, { ready: 'true', round: 0 }, { ready: true }]) {
    black.send({ type: 'ready', ...message });
    assert.match((await black.wait(error)).error, /失效|格式/);
  }
  const own = await ready(black);
  assert.equal(own.phase, 'preparing');
  assert.deepEqual(own.ready, { red: false, black: true });
});

test('disconnect during countdown cancels it, clears readiness and requires preparation after resume', async (t) => {
  const { red, black, ready, advance, server, redSeat, blackSeat } = await setup(t);
  await ready(red);
  await ready(black);
  advance(2000);
  black.socket.close();
  const cancelled = (await red.wait(state((room) => !room.players.black))).room;
  assert.equal(cancelled.phase, 'preparing');
  assert.deepEqual(cancelled.ready, { red: false, black: false });
  advance(60_000);
  const resumed = await client(server.port);
  resumed.send({ type: 'resume', code: redSeat.code, token: blackSeat.token });
  await resumed.wait((message) => message.type === 'seat');
  const restored = (await resumed.wait(state())).room;
  assert.equal(restored.clock.started, false);
  assert.deepEqual(restored.clock.remainingMs, budgets);
  assert.deepEqual(restored.ready, { red: false, black: false });
});

test('untimed play never decrements clocks or produces a timeout, even after a very long turn', async (t) => {
  const { red, black, start, advance } = await setup(t, false);
  const initial = await start();
  assert.equal(initial.clock.enabled, false);
  assert.equal(initial.clock.started, true);
  assert.equal(initial.clock.runningSide, null);
  advance(100_000_000);
  red.send({ ...pawnMove, revision: 0 });
  const played = (await red.wait(state((room) => room.revision === 1))).room;
  assert.equal(played.game.result, null);
  assert.equal(played.clock.runningSide, null);
  assert.deepEqual(played.clock.remainingMs, budgets);
  black.send({ type: 'action-request', action: 'draw', revision: 1 });
  const request = (await red.wait(state((room) => room.pendingAction))).room.pendingAction;
  red.send({ type: 'action-answer', requestId: request.id, accept: true });
  assert.equal((await red.wait(state((room) => room.revision === 2))).room.game.result.reason, 'draw');
});

test('refusing a configured restart keeps seats, board and current settings, with the old clock running', async (t) => {
  const { red, black, start, advance } = await setup(t);
  await start();
  advance(500);
  const config = { redSide: 'black', timed: false, timeControl: budgets };
  red.send({ type: 'restart-request', revision: 0, config });
  const requested = (await black.wait(state((room) => room.pendingRestart))).room;
  assert.deepEqual(requested.pendingRestart.config, { ...config, moveTimeMs: null });
  assert.equal(requested.clock.remainingMs.red, 5500);
  advance(500);
  black.send({ type: 'restart-answer', requestId: requested.pendingRestart.id, accept: false });
  const refused = (await red.wait(state((room) => !room.pendingRestart && room.clock.remainingMs.red === 5000))).room;
  assert.equal(refused.phase, 'playing');
  assert.equal(refused.revision, 0);
  assert.equal(refused.clock.enabled, true);
  assert.deepEqual(refused.clock.initialMs, budgets);
  assert.equal(refused.clock.runningSide, 'red');
  red.send({ ...pawnMove, revision: 0 });
  assert.equal((await red.wait(state((room) => room.revision === 1))).room.game.history[0].piece.side, 'red');
});

test('agreed swap updates both live seats and resumed tokens, resets readiness, and applies asymmetric new times', async (t) => {
  const { red, black, redSeat, blackSeat, server, start, advance } = await setup(t);
  await start();
  const times = { red: 900_000, black: 740_400 };
  black.send({ type: 'restart-request', revision: 0, config: { redSide: 'black', timed: true, timeControl: times } });
  const request = (await red.wait(state((room) => room.pendingRestart))).room.pendingRestart;
  red.send({ type: 'restart-answer', requestId: request.id, accept: true, config: { redSide: 'red', timed: false } });
  const newRedSeat = await black.wait((message) => message.type === 'seat');
  const newBlackSeat = await red.wait((message) => message.type === 'seat');
  assert.equal(newRedSeat.side, 'red');
  assert.equal(newRedSeat.token, blackSeat.token);
  assert.equal(newBlackSeat.side, 'black');
  assert.equal(newBlackSeat.token, redSeat.token);
  const fresh = (await red.wait(state((room) => room.round === 1))).room;
  assert.equal(fresh.phase, 'preparing');
  assert.equal(fresh.clock.started, false);
  assert.deepEqual(fresh.ready, { red: false, black: false });
  assert.deepEqual(fresh.clock.initialMs, times);
  advance(60_000);
  for (const player of [red, black]) player.send({ type: 'ready', ready: true, round: 1 });
  await red.wait(state((room) => room.phase === 'countdown' && room.round === 1));
  advance(3000);
  await red.wait(state((room) => room.phase === 'playing' && room.round === 1));
  red.send({ ...pawnMove, revision: 1 });
  assert.match((await red.wait(error)).error, /轮到/);
  black.send({ ...pawnMove, revision: 1 });
  const moved = (await red.wait(state((room) => room.revision === 2))).room;
  assert.deepEqual(moved.clock.remainingMs, times);
  red.socket.close();
  await black.wait(state((room) => room.revision === 2 && !room.players.black));
  const resumed = await client(server.port);
  resumed.send({ type: 'resume', code: redSeat.code, token: redSeat.token });
  assert.equal((await resumed.wait((message) => message.type === 'seat')).side, 'black');
  assert.equal((await resumed.wait(state())).room.game.history.length, 1);
});

test('both requesters can disable timing for the next round and old readiness cannot start the new round', async (t) => {
  const { red, black, start, advance } = await setup(t);
  await start();
  for (const [round, requester, responder] of [[0, red, black], [1, black, red]]) {
    requester.send({ type: 'restart-request', revision: round, config: { redSide: 'red', timed: false } });
    const pending = (await responder.wait(state((room) => room.round === round && room.pendingRestart))).room.pendingRestart;
    responder.send({ type: 'restart-answer', requestId: pending.id, accept: true });
    const next = (await red.wait(state((room) => room.round === round + 1))).room;
    assert.equal(next.clock.enabled, false);
    assert.equal(next.clock.started, false);
    red.send({ type: 'ready', ready: true, round });
    assert.match((await red.wait(error)).error, /失效/);
    for (const player of [red, black]) player.send({ type: 'ready', ready: true, round: round + 1 });
    await red.wait(state((room) => room.phase === 'countdown' && room.round === round + 1));
    advance(3000);
    assert.equal((await red.wait(state((room) => room.phase === 'playing' && room.round === round + 1))).room.clock.runningSide, null);
  }
});

test('malformed configuration and stale/self votes cannot overwrite an outstanding restart', async (t) => {
  const { red, black } = await setup(t);
  for (const config of [null, [], { redSide: 'host', timed: true }, { redSide: 'red', timed: 'true' },
    { redSide: 'red', timed: true, timeControl: { red: 6001, black: 9000 } }]) {
    red.send({ type: 'restart-request', config, revision: 0 });
    assert.match((await red.wait(error)).error, /配置|总时间/);
  }
  red.send({ type: 'restart-request', config: { redSide: 'red', timed: false }, revision: 0 });
  const first = (await black.wait(state((room) => room.pendingRestart))).room.pendingRestart;
  black.send({ type: 'restart-answer', requestId: first.id, accept: false });
  await red.wait(state((room) => !room.pendingRestart && room.players.black));
  red.send({ type: 'restart-request', config: { redSide: 'black', timed: false }, revision: 0 });
  const second = (await black.wait(state((room) => room.pendingRestart?.id !== first.id && room.pendingRestart))).room.pendingRestart;
  for (const [player, requestId, accept] of [[black, first.id, true], [black, undefined, true], [red, second.id, true], [black, second.id, 'yes']]) {
    player.send({ type: 'restart-answer', requestId, accept });
    assert.match((await player.wait(error)).error, /失效|回应|格式/);
  }
  red.send({ type: 'ready', ready: true, round: 0 });
  assert.match((await red.wait(error)).error, /投票/);
  black.send({ type: 'restart-answer', requestId: second.id, accept: true });
  assert.equal((await red.wait(state((room) => room.round === 1))).room.clock.enabled, false);
});

test('a timeout invalidates a pending restart so late consent cannot erase the result', async (t) => {
  const { red, black, start, advance } = await setup(t);
  await start();
  red.send({ type: 'restart-request', config: { redSide: 'black', timed: false }, revision: 0 });
  const request = (await black.wait(state((room) => room.pendingRestart))).room.pendingRestart;
  advance(6000);
  black.send({ type: 'restart-answer', requestId: request.id, accept: true });
  const expired = (await red.wait(state((room) => room.game.result))).room;
  assert.equal(expired.game.result.reason, 'timeout');
  assert.equal(expired.pendingRestart, null);
  assert.equal(expired.round, 0);
  assert.match((await black.wait(error)).error, /失效/);
});
