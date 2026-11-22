import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { createClients } from '../src/clients.js';
import { config } from '../src/config.js';

// Chạy trên database test riêng: xem README. Không dùng dữ liệu thật.
test('MySQL: CRUD, tổng tiền, rollback, tồn kho, trạng thái và cập nhật đồng thời', { skip: process.env.MYSQL_INTEGRATION !== '1' }, async t => {
  assert.match(process.env.DB_NAME || '', /_test$/, 'DB_NAME phải kết thúc bằng _test');
  const pool = mysql.createPool(config.db);
  let server;
  const ids = [];
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      for (const id of ids) await pool.execute('DELETE FROM orders WHERE id = ?', [id]);
    } finally {
      await pool.end();
    }
  });
  const schema = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
  for (const sql of schema.split(';').map(x => x.trim()).filter(Boolean)) await pool.query(sql);
  let stock = 10;
  const clients = createClients(config, async url => {
    if (url === config.authVerifyUrl) return Response.json({ valid: true });
    const id = Number(url.split('/').at(-1));
    return Response.json({ id, name: `Sản phẩm ${id}`, price: id >= 3 ? '60000000.00' : '10.10', stock });
  });
  server = createApp({ pool, clients }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, path, body) {
    const response = await fetch(base + path, {
      method, headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }
  const customer = { customer_name: 'Nguyễn An', customer_email: 'an@example.com' };
  const created = await request('POST', '/orders', { ...customer, items: [{ product_id: 1, quantity: 2 }] });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  ids.push(id);
  assert.equal(created.body.data.total_amount, '20.20');
  assert.equal(created.body.data.items[0].total_price, '20.20');
  assert.equal((await request('GET', '/orders')).status, 200);
  assert.equal((await request('GET', `/orders/${id}`)).body.data.items.length, 1);
  assert.equal((await request('GET', `/order_items?order_id=${id}`)).body.data.length, 1);
  assert.equal((await request('GET', '/order_items')).status, 200);
  const firstItemId = created.body.data.items[0].id;
  assert.equal((await request('GET', `/order_items/${firstItemId}`)).status, 200);
  const added = await request('POST', '/order_items', { order_id: id, product_id: 2, quantity: 3 });
  assert.equal(added.status, 201);
  const itemId = added.body.data.id;
  assert.equal((await request('GET', `/orders/${id}`)).body.data.total_amount, '50.50');
  assert.equal((await request('POST', '/order_items', { order_id: id, product_id: 2, quantity: 1 })).status, 409);
  assert.equal((await request('PUT', `/order_items/${itemId}`, { quantity: 11 })).status, 409);
  assert.equal((await request('GET', `/order_items/${itemId}`)).body.data.quantity, 3);
  const updates = await Promise.all([
    request('PUT', `/order_items/${firstItemId}`, { quantity: 4 }),
    request('PUT', `/order_items/${itemId}`, { quantity: 5 })
  ]);
  assert.deepEqual(updates.map(x => x.status), [200, 200]);
  assert.equal((await request('GET', `/orders/${id}`)).body.data.total_amount, '90.90');
  assert.equal((await request('DELETE', `/order_items/${itemId}`)).status, 204);
  assert.equal((await request('GET', `/orders/${id}`)).body.data.total_amount, '40.40');
  stock = 0;
  assert.equal((await request('PUT', `/orders/${id}`, { status: 'completed' })).status, 409);
  assert.equal((await request('POST', '/orders', { ...customer, items: [{ product_id: 1, quantity: 1 }] })).status, 409);
  stock = 10;
  assert.equal((await request('PUT', `/orders/${id}`, { status: 'completed' })).status, 200);
  assert.equal((await request('PUT', `/order_items/${firstItemId}`, { quantity: 1 })).status, 409);
  assert.equal((await request('PUT', `/orders/${id}`, { status: 'pending' })).status, 409);
  assert.equal((await request('DELETE', `/orders/${id}`)).status, 204);
  assert.equal((await request('GET', `/orders/${id}`)).status, 404);
  assert.equal((await request('GET', `/order_items/${firstItemId}`)).status, 404);

  // INSERT mặt hàng thành công nhưng tổng đơn vượt giới hạn: rollback toàn bộ.
  const large = await request('POST', '/orders', { ...customer, items: [{ product_id: 3, quantity: 1 }] });
  assert.equal(large.status, 201);
  const largeId = large.body.data.id;
  ids.push(largeId);
  assert.equal((await request('POST', '/order_items', { order_id: largeId, product_id: 4, quantity: 1 })).status, 400);
  const unchanged = (await request('GET', `/orders/${largeId}`)).body.data;
  assert.equal(unchanged.items.length, 1);
  assert.equal(unchanged.total_amount, '60000000.00');
  assert.equal((await request('PUT', `/orders/${largeId}`, { status: 'cancelled' })).status, 200);
  assert.equal((await request('DELETE', `/order_items/${unchanged.items[0].id}`)).status, 409);
});
