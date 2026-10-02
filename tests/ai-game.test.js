import test from 'node:test';
import assert from 'node:assert/strict';
import { aiUndoCount, createAiSearch } from '../web/ai-game.js';
import { applyMove, createInitialGame, undoMove } from '../src/shared/rules.js';

const p = (x, y) => ({ x, y });
const redMove = { from: p(0, 6), to: p(0, 5) };
const blackMove = { from: p(0, 3), to: p(0, 4) };
const nextRedMove = { from: p(2, 6), to: p(2, 5) };
const jsonResponse = (body, ok = true) => ({ ok, json: async () => body });
const moved = (game, move) => {
  const result = applyMove(game, move.from, move.to);
  assert.equal(result.ok, true, result.error);
  return result.game;
};
function rewindPlayer(game, humanSide) {
  const count = aiUndoCount(game, humanSide);
  for (let i = 0; i < count; i++) game = undoMove(game);
  return game;
}

test('red player can undo while computer thinks or after its response', () => {
  const initial = createInitialGame();
  const waiting = moved(initial, redMove);
  const answered = moved(waiting, blackMove);
  assert.equal(aiUndoCount(initial, 'red'), 0);
  assert.equal(aiUndoCount(waiting, 'red'), 1);
  assert.equal(aiUndoCount(answered, 'red'), 2);
  assert.deepEqual(rewindPlayer(waiting, 'red'), initial);
  assert.deepEqual(rewindPlayer(answered, 'red'), initial);
});

test('black player cannot undo the computer opening and remains able to undo later', () => {
  const initial = createInitialGame();
  const opening = moved(initial, redMove);
  const waiting = moved(opening, blackMove);
  const answered = moved(waiting, nextRedMove);
  assert.equal(aiUndoCount(initial, 'black'), 0);
  assert.equal(aiUndoCount(opening, 'black'), 0);
  assert.deepEqual(rewindPlayer(opening, 'black'), opening);
  assert.equal(aiUndoCount(waiting, 'black'), 1);
  assert.equal(aiUndoCount(answered, 'black'), 2);
  assert.deepEqual(rewindPlayer(answered, 'black'), opening);
  assert.equal(rewindPlayer(answered, 'black').turn, 'black');
});

test('search sends only real move coordinates and reads the engine response', async () => {
  const game = moved(createInitialGame(), redMove);
  const before = structuredClone(game);
  let request;
  const engine = createAiSearch({ fetchImpl: async (url, options) => {
    request = { url, options };
    return jsonResponse({ move: blackMove });
  } });
  assert.deepEqual(await engine.search(game), blackMove);
  assert.equal(request.url, '/api/ai/move');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { history: [redMove] });
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(game, before);
});

test('cancel aborts a request and ignores a late response even if transport ignores abort', async () => {
  let resolveResponse;
  let signal;
  const engine = createAiSearch({ fetchImpl: (_url, options) => {
    signal = options.signal;
    return new Promise((resolve) => { resolveResponse = resolve; });
  } });
  const result = engine.search(createInitialGame());
  engine.cancel();
  assert.equal(signal.aborted, true);
  resolveResponse(jsonResponse({ move: redMove }));
  assert.equal(await result, null);
});

test('starting a new search cannot let the former search overwrite its result', async () => {
  const requests = [];
  const engine = createAiSearch({ fetchImpl: (_url, options) => new Promise((resolve) => {
    requests.push({ resolve, signal: options.signal });
  }) });
  const older = engine.search(createInitialGame());
  const latest = engine.search(moved(createInitialGame(), redMove));
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve(jsonResponse({ move: blackMove }));
  assert.deepEqual(await latest, blackMove);
  requests[0].resolve(jsonResponse({ error: 'old error' }, false));
  assert.equal(await older, null);
});

test('a cancellation while JSON is being read still prevents a stale move', async () => {
  let resolveBody;
  let readingBody;
  const beganReading = new Promise((resolve) => { readingBody = resolve; });
  const engine = createAiSearch({ fetchImpl: async () => ({
    ok: true,
    json: () => {
      readingBody();
      return new Promise((resolve) => { resolveBody = resolve; });
    },
  }) });
  const result = engine.search(createInitialGame());
  await beganReading;
  engine.cancel();
  resolveBody({ move: redMove });
  assert.equal(await result, null);
});

test('server failures remain visible and a subsequent retry can succeed', async () => {
  let fail = true;
  const engine = createAiSearch({ fetchImpl: async () => fail
    ? jsonResponse({ error: '引擎正在忙，请稍后重试', code: 'AI_BUSY' }, false)
    : jsonResponse({ move: redMove }) });
  await assert.rejects(engine.search(createInitialGame()), /引擎正在忙/);
  fail = false;
  assert.deepEqual(await engine.search(createInitialGame()), redMove);
});

test('missing move is rejected and request timeout aborts the engine transport', async () => {
  const missing = createAiSearch({ fetchImpl: async () => jsonResponse({}) });
  await assert.rejects(missing.search(createInitialGame()), /有效着法/);
  const timed = createAiSearch({ timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }) });
  await assert.rejects(timed.search(createInitialGame()), /响应超时/);
});
