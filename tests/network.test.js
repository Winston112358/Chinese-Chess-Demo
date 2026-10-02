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

test('HTTP serves only app assets and reports LAN addresses', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  for (const path of ['/', '/style.css', '/app.js', '/board.js', '/shared/rules.js']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 20);
  }
  assert.ok(Array.isArray((await (await fetch(base + '/api/server-info')).json()).addresses));
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
