import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { lanInfo } from './network.js';
import { WebSocketServer } from 'ws';
import { attachRooms } from './rooms.js';
import { createPikafish } from './pikafish.js';
import { createAiHttp } from './ai-http.js';

const assets = new Map([
  ['/', ['../../web/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['../../web/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['../../web/app.js', 'text/javascript; charset=utf-8']],
  ['/ai-game.js', ['../../web/ai-game.js', 'text/javascript; charset=utf-8']],
  ['/room-controls.js', ['../../web/room-controls.js', 'text/javascript; charset=utf-8']],
  ['/board.js', ['../../web/board.js', 'text/javascript; charset=utf-8']],
  ['/piece-glyph.js', ['../../web/piece-glyph.js', 'text/javascript; charset=utf-8']],
  ['/game-tools.js', ['../../web/game-tools.js', 'text/javascript; charset=utf-8']],
  ['/move-notation.js', ['../../web/move-notation.js', 'text/javascript; charset=utf-8']],
  ['/game-tools.css', ['../../web/game-tools.css', 'text/css; charset=utf-8']],
  ['/style.css', ['../../web/style.css', 'text/css; charset=utf-8']],
  ['/appearance.css', ['../../web/appearance.css', 'text/css; charset=utf-8']],
  ['/appearance.js', ['../../web/appearance.js', 'text/javascript; charset=utf-8']],
  ['/appearance-presets.js', ['../../web/appearance-presets.js', 'text/javascript; charset=utf-8']],
  ['/appearance-colors.js', ['../../web/appearance-colors.js', 'text/javascript; charset=utf-8']],
  ['/fonts/xiangqi-xingkai.woff2', ['../../web/fonts/xiangqi-xingkai.woff2', 'font/woff2']],
  ['/fonts/xiangqi-running.woff2', ['../../web/fonts/xiangqi-running.woff2', 'font/woff2']],
  ['/fonts/xiangqi-kai.woff2', ['../../web/fonts/xiangqi-kai.woff2', 'font/woff2']],
  ['/fonts/xiangqi-regular.woff2', ['../../web/fonts/xiangqi-regular.woff2', 'font/woff2']],
  ['/fonts/xiangqi-clerical.ttf', ['../../web/fonts/xiangqi-clerical.ttf', 'font/ttf']],
  ['/fonts/xiangqi-clerical-square.ttf', ['../../web/fonts/xiangqi-clerical-square.ttf', 'font/ttf']],
  ['/fonts/clerical-square-metrics.js', ['../../web/fonts/clerical-square-metrics.js', 'text/javascript; charset=utf-8']],
  ['/fonts/clerical-square-metrics.json', ['../../web/fonts/clerical-square-metrics.json', 'application/json; charset=utf-8']],
  ['/fonts/clerical-metrics.js', ['../../web/fonts/clerical-metrics.js', 'text/javascript; charset=utf-8']],
  ['/fonts/clerical-metrics.json', ['../../web/fonts/clerical-metrics.json', 'application/json; charset=utf-8']],
  ['/fonts/aoyagi-original.zip', ['../../web/fonts/aoyagi-original.zip', 'application/zip']],
  ['/fonts/LICENSE-aoyagi.txt', ['../../web/fonts/LICENSE-aoyagi.txt', 'text/plain; charset=Shift_JIS']],
  ['/fonts/moe-clerical-original.zip', ['../../web/fonts/moe-clerical-original.zip', 'application/zip']],
  ['/fonts/LICENSE-moe-clerical.md', ['../../web/fonts/LICENSE-moe-clerical.md', 'text/plain; charset=utf-8']],
  ['/fonts/CC-BY-ND-3.0-TW.html', ['../../web/fonts/CC-BY-ND-3.0-TW.html', 'text/html; charset=utf-8']],
  ['/shared/rules.js', ['../shared/rules.js', 'text/javascript; charset=utf-8']],
  ['/shared/adjudication.js', ['../shared/adjudication.js', 'text/javascript; charset=utf-8']],
  ['/shared/sandbox.js', ['../shared/sandbox.js', 'text/javascript; charset=utf-8']],
  ['/shared/analysis.js', ['../shared/analysis.js', 'text/javascript; charset=utf-8']],
]);

// Explicit local texture routes serve the same bundled skins to LAN guests.
for (const name of [
  'beech-light', 'walnut-light', 'maple', 'ash', 'golden-oak', 'golden-nanmu', 'teak', 'cherry', 'rosewood',
  'hainan-huali', 'zitan', 'suan-zhi', 'wenge', 'black-walnut', 'ebony', 'huali', 'camphor',
  'horn-black', 'horn-ivory', 'jade-white', 'jade-celadon', 'jade-green',
]) {
  assets.set(`/textures/${name}.webp`, [`../../web/textures/${name}.webp`, 'image/webp']);
}

export async function startServer({ port = 3000, host = '0.0.0.0', roomOptions, engineOptions, aiEngine } = {}) {
  const ai = createAiHttp(aiEngine || createPikafish(engineOptions));
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; }
    catch { response.writeHead(400); response.end('Invalid request URL'); return; }
    if (await ai.handle(request, response, pathname)) return;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    if (pathname === '/api/server-info') {
      const info = await lanInfo(server.address().port, { host: server.address().address, localAddress: request.socket.localAddress });
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(info));
      return;
    }
    const asset = assets.get(pathname);
    if (!asset) { response.writeHead(404); response.end('Not found'); return; }
    try {
      const content = await readFile(new URL(asset[0], import.meta.url));
      response.setHeader('Content-Type', asset[1]);
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      response.writeHead(500);
      response.end('Unable to load application');
    }
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
  // ws forwards HTTP listen errors; handle them so our startup promise can reject.
  wss.on('error', () => {});
  attachRooms(wss, roomOptions);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    wss.close();
    await ai.close();
    throw error;
  }
  return {
    port: server.address().port,
    info: () => lanInfo(server.address().port, { host: server.address().address }),
    close: async () => {
      const stopped = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      // An unfinished upload must not keep the desktop alive after its window closes.
      server.closeAllConnections();
      await Promise.all([stopped, ai.close()]);
    },
  };
}
