import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { reportConfig } from '../src/reporting/config.js';

const connection = await mysql.createConnection(reportConfig.db);
try {
  const schema = await readFile(new URL('../sql/report-schema.sql', import.meta.url), 'utf8');
  for (const statement of schema.split(';').map(value => value.trim()).filter(Boolean)) await connection.query(statement);
  console.log(`Đã khởi tạo Report DB: ${reportConfig.db.database}.`);
} finally {
  await connection.end();
}
