import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../src/server/server.js';
import { parseRoundConfig } from '../src/server/round.js';

const budgets = { red: 6000, black: 9000 };
const redPawn = { from: { x: 0, y: 6 }, to: { x: 0, y: 5 } };
const blackPawn = { from: { x: 0, y: 3 }, to: { x: 0, y: 4 } };
const state = (revision, predicate = () => true) => (message) => message.type === 'state'
  && message.room.revision === revision && predicate(message.room);
const error = (message) => message.type === 'error';

async function client(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waits = [];
  let room;
  let side;
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'state') room = message.room;
    if (message.type === 'seat') side = message.side;
    const index = waits.findIndex((wait) => wait.matches(message));
    if (index < 0) inbox.push(message);
    else {
      const [wait] = waits.splice(index, 1);
      clearTimeout(wait.timer);
      wait.resolve(message);
    }
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    socket, get room() { return room; }, get side() { return side; },
    send: (message) => socket.send(JSON.stringify(message)),
    wait: (matches) => new Promise((resolve, reject) => {
      const index = inbox.findIndex(matches);
      if (index >= 0) return resolve(inbox.splice(index, 1)[0]);
      const wait = { matches, resolve, timer: setTimeout(() => reject(new Error(
        `Room message timed out; revision=${room?.revision}, phase=${room?.phase}`,
      )), 3000) };
      waits.push(wait);
    }),
  };
}

async function setup(t, { moveTimeMs = 2000, timed = true, clockTickMs = 60_000, countdownMs = 0, aiEngine } = {}) {
  let elapsed = 0;
  const server = await startServer({
    port: 0, host: '127.0.0.1', aiEngine,
    roomOptions: { now: () => elapsed, clockTickMs, countdownMs },
  });
  t.after(() => server.close());
  const red = await client(server.port);
  red.send({ type: 'create', timed, moveTimeMs, timeControl: budgets });
  const redSeat = await red.wait((message) => message.type === 'seat');
  await red.wait(state(0));
  const black = await client(server.port);
  black.send({ type: 'join', code: redSeat.code, moveTimeMs: 3_600_000 });
  const blackSeat = await black.wait((message) => message.type === 'seat');
  const joined = (await black.wait(state(0))).room;
  await red.wait(state(0, (room) => room.players.black));
  const both = async (revision, predicate) => {
    const latest = (await red.wait(state(revision, predicate))).room;
    assert.deepEqual((await black.wait(state(revision, predicate))).room, latest);
    return latest;
  };
  return {
    server, red, black, redSeat, blackSeat, joined, both,
    advance: (ms) => { elapsed += ms; },
    start: async () => {
      for (const player of [red, black]) player.send({ type: 'ready', ready: true, round: player.room.round });
      if (countdownMs) {
        await both(red.room.revision, (room) => room.phase === 'countdown');
        elapsed += countdownMs;
        red.send({ type: 'ready', ready: true, round: red.room.round });
        assert.match((await red.wait(error)).error, /准备阶段/);
      }
      return both(red.room.revision, (room) => room.phase === 'playing');
    },
  };
}

async function move(view, player, revision, points) {
  player.send({ type: 'move', revision, ...points });
  return view.both(revision + 1);
}

test('restart parsing preserves omitted limits, permits explicit disable, and forces untimed limits off', () => {
  const defaults = { redSide: 'red', timed: true, timeControl: budgets, moveTimeMs: 2000 };
  const legacy = { redSide: 'black', timed: true, timeControl: budgets };
  assert.deepEqual(parseRoundConfig(undefined, defaults).config, defaults);
  assert.equal(parseRoundConfig(legacy, defaults).config.moveTimeMs, 2000);
  assert.equal(parseRoundConfig({ ...legacy, moveTimeMs: null }, defaults).config.moveTimeMs, null);
  assert.equal(parseRoundConfig({ ...legacy, moveTimeMs: 3_600_000 }, defaults).config.moveTimeMs, 3_600_000);
  assert.equal(parseRoundConfig({ redSide: 'red', timed: false, moveTimeMs: 'ignored' }, defaults).config.moveTimeMs, null);
  assert.equal(parseRoundConfig(legacy, { ...defaults, moveTimeMs: undefined }).config.moveTimeMs, null);
  for (const moveTimeMs of [0, 999, 1001, 3_601_000, '2000', [], {}]) {
    assert.equal(parseRoundConfig({ ...legacy, moveTimeMs }, defaults).ok, false);
  }
});

test('create rejects invalid limits before assigning a seat; legacy and untimed clients get null fields', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const player = await client(server.port);
  for (const moveTimeMs of [0, 999, 1001, 3_601_000, '2000', true, []]) {
    player.send({ type: 'create', moveTimeMs });
    assert.match((await player.wait(error)).error, /单步限时/);
  }
  player.send({ type: 'create' });
  await player.wait((message) => message.type === 'seat');
  const legacy = (await player.wait(state(0))).room;
  assert.equal(legacy.clock.moveTimeMs, null);
  assert.equal(legacy.clock.moveRemainingMs, null);
  const untimed = await client(server.port);
  untimed.send({ type: 'create', timed: false, moveTimeMs: 'ignored' });
  await untimed.wait((message) => message.type === 'seat');
  const waiting = (await untimed.wait(state(0))).room;
  assert.equal(waiting.clock.enabled, false);
  assert.equal(waiting.clock.moveTimeMs, null);
  assert.equal(waiting.clock.moveRemainingMs, null);
});

test('preparation and the full countdown consume neither total nor single-move time', async (t) => {
  const view = await setup(t, { countdownMs: 3000 });
  const { red, black, joined, advance } = view;
  assert.equal(joined.clock.moveTimeMs, 2000, 'Join messages cannot change host settings');
  assert.equal(joined.clock.moveRemainingMs, 2000);
  advance(120_000);
  red.send({ type: 'ready', ready: true, round: 0 });
  const waiting = (await view.both(0, (room) => room.ready.red)).clock;
  assert.deepEqual(waiting.remainingMs, budgets);
  assert.equal(waiting.moveRemainingMs, 2000);
  assert.equal(waiting.runningSide, null);
  advance(120_000);
  black.send({ type: 'ready', ready: true, round: 0 });
  await view.both(0, (room) => room.phase === 'countdown');
  advance(2999);
  red.send({ type: 'move', revision: 0, ...redPawn });
  assert.match((await red.wait(error)).error, /倒数/);
  advance(1);
  const moved = await move(view, red, 0, redPawn);
  assert.deepEqual(moved.clock.remainingMs, budgets);
  assert.equal(moved.clock.moveRemainingMs, 2000);
  assert.equal(moved.clock.runningSide, 'black');
});

test('legal moves reset the next turn; invalid, wrong-side and stale moves consume time without resetting', async (t) => {
  const view = await setup(t);
  const { red, black, advance } = view;
  await view.start();
  advance(400);
  red.send({ type: 'move', revision: 0, from: { x: 0, y: 6 }, to: { x: 1, y: 6 } });
  assert.match((await red.wait(error)).error, /兵卒/);
  advance(300);
  black.send({ type: 'move', revision: 0, ...blackPawn });
  assert.match((await black.wait(error)).error, /轮到/);
  advance(300);
  red.send({ type: 'move', revision: 99, ...redPawn });
  const stale = (await red.wait(state(0, (room) => room.clock.moveRemainingMs === 1000))).room;
  assert.match((await red.wait(error)).error, /更新/);
  assert.equal(stale.clock.remainingMs.red, 5000);
  const next = await move(view, red, 0, redPawn);
  assert.equal(next.clock.runningSide, 'black');
  assert.equal(next.clock.moveRemainingMs, 2000);
  assert.equal(next.clock.remainingMs.red, 5000);
  advance(500);
  const returned = await move(view, black, 1, blackPawn);
  assert.equal(returned.clock.moveRemainingMs, 2000);
  assert.deepEqual(returned.clock.remainingMs, { red: 5000, black: 8500 });
});

test('an expired stale move is adjudicated before revision checks and cannot enter the move history', async (t) => {
  const view = await setup(t);
  await view.start();
  view.advance(2000);
  view.red.send({ type: 'move', revision: 99, ...redPawn });
  const ended = await view.both(1, (room) => Boolean(room.game.result));
  assert.deepEqual(ended.game.result, { winner: 'black', loser: 'red', reason: 'move-timeout' });
  assert.equal(ended.game.history.length, 0);
  assert.equal(ended.clock.moveRemainingMs, 0);
  assert.equal(ended.clock.remainingMs.red, 4000);
  assert.equal(ended.clock.runningSide, null);
  assert.match((await view.red.wait(error)).error, /结束/);
});

test('a delayed tick chooses the first limit; total time keeps its existing timeout result', async (t) => {
  for (const [limit, reason, totalLeft, moveLeft] of [[2000, 'move-timeout', 4000, 0], [9000, 'timeout', 0, 3000]]) {
    const view = await setup(t, { moveTimeMs: limit, clockTickMs: 10 });
    await view.start();
    view.advance(60_000);
    const ended = await view.both(1, (room) => Boolean(room.game.result));
    assert.equal(ended.game.result.reason, reason);
    assert.equal(ended.clock.remainingMs.red, totalLeft);
    assert.equal(ended.clock.moveRemainingMs, moveLeft);
    view.advance(60_000);
    view.red.send({ type: 'move', revision: 1, ...redPawn });
    assert.match((await view.red.wait(error)).error, /结束/);
    assert.equal(view.red.room.clock.remainingMs.red, totalLeft);
  }
});

test('refusing a vote preserves elapsed move time; accepting undo starts the restored player without total-time refund', async (t) => {
  const view = await setup(t);
  const { red, black, advance } = view;
  await view.start();
  advance(400);
  await move(view, red, 0, redPawn);
  advance(300);
  black.send({ type: 'action-request', revision: 1, action: 'draw' });
  const draw = await view.both(1, (room) => Boolean(room.pendingAction));
  assert.equal(draw.clock.moveRemainingMs, 1700);
  advance(300);
  red.send({ type: 'action-answer', requestId: draw.pendingAction.id, accept: false });
  const declined = await view.both(1, (room) => !room.pendingAction);
  assert.equal(declined.clock.moveRemainingMs, 1400);
  advance(100);
  red.send({ type: 'action-request', revision: 1, action: 'undo' });
  const requested = await view.both(1, (room) => room.pendingAction?.action === 'undo');
  assert.equal(requested.clock.moveRemainingMs, 1300);
  advance(200);
  black.send({ type: 'action-answer', requestId: requested.pendingAction.id, accept: true });
  const restored = await view.both(2);
  assert.equal(restored.game.history.length, 0);
  assert.equal(restored.game.turn, 'red');
  assert.equal(restored.clock.runningSide, 'red');
  assert.equal(restored.clock.moveRemainingMs, 2000);
  assert.deepEqual(restored.clock.remainingMs, { red: 5600, black: 8100 });
  advance(1500);
  assert.equal((await move(view, red, 2, redPawn)).clock.remainingMs.red, 4100);
});

test('single-move expiry cancels pending undo and restart votes, and late consent cannot erase the loss', async (t) => {
  for (const vote of ['undo', 'restart']) {
    const view = await setup(t);
    await view.start();
    if (vote === 'undo') await move(view, view.red, 0, redPawn);
    const revision = vote === 'undo' ? 1 : 0;
    view.red.send(vote === 'undo'
      ? { type: 'action-request', action: 'undo', revision }
      : { type: 'restart-request', revision, config: { redSide: 'black', timed: false } });
    const requested = await view.both(revision, (room) => Boolean(room.pendingAction || room.pendingRestart));
    const request = requested.pendingAction || requested.pendingRestart;
    view.advance(2000);
    view.black.send({ type: vote === 'undo' ? 'action-answer' : 'restart-answer', requestId: request.id, accept: true });
    const ended = await view.both(revision + 1, (room) => Boolean(room.game.result));
    assert.equal(ended.game.result.reason, 'move-timeout');
    assert.equal(ended.pendingAction, null);
    assert.equal(ended.pendingRestart, null);
    assert.equal(ended.round, 0);
    assert.equal(ended.game.history.length, vote === 'undo' ? 1 : 0);
    assert.match((await view.black.wait(error)).error, /失效/);
  }
});

test('disconnect and resume keep the same single-move deadline and preserve the adjudicated result', async (t) => {
  const view = await setup(t, { clockTickMs: 10 });
  await view.start();
  view.advance(500);
  view.red.socket.close();
  const disconnected = (await view.black.wait(state(0, (room) => !room.players.red))).room;
  assert.equal(disconnected.clock.moveRemainingMs, 1500);
  assert.equal(disconnected.clock.runningSide, 'red');
  view.advance(1000);
  const resumed = await client(view.server.port);
  resumed.send({ type: 'resume', code: view.redSeat.code, token: view.redSeat.token });
  await resumed.wait((message) => message.type === 'seat');
  const running = (await resumed.wait(state(0))).room;
  assert.equal(running.clock.moveRemainingMs, 500);
  view.advance(500);
  const ended = (await resumed.wait(state(1, (room) => Boolean(room.game.result)))).room;
  assert.equal(ended.game.result.reason, 'move-timeout');
  assert.equal(ended.game.result.loser, 'red');
  resumed.send({ type: 'move', revision: 1, ...redPawn });
  assert.match((await resumed.wait(error)).error, /结束/);
});

test('configured and legacy restarts preserve the limit through swapping seats and can explicitly turn it off', async (t) => {
  const view = await setup(t);
  await view.start();
  const configs = [
    undefined,
    { redSide: 'red', timed: true, timeControl: budgets },
    { redSide: 'black', timed: true, timeControl: budgets, moveTimeMs: 3000 },
    { redSide: 'red', timed: true, timeControl: budgets, moveTimeMs: null },
    { redSide: 'red', timed: false, moveTimeMs: 2000 },
  ];
  for (const [round, config] of configs.entries()) {
    const revision = view.red.room.revision;
    view.red.send({ type: 'restart-request', revision, config });
    const requested = await view.both(revision, (room) => room.round === round && Boolean(room.pendingRestart));
    const limit = [2000, 2000, 3000, null, null][round];
    assert.equal(requested.pendingRestart.config.moveTimeMs, limit);
    view.black.send({ type: 'restart-answer', requestId: requested.pendingRestart.id, accept: true });
    const fresh = await view.both(revision + 1, (room) => room.round === round + 1);
    assert.equal(fresh.clock.moveTimeMs, limit);
    assert.equal(fresh.clock.moveRemainingMs, limit);
    assert.equal(fresh.clock.runningSide, null);
    assert.equal(fresh.clock.started, false);
    assert.deepEqual(fresh.clock.remainingMs, budgets);
    if (round === 2) {
      assert.equal(view.red.side, 'black');
      assert.equal(view.black.side, 'red');
      const playing = await view.start();
      assert.equal(playing.clock.moveRemainingMs, 3000);
      const moved = await move(view, view.black, fresh.revision, redPawn);
      assert.equal(moved.clock.runningSide, 'black');
      assert.equal(moved.clock.moveRemainingMs, 3000);
    }
  }
});

test('untimed play disables a supplied move limit for arbitrarily long turns', async (t) => {
  const view = await setup(t, { timed: false, moveTimeMs: 1000 });
  const playing = await view.start();
  assert.equal(playing.clock.moveTimeMs, null);
  view.advance(100_000_000);
  const moved = await move(view, view.red, 0, redPawn);
  assert.equal(moved.game.result, null);
  assert.equal(moved.clock.moveRemainingMs, null);
  assert.deepEqual(moved.clock.remainingMs, budgets);
});

test('AI analysis continues under the room deadline and its late result cannot authorize a move', async (t) => {
  let began;
  const analyzing = new Promise((resolve) => { began = resolve; });
  let finish;
  const result = new Promise((resolve) => { finish = resolve; });
  const engine = { getInfo: async () => ({}), bestMove: async () => { began(); return result; }, close: async () => { finish(redPawn); } };
  const view = await setup(t, { clockTickMs: 10, aiEngine: engine });
  await view.start();
  const response = fetch(`http://127.0.0.1:${view.server.port}/api/ai/move`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ history: [] }),
  });
  await analyzing;
  view.advance(2000);
  const ended = await view.both(1, (room) => Boolean(room.game.result));
  assert.equal(ended.game.result.reason, 'move-timeout');
  assert.equal(ended.game.history.length, 0);
  finish(redPawn);
  assert.deepEqual(await (await response).json(), { move: redPawn });
  view.red.send({ type: 'move', revision: 0, ...redPawn });
  assert.match((await view.red.wait(error)).error, /结束/);
});
