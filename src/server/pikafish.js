import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMove, createInitialGame, insideBoard, validateMove } from '../shared/rules.js';

export class EngineError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = code === 'ABORTED' ? 'AbortError' : 'EngineError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function resolvePikafishPath(resourcesPath) {
  return resourcesPath
    ? join(resourcesPath, 'pikafish', 'pikafish.exe')
    : fileURLToPath(new URL('../../vendor/pikafish/pikafish.exe', import.meta.url));
}

const aborted = () => new EngineError('已取消皮卡鱼思考', 'ABORTED', 499);
const unavailable = () => new EngineError('未找到皮卡鱼引擎，请使用包含 AI 的完整程序包', 'UNAVAILABLE', 503);
const missingNetwork = () => new EngineError('未找到皮卡鱼模型文件 pikafish.nnue，请使用包含 AI 的完整程序包', 'UNAVAILABLE', 503);
const pointToUci = ({ x, y }) => `${String.fromCharCode(97 + x)}${9 - y}`;

// Reconstruct only normal games. Never accept client-supplied boards, FEN, or UCI commands.
function replayHistory(history) {
  if (!Array.isArray(history) || history.length > 1024) {
    throw new EngineError('棋谱格式错误，最多支持 1024 步', 'INVALID_HISTORY', 400);
  }
  let game = createInitialGame();
  const moves = [];
  for (const [index, move] of history.entries()) {
    if (!move || !insideBoard(move.from) || !insideBoard(move.to)) {
      throw new EngineError(`第 ${index + 1} 步坐标无效`, 'INVALID_HISTORY', 400);
    }
    const result = applyMove(game, move.from, move.to);
    if (!result.ok) throw new EngineError(`第 ${index + 1} 步无效：${result.error}`, 'INVALID_HISTORY', 400);
    game = result.game;
    moves.push(`${pointToUci(move.from)}${pointToUci(move.to)}`);
  }
  if (game.result) throw new EngineError('棋局已经结束，请重新开始或悔棋', 'GAME_OVER', 409);
  return { game, position: `position startpos${moves.length ? ` moves ${moves.join(' ')}` : ''}` };
}

function decodeBestMove(token, game) {
  if (token === '(none)' || token === '0000') {
    throw new EngineError('皮卡鱼判断该局已结束，可能触发了重复局面规则；请悔棋或重新开始', 'NO_MOVE', 409);
  }
  if (!/^[a-i][0-9][a-i][0-9]$/.test(token)) {
    throw new EngineError('皮卡鱼返回了无法识别的走法', 'INVALID_MOVE', 502);
  }
  const move = {
    from: { x: token.charCodeAt(0) - 97, y: 9 - Number(token[1]) },
    to: { x: token.charCodeAt(2) - 97, y: 9 - Number(token[3]) },
  };
  if (!validateMove(game, move.from, move.to).ok) {
    throw new EngineError('皮卡鱼返回的走法与当前棋局不符，请重试', 'INVALID_MOVE', 502);
  }
  return move;
}

function search({ executablePath, args, evalFile, position, game, moveTimeMs, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      cwd: dirname(executablePath), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let phase = 'uci';
    let buffer = '';
    let diagnostic = '';
    let outcome;
    let killTimer;
    const timer = setTimeout(() => finish(new EngineError('皮卡鱼思考超时，请重试', 'TIMEOUT', 504)), timeoutMs);
    const onAbort = () => {
      if (outcome && !outcome.error) outcome.error = aborted();
      else finish(aborted());
    };

    function send(command) {
      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${command}\n`);
    }

    // Keep the concurrency slot until the process actually exits, including cancellation.
    function finish(error, move) {
      if (outcome) return;
      outcome = { error, move };
      clearTimeout(timer);
      if (error) send('stop');
      send('quit');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
    }

    child.once('spawn', () => {
      if (signal.aborted) finish(aborted());
      else send('uci');
    });
    child.stdin.on('error', () => {
      finish(new EngineError('无法向皮卡鱼发送棋局，请重试', 'ENGINE_FAILED', 502));
    });
    child.stderr.on('data', (data) => { diagnostic = (diagnostic + data.toString()).slice(-2000); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      if (outcome) return;
      buffer += data;
      // Normal UCI lines are small. Bound incomplete lines and do not accumulate search output.
      if (buffer.length > 65_536) {
        finish(new EngineError('皮卡鱼输出异常，请重试', 'ENGINE_FAILED', 502));
        return;
      }
      let newline;
      while (!outcome && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 16_384) {
          finish(new EngineError('皮卡鱼输出异常，请重试', 'ENGINE_FAILED', 502));
        } else if (phase === 'uci' && line === 'uciok') {
          phase = 'ready';
          send('setoption name Threads value 2');
          send('setoption name Hash value 64');
          if (evalFile) send(`setoption name EvalFile value ${evalFile}`);
          send('ucinewgame');
          send('isready');
        } else if (phase === 'ready' && line === 'readyok') {
          phase = 'search';
          send(position);
          send(`go movetime ${moveTimeMs}`);
        } else if (phase === 'search' && line.startsWith('bestmove ')) {
          try { finish(null, decodeBestMove(line.split(/\s+/)[1], game)); }
          catch (error) { finish(error); }
        } else if (line.startsWith('info string ERROR') || /NNUE.*(?:not found|not loaded)/i.test(line)) {
          diagnostic = line.slice(-2000);
        }
      }
    });
    child.once('error', (error) => {
      finish(error.code === 'ENOENT' ? unavailable()
        : new EngineError('皮卡鱼无法启动，请检查引擎文件和系统兼容性', 'ENGINE_FAILED', 503));
    });
    child.once('close', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      if (!outcome) {
        const detail = /nnue|network|evalfile/i.test(diagnostic) ? '，请检查配套模型文件' : '，请检查引擎文件和系统兼容性';
        outcome = { error: new EngineError(`皮卡鱼意外退出${detail}`, 'ENGINE_FAILED', 502) };
      }
      if (outcome.error) reject(outcome.error);
      else resolve(outcome.move);
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function createPikafish({
  executablePath = resolvePikafishPath(), networkPath = join(dirname(executablePath), 'pikafish.nnue'),
  args = [], moveTimeMs = 1000, timeoutMs = 15_000, maxConcurrent = 2,
} = {}) {
  const active = new Set();
  let closed = false;

  async function getInfo() {
    try {
      if (closed) throw new Error('closed');
      await access(executablePath);
      try { await access(networkPath); }
      catch { return { name: 'Pikafish', available: false, error: missingNetwork().message }; }
      return { name: 'Pikafish', available: true };
    } catch {
      return { name: 'Pikafish', available: false, error: unavailable().message };
    }
  }

  async function bestMove(history, { signal } = {}) {
    if (signal?.aborted) throw aborted();
    if (closed) throw unavailable();
    if (active.size >= maxConcurrent) throw new EngineError('皮卡鱼正在处理其他棋局，请稍后重试', 'BUSY', 429);
    const { game, position } = replayHistory(history);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const job = { controller, promise: null };
    active.add(job);
    job.promise = (async () => {
      try {
        try { await access(executablePath); }
        catch { throw unavailable(); }
        try { await access(networkPath); }
        catch { throw missingNetwork(); }
        if (controller.signal.aborted) throw aborted();
        return await search({ executablePath, args, evalFile: networkPath, position, game, moveTimeMs, timeoutMs, signal: controller.signal });
      } finally {
        active.delete(job);
        signal?.removeEventListener('abort', onAbort);
      }
    })();
    return job.promise;
  }

  async function close() {
    closed = true;
    const jobs = [...active];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map((job) => job.promise));
  }

  return { getInfo, bestMove, close };
}
