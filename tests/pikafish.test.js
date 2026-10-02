import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createPikafish, resolvePikafishPath } from '../src/server/pikafish.js';

const redMove = { from: { x: 4, y: 6 }, to: { x: 4, y: 5 } };
const blackMove = { from: { x: 4, y: 3 }, to: { x: 4, y: 4 } };

function fakeEngine(t, { bestmove = 'e3e4', position = 'position startpos', mode = 'normal', ...options } = {}) {
  // A real child process exercises streams, handshake, shutdown, and OS process cleanup.
  const source = `
    const { createInterface } = require('node:readline');
    const expectedPosition = ${JSON.stringify(position)};
    const mode = ${JSON.stringify(mode)};
    const seen = new Set();
    const say = (line) => process.stdout.write(line + '\\n');
    createInterface({ input: process.stdin }).on('line', (line) => {
      seen.add(line);
      if (line === 'uci') {
        if (mode === 'hang') return;
        if (mode === 'overflow') return process.stdout.write('x'.repeat(70000));
        if (mode === 'exit') return process.exit(1);
        say('id name Fake Pikafish');
        process.stdout.write('uci');
        setImmediate(() => say('ok'));
      } else if (line === 'isready') {
        for (const required of ['setoption name Threads value 2', 'setoption name Hash value 64', 'ucinewgame']) {
          if (!seen.has(required)) process.exit(2);
        }
        if (![...seen].some((item) => item.startsWith('setoption name EvalFile value '))) process.exit(3);
        say('readyok');
      } else if (line.startsWith('go ')) {
        if (line !== 'go movetime 1000' || !seen.has(expectedPosition)) process.exit(4);
        say('info depth 12 score cp 20 nodes 1000');
        say('bestmove ${bestmove} ponder a6a5');
      } else if (line === 'quit' && mode !== 'ignore-quit') process.exit(0);
    });
  `;
  const engine = createPikafish({
    executablePath: process.execPath, networkPath: process.execPath,
    args: ['-e', source], ...options,
  });
  t.after(() => engine.close());
  return engine;
}

test('Pikafish paths resolve development assets and unpacked packaged resources', () => {
  assert.match(resolvePikafishPath(undefined), /pikafish[\\/]pikafish\.exe$/);
  assert.equal(resolvePikafishPath('C:\\app\\resources'), join('C:\\app\\resources', 'pikafish', 'pikafish.exe'));
});

test('UCI handshake configures a strong search and translates red coordinates', async (t) => {
  const engine = fakeEngine(t);
  assert.deepEqual(await engine.getInfo(), { name: 'Pikafish', available: true });
  assert.deepEqual(await engine.bestMove([]), redMove);
});

test('complete validated history is sent with red and black coordinate conversion', async (t) => {
  const history = [redMove, blackMove, { from: { x: 1, y: 7 }, to: { x: 4, y: 7 } }];
  const original = structuredClone(history);
  const engine = fakeEngine(t, { position: 'position startpos moves e3e4 e6e5 b2e2', bestmove: 'b9c7' });
  assert.deepEqual(await engine.bestMove(history), { from: { x: 1, y: 0 }, to: { x: 2, y: 2 } });
  assert.deepEqual(history, original);
});

test('untrusted positions and illegal histories are rejected before starting the engine', async (t) => {
  const engine = fakeEngine(t);
  for (const history of [null, 'position fen injected', Array(1025).fill(redMove), [null],
    [{ from: { x: 4, y: '6\ngo infinite' }, to: redMove.to }], [blackMove], [redMove, redMove]]) {
    await assert.rejects(engine.bestMove(history), { code: 'INVALID_HISTORY', statusCode: 400 });
  }
});

test('missing binary and network have clear availability errors', async (t) => {
  const binaryMissing = createPikafish({ executablePath: join(import.meta.dirname, 'missing-pikafish.exe') });
  const networkMissing = createPikafish({ executablePath: process.execPath, networkPath: join(import.meta.dirname, 'missing-pikafish.nnue') });
  t.after(() => Promise.all([binaryMissing.close(), networkMissing.close()]));
  assert.equal((await binaryMissing.getInfo()).available, false);
  assert.match((await networkMissing.getInfo()).error, /模型文件/);
  await assert.rejects(binaryMissing.bestMove([]), { code: 'UNAVAILABLE', statusCode: 503 });
  await assert.rejects(networkMissing.bestMove([]), { code: 'UNAVAILABLE', statusCode: 503 });
});

test('invalid, illegal, and terminal engine replies are never returned as board moves', async (t) => {
  for (const [bestmove, code] of [['j3e4', 'INVALID_MOVE'], ['e3e5', 'INVALID_MOVE'], ['0000', 'NO_MOVE'], ['(none)', 'NO_MOVE']]) {
    const engine = fakeEngine(t, { bestmove });
    await assert.rejects(engine.bestMove([]), { code });
  }
});

test('hung engines time out, oversized output is bounded, and early exit is reported', async (t) => {
  const hung = fakeEngine(t, { mode: 'hang', timeoutMs: 300 });
  await assert.rejects(hung.bestMove([]), { code: 'TIMEOUT', statusCode: 504 });
  for (const mode of ['overflow', 'exit']) {
    const engine = fakeEngine(t, { mode });
    await assert.rejects(engine.bestMove([]), { code: 'ENGINE_FAILED', statusCode: 502 });
  }
});

test('abort stops an active engine and releases its concurrency slot', async (t) => {
  const engine = fakeEngine(t, { mode: 'hang', maxConcurrent: 1 });
  const controller = new AbortController();
  const first = assert.rejects(engine.bestMove([], { signal: controller.signal }), { name: 'AbortError', code: 'ABORTED' });
  await assert.rejects(engine.bestMove([]), { code: 'BUSY', statusCode: 429 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  await first;
  const nextController = new AbortController();
  const next = assert.rejects(engine.bestMove([], { signal: nextController.signal }), { code: 'ABORTED' });
  nextController.abort();
  await next;
});

test('an already aborted request never starts a search', async (t) => {
  const engine = fakeEngine(t);
  await assert.rejects(engine.bestMove([], { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.deepEqual(await engine.bestMove([]), redMove);
});

test('close cancels active work and prevents subsequent searches', async (t) => {
  const engine = fakeEngine(t, { mode: 'hang' });
  const pending = assert.rejects(engine.bestMove([]), { code: 'ABORTED' });
  await engine.close();
  await pending;
  assert.equal((await engine.getInfo()).available, false);
  await assert.rejects(engine.bestMove([]), { code: 'UNAVAILABLE' });
});

test('a completed engine that ignores quit is killed before the search slot is released', async (t) => {
  const engine = fakeEngine(t, { mode: 'ignore-quit', maxConcurrent: 1 });
  const first = engine.bestMove([]);
  await assert.rejects(engine.bestMove([]), { code: 'BUSY' });
  assert.deepEqual(await first, redMove);
  assert.deepEqual(await engine.bestMove([]), redMove);
});
