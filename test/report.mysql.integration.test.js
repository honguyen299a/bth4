import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { reportConfig } from '../src/reporting/config.js';
import { createReportApp } from '../src/reporting/app.js';

test('Report MySQL: tổng hợp, bộ lọc, snapshot idempotent, sửa/xóa đơn và rollback nguyên khối', {
  skip: process.env.REPORT_MYSQL_INTEGRATION !== '1'
}, async t => {
  assert.match(process.env.REPORT_DB_NAME || '', /_test$/);
  const pool = mysql.createPool(reportConfig.db);
  let server;
  let cleanup = false;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      if (cleanup) {
        await pool.execute('DELETE FROM report_orders');
        await pool.execute('DELETE FROM report_products');
        await pool.execute('UPDATE report_snapshot SET captured_at = NULL, content_hash = NULL WHERE id = 1');
      }
    } finally { await pool.end(); }
  });
  const schema = await readFile(new URL('../sql/report-schema.sql', import.meta.url), 'utf8');
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await pool.query(sql);
  const [[initial]] = await pool.execute(`SELECT captured_at,
    (SELECT COUNT(*) FROM report_orders) AS orders_count,
    (SELECT COUNT(*) FROM report_products) AS products_count FROM report_snapshot WHERE id = 1`);
  assert.equal(initial.captured_at, null, 'Chỉ chạy trên Report DB test rỗng.');
  assert.equal(initial.orders_count + initial.products_count, 0);
  cleanup = true;
  server = createReportApp({ pool, clients: { authenticate: async () => ({ id: 1 }) }, ingestKey: 'test-secret' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, data) {
    const response = await fetch(base + path, {
      method: data ? 'PUT' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Report-Key': 'test-secret' },
      body: data ? JSON.stringify(data) : undefined
    });
    return { status: response.status, ...await response.json() };
  }
  assert.equal((await request('/reports/summary')).status, 503);
  const item = (id, price, cost, quantity = 2) => ({ product_id: id, product_name: `SP ${id}`, quantity, unit_price: price, unit_cost: cost });
  const order = (id, status, date, items) => ({
    order_id: id, status, created_at: '2026-11-01T00:00:00.000Z',
    completed_at: date, items
  });
  const data = {
    captured_at: '2026-11-23T12:00:00.000Z',
    products: [{ product_id: 1, product_name: 'SP 1', stock: 8 }, { product_id: 2, product_name: 'Chưa bán', stock: 5 }],
    orders: [
      order(1, 'completed', '2026-11-22T00:00:00.000Z', [item(1, '10.10', '6.05')]),
      order(2, 'pending', null, [item(1, '999.99', '1.00')]),
      order(3, 'cancelled', null, [item(1, '999.99', '1.00')]),
      order(4, 'completed', '2026-11-22T23:59:59.999Z', [item(3, '1.00', '3.00', 1)]),
      order(5, 'completed', '2026-11-23T00:00:00.000Z', [item(1, '100.00', '50.00', 1)])
    ]
  };
  assert.equal((await request('/report-data', data)).data.applied, true);
  assert.equal((await request('/report-data', data)).data.applied, false);
  const summary = await request('/reports/summary?from=2026-11-22&to=2026-11-22');
  assert.deepEqual(summary.data, {
    stock_quantity: '13', completed_orders: 2, sold_quantity: '3', revenue: '21.20', cost: '15.10', profit: '6.10'
  });
  const products = await request('/reports/products?from=2026-11-22&to=2026-11-22');
  assert.equal(products.data.length, 3);
  assert.equal(products.data[0].profit, '8.10');
  assert.equal(products.data[1].revenue, '0.00');
  assert.equal(products.data[2].stock_quantity, null, 'Sản phẩm đã xóa có tồn kho chưa xác định.');
  assert.equal(products.data[2].profit, '-2.00');
  assert.equal((await request('/reports/products/1?to=2026-11-22')).data.revenue, '20.20');
  assert.equal((await request('/reports/orders/2')).data.revenue, '0.00');
  assert.equal((await request('/reports/orders/1')).data.cost, '12.10');
  assert.equal((await request('/reports/orders?from=2026-11-22&to=2026-11-22')).data.length, 2);
  assert.equal((await request('/reports/orders/5?to=2026-11-22')).status, 404);
  assert.equal((await request('/reports/products/999')).status, 404);
  const changed = structuredClone(data);
  changed.products[0].stock = 99;
  assert.equal((await request('/report-data', changed)).status, 409);
  changed.captured_at = '2026-11-23T13:00:00.000Z';
  changed.orders = changed.orders.filter(row => row.order_id !== 1);
  const concurrent = await Promise.all([request('/report-data', changed), request('/report-data', changed)]);
  assert.deepEqual(concurrent.map(result => result.status), [200, 200]);
  assert.deepEqual(concurrent.map(result => result.data.applied).sort(), [false, true]);
  assert.equal((await request('/reports/orders/1')).status, 404);
  assert.equal((await request('/reports/summary')).data.revenue, '101.00');
  assert.equal((await request('/report-data', data)).status, 409);

  // Inject a real DB failure after DELETE and INSERT to prove the full replacement rolls back.
  const { createReportRepository } = await import('../src/reporting/repository.js');
  const { snapshot } = await import('../src/reporting/validation.js');
  const faultyPool = { getConnection: async () => {
    const connection = await pool.getConnection();
    return {
      beginTransaction: () => connection.beginTransaction(), commit: () => connection.commit(),
      rollback: () => connection.rollback(), release: () => connection.release(),
      execute: (sql, params) => sql.startsWith('INSERT INTO report_items')
        ? connection.execute('INSERT INTO table_that_does_not_exist VALUES (1)') : connection.execute(sql, params)
    };
  } };
  const broken = structuredClone(data);
  broken.captured_at = '2026-11-23T14:00:00.000Z';
  await assert.rejects(createReportRepository(faultyPool).replace(snapshot(broken)), { code: 'ER_NO_SUCH_TABLE' });
  assert.equal((await request('/reports/summary')).data.revenue, '101.00');
  assert.equal((await request('/reports/summary')).meta.captured_at, '2026-11-23 13:00:00.000');
  assert.equal((await request('/report-data', { captured_at: '2026-11-23T15:00:00.000Z', products: [], orders: [] })).status, 200);
  assert.equal((await request('/reports/summary')).data.profit, '0.00');
});
