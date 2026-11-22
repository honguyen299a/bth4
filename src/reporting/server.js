import mysql from 'mysql2/promise';
import { reportConfig as config } from './config.js';
import { createReportApp } from './app.js';
import { createClients } from '../clients.js';

const pool = mysql.createPool(config.db);
try {
  await pool.execute('SELECT 1');
  const app = createReportApp({ pool, clients: createClients(config), ingestKey: config.ingestKey });
  const server = app.listen(config.port, () => console.log(`Report Service: http://localhost:${config.port}`));
  server.on('error', async error => {
    console.error('Không thể mở cổng Report Service:', error.code);
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
  console.error('Không kết nối được Report DB. Kiểm tra REPORT_DB_* và chạy npm run report:db:init.', error.code);
  await pool.end();
  process.exitCode = 1;
}
