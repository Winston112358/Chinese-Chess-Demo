const MAX_BODY_BYTES = 128 * 1024;
const BODY_TIMEOUT_MS = 5000;

function requestError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function readJson(request, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(requestError('请求已取消', 499)); return; }
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish(requestError('请求读取超时，请重试', 408)), BODY_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
      signal.removeEventListener('abort', onAborted);
    };
    function finish(error, value) {
      cleanup();
      if (error) { request.resume(); reject(error); }
      else resolve(value);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return finish(requestError('棋局请求过大', 413));
      chunks.push(chunk);
    }
    function onEnd() {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(requestError('棋局请求格式不正确', 400)); }
    }
    function onError() { finish(requestError('请求连接已中断', 400)); }
    function onAborted() { finish(requestError('请求已取消', 499)); }
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
    signal.addEventListener('abort', onAborted, { once: true });
  });
}

function sameOrigin(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!request.headers.origin) return true;
  try { return new URL(request.headers.origin).host === request.headers.host; }
  catch { return false; }
}

export function createAiHttp(engine) {
  const pending = new Set();
  return {
    async handle(request, response, pathname) {
      if (pathname !== '/api/ai/info' && pathname !== '/api/ai/move') return false;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      const info = pathname === '/api/ai/info';
      const allowed = info ? ['GET', 'HEAD'] : ['POST'];
      if (!allowed.includes(request.method)) {
        response.writeHead(405, { Allow: allowed.join(', ') });
        response.end();
        return true;
      }
      const controller = new AbortController();
      pending.add(controller);
      const abort = () => controller.abort();
      response.once('close', abort);
      try {
        let result;
        if (info) result = await engine.getInfo();
        else {
          if (!sameOrigin(request)) throw requestError('请从象棋页面发起人机对局', 403);
          if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
            throw requestError('请求必须使用 JSON 格式', 415);
          }
          const body = await readJson(request, controller.signal);
          if (!body || typeof body !== 'object' || !Array.isArray(body.history)) {
            throw requestError('请求缺少走棋记录', 400);
          }
          result = { move: await engine.bestMove(body.history, { signal: controller.signal }) };
        }
        if (!response.destroyed) response.end(request.method === 'HEAD' ? undefined : JSON.stringify(result));
      } catch (error) {
        if (!response.destroyed) {
          response.statusCode = error.statusCode || 500;
          response.end(JSON.stringify({ error: error.statusCode ? error.message : '电脑对手暂时不可用，请重试', code: error.code || 'AI_REQUEST_FAILED' }));
        }
      } finally {
        response.off('close', abort);
        pending.delete(controller);
      }
      return true;
    },
    async close() {
      for (const controller of pending) controller.abort();
      await engine.close();
    },
  };
}
