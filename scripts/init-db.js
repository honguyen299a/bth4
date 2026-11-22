import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { config } from '../src/config.js';

// Database và tài khoản được tạo trước bởi DBA hoặc Docker Compose.
const connection = await mysql.createConnection(config.db);
try {
  const schema = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
  for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) {
    await connection.query(statement);
  }
  console.log(`Đã khởi tạo bảng trong database ${config.db.database}.`);
} finally {
  await connection.end();
}
