import test from 'node:test';
import assert from 'node:assert/strict';
import { cents, money, positiveInt, idParam, customer } from '../src/validation.js';
import { createClients } from '../src/clients.js';
import { createApp } from '../src/app.js';
import { transaction } from '../src/db.js';

const config = { timeout: 100, authVerifyUrl: 'http://auth/auth/verify', productServiceUrl: 'http://products' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('tiền tệ chính xác, giới hạn DECIMAL và từ chối giá không hợp lệ', () => {
  assert.equal(money(cents('0.10') * 3), '0.30');
  assert.equal(money(cents('99999999.99')), '99999999.99');
  for (const value of [-1, null, true, 'NaN', '1.001', '1e5', '100000000']) assert.throws(() => cents(value));
  assert.throws(() => money(10000000000), { status: 400 });
});

test('kiểm tra ID, số lượng và thông tin khách hàng', () => {
  for (const value of [0, -1, 1.5, '2', true, 2147483648]) assert.throws(() => positiveInt(value, 'quantity'));
  for (const value of ['1abc', '1.0', '-1', '0', '1 OR 1=1']) assert.throws(() => idParam(value));
  assert.equal(idParam('12'), 12);
  assert.deepEqual(customer({ customer_name: ' An ', customer_email: 'an@example.com' }), { name: 'An', email: 'an@example.com' });
  assert.throws(() => customer({ customer_name: 'An', customer_email: 'invalid' }));
});

test('xác thực từ chối thiếu token, token bị thu hồi và JSON không xác nhận', async () => {
  const clients = createClients(config, async () => json({ valid: false }));
  await assert.rejects(clients.authenticate(), { status: 401 });
  await assert.rejects(clients.authenticate('Bearer bad'), { status: 401 });
  await assert.rejects(createClients(config, async () => json({})).authenticate('Bearer bad'), { status: 401 });
  await assert.rejects(createClients(config, async () => json({ error: 'expired' }, 401)).authenticate('Bearer bad'), { status: 401 });
});

test('gửi token đến Auth Service và chấp nhận user hợp lệ', async () => {
  const clients = createClients(config, async (url, options) => {
    assert.equal(url, config.authVerifyUrl);
    assert.equal(options.headers.Authorization, 'Bearer good');
    return json({ data: { user: { id: 7 } } });
  });
  assert.deepEqual(await clients.authenticate('Bearer good'), { user: { id: 7 } });
});

test('Product Service: tồn kho, giá, thiếu sản phẩm, dữ liệu lỗi và gián đoạn', async () => {
  const clients = createClients(config, async () => json({ data: { id: 1, name: 'Bút', price: '12.50', quantity: 3 } }));
  assert.equal((await clients.product(1, 3, 'Bearer good')).unitPrice, '12.50');
  await assert.rejects(clients.product(1, 4, 'Bearer good'), { status: 409 });
  await assert.rejects(createClients(config, async () => json({}, 404)).product(1, 1), { status: 404 });
  await assert.rejects(createClients(config, async () => json({ id: 2, name: 'Bút', stock: 2, price: 2 })).product(1, 1), { status: 502 });
  await assert.rejects(createClients(config, async () => json({ id: 1, name: 'Bút', stock: true, price: 2 })).product(1, 1), { status: 502 });
  await assert.rejects(createClients(config, async () => { throw new Error('offline'); }).product(1, 1), { status: 503 });
  await assert.rejects(createClients(config, async () => new Response('not json')).product(1, 1), { status: 502 });
});

test('transaction commit khi thành công, rollback khi thất bại và luôn release', async () => {
  const events = [];
  const connection = Object.fromEntries(['beginTransaction', 'commit', 'rollback', 'release'].map(name => [name, async () => events.push(name)]));
  const pool = { getConnection: async () => connection };
  assert.equal(await transaction(pool, async () => 42), 42);
  assert.deepEqual(events, ['beginTransaction', 'commit', 'release']);
  events.length = 0;
  await assert.rejects(transaction(pool, async () => { throw new Error('failed'); }), /failed/);
  assert.deepEqual(events, ['beginTransaction', 'rollback', 'release']);
});

test('HTTP: mọi route nghiệp vụ yêu cầu token; JSON lỗi và ID lỗi trả 400', async t => {
  let queries = 0;
  const pool = { execute: async () => { queries++; return [[]]; } };
  const clients = createClients(config, async () => json({ valid: true }));
  const server = createApp({ pool, clients }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [method, path] of [
    ['GET', '/orders'], ['GET', '/orders/1'], ['POST', '/orders'], ['PUT', '/orders/1'], ['DELETE', '/orders/1'],
    ['GET', '/order_items'], ['GET', '/order_items/1'], ['POST', '/order_items'], ['PUT', '/order_items/1'], ['DELETE', '/order_items/1']
  ]) {
    assert.equal((await fetch(base + path, { method })).status, 401, `${method} ${path}`);
  }
  assert.equal(queries, 0, 'Không truy vấn DB khi chưa xác thực');
  assert.equal((await fetch(base + '/orders/1abc', { headers: { Authorization: 'Bearer good' } })).status, 400);
  assert.equal((await fetch(base + '/orders', { method: 'POST', headers: { Authorization: 'Bearer good', 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  const response = await fetch(base + '/orders', { headers: { Authorization: 'Bearer good' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [] });
});
