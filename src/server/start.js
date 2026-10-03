import { startServer } from './server.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('PORT 必须是 0 到 65535 之间的整数。\n');
  process.exit(1);
}
try {
  const server = await startServer({ port });
  process.stdout.write(`中国象棋已启动：http://localhost:${server.port}\n`);
  const { candidates } = await server.info();
  for (const candidate of candidates) {
    const label = candidate.recommended ? '局域网候选（优先尝试）' : candidate.kind === 'virtual' ? 'VPN / 虚拟网卡（仅同一虚拟网络）' : '待确认网卡';
    process.stdout.write(`${label} [${candidate.interfaceName}]：${candidate.url}\n`);
  }
  process.stdout.write('候选地址不代表好友可达。请让好友先检测连接；切换网络后刷新地址。\n');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => { await server.close(); process.exit(0); });
  }
} catch (error) {
  process.stderr.write(`启动失败：${error.message}\n`);
  process.exit(1);
}
