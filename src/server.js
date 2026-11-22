import { createApp } from './app.js';
import { createClients } from './clients.js';
import { config } from './config.js';
import { pool } from './db.js';

try {
  await pool.execute('SELECT 1');
  const app = createApp({ pool, clients: createClients(config) });
  const server = app.listen(config.port, () => console.log(`Order Service: http://localhost:${config.port}`));
  server.on('error', async error => {
    console.error('Không thể mở cổng:', error.code);
    await pool.end();
    process.exitCode = 1;
  });
  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(1), 10000).unref();
    server.close(async () => { await pool.end(); clearTimeout(timer); });
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error('Không kết nối được MySQL. Kiểm tra .env và chạy npm run db:init.', error.code);
  await pool.end();
  process.exitCode = 1;
}
