import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';
import { attachRooms } from './rooms.js';

const assets = new Map([
  ['/', ['../../web/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['../../web/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['../../web/app.js', 'text/javascript; charset=utf-8']],
  ['/board.js', ['../../web/board.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['../../web/style.css', 'text/css; charset=utf-8']],
  ['/shared/rules.js', ['../shared/rules.js', 'text/javascript; charset=utf-8']],
]);

export function lanAddresses(port) {
  return Object.values(networkInterfaces()).flat()
    .filter((address) => address?.family === 'IPv4' && !address.internal)
    .map((address) => `http://${address.address}:${port}`);
}

export async function startServer({ port = 3000, host = '0.0.0.0' } = {}) {
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; }
    catch { response.writeHead(400); response.end('Invalid request URL'); return; }
    if (pathname === '/api/server-info') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ addresses: lanAddresses(server.address().port) }));
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
  attachRooms(wss);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve, reject) => {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
