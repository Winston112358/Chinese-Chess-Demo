import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server/server.js';
import { createConnection } from 'node:net';
import { once } from 'node:events';

async function fixture(t, overrides = {}) {
  const engine = {
    getInfo: async () => ({ name: 'Pikafish', available: true }),
    bestMove: async () => ({ from: { x: 0, y: 6 }, to: { x: 0, y: 5 } }),
    close: async () => {},
    ...overrides,
  };
  const server = await startServer({ port: 0, host: '127.0.0.1', aiEngine: engine });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const move = (body = { history: [] }, options = {}) => fetch(`${base}/api/ai/move`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options,
  });
  return { base, move };
}

test('AI HTTP reports availability and returns an engine move for the supplied history', async (t) => {
  let received;
  const { base, move } = await fixture(t, {
    bestMove: async (history, { signal }) => {
      received = history;
      assert.equal(signal.aborted, false);
      return { from: { x: 1, y: 0 }, to: { x: 2, y: 2 } };
    },
  });
  assert.deepEqual(await (await fetch(`${base}/api/ai/info`)).json(), { name: 'Pikafish', available: true });
  assert.equal(await (await fetch(`${base}/api/ai/info`, { method: 'HEAD' })).text(), '');
  const history = [{ from: { x: 0, y: 6 }, to: { x: 0, y: 5 } }];
  const response = await move({ history });
  assert.equal(response.status, 200);
  assert.deepEqual(received, history);
  assert.deepEqual(await response.json(), { move: { from: { x: 1, y: 0 }, to: { x: 2, y: 2 } } });
});

test('AI HTTP rejects cross-origin, malformed, oversized and incorrectly typed requests before searching', async (t) => {
  let searched = false;
  const { base, move } = await fixture(t, { bestMove: async () => { searched = true; } });
  assert.equal((await fetch(`${base}/api/ai/move`)).status, 405);
  assert.equal((await fetch(`${base}/api/ai/info`, { method: 'POST' })).status, 405);
  assert.equal((await move({}, { headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' } })).status, 403);
  assert.equal((await move({}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await move({}, { body: '{broken' })).status, 400);
  assert.equal((await move({ history: null })).status, 400);
  assert.equal((await move({ history: [], padding: 'x'.repeat(129 * 1024) })).status, 413);
  assert.equal(searched, false);
});

test('AI HTTP exposes actionable engine errors without returning internal failures', async (t) => {
  let internal = false;
  const { move } = await fixture(t, {
    bestMove: async () => {
      if (internal) throw new Error('private implementation details');
      throw Object.assign(new Error('电脑对手忙，请稍后重试'), { code: 'BUSY', statusCode: 429 });
    },
  });
  const busy = await move();
  assert.equal(busy.status, 429);
  assert.equal((await busy.json()).code, 'BUSY');
  internal = true;
  const failed = await move();
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /private/);
});

test('disconnecting an AI HTTP request aborts its engine search', async (t) => {
  let searchStarted;
  const started = new Promise((resolve) => { searchStarted = resolve; });
  let searchAborted;
  const aborted = new Promise((resolve) => { searchAborted = resolve; });
  const { move } = await fixture(t, {
    bestMove: (_history, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        searchAborted();
        reject(Object.assign(new Error('取消'), { statusCode: 499 }));
      }, { once: true });
      searchStarted();
    }),
  });
  const controller = new AbortController();
  const request = move({ history: [] }, { signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await started;
  controller.abort();
  await rejected;
  await aborted;
});

test('server shutdown closes incomplete uploads without waiting for their body timeout', { timeout: 2000 }, async (t) => {
  let engineClosed = false;
  const server = await startServer({ port: 0, host: '127.0.0.1', aiEngine: {
    getInfo: async () => ({ available: true }),
    bestMove: async () => { throw new Error('An incomplete request must not search'); },
    close: async () => { engineClosed = true; },
  } });
  const socket = createConnection(server.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write('POST /api/ai/move HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"history":');
  await new Promise((resolve) => setTimeout(resolve, 25));
  const disconnected = once(socket, 'close');
  await server.close();
  await disconnected;
  assert.equal(engineClosed, true);
});
