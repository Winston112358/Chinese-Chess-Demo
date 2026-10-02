import { startServer, lanAddresses } from './server.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('PORT 必须是 0 到 65535 之间的整数。\n');
  process.exit(1);
}
try {
  const server = await startServer({ port });
  process.stdout.write(`中国象棋已启动：http://localhost:${server.port}\n`);
  for (const address of lanAddresses(server.port)) process.stdout.write(`局域网地址：${address}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => { await server.close(); process.exit(0); });
  }
} catch (error) {
  process.stderr.write(`启动失败：${error.message}\n`);
  process.exit(1);
}
