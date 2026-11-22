import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, period, decimal } from '../src/reporting/validation.js';
import { createReportApp } from '../src/reporting/app.js';
import { createClients } from '../src/clients.js';
import { createReportRepository } from '../src/reporting/repository.js';

function sampleSnapshot() {
  return {
    captured_at: '2026-11-22T12:00:00.000Z',
    products: [
      { product_id: 1, product_name: 'Bút', stock: 8 },
      { product_id: 2, product_name: 'Vở', stock: 5 }
    ],
    orders: [{
      order_id: 1, status: 'completed', created_at: '2026-11-20T10:00:00.000Z', completed_at: '2026-11-22T00:00:00.000Z',
      items: [{ product_id: 1, product_name: 'Bút', quantity: 2, unit_price: '10.10', unit_cost: '6.05' }]
    }]
  };
}

test('report validation: giá vốn bắt buộc, tiền chính xác, trạng thái, trùng ID và thời gian', () => {
  assert.equal(decimal('0.1', 'price'), '0.10');
  assert.equal(decimal('9999999999.99', 'price'), '9999999999.99');
  for (const value of [undefined, null, true, -1, '1e2', '0.001', '10000000000.00']) assert.throws(() => decimal(value, 'price'), { status: 400 });
  assert.equal(snapshot(sampleSnapshot()).orders[0].items[0].unit_cost, '6.05');
  for (const mutate of [
    data => { delete data.orders[0].items[0].unit_cost; },
    data => { data.products[0].stock = -1; },
    data => { data.products.push(data.products[0]); },
    data => { data.orders.push(data.orders[0]); },
    data => { data.orders[0].items.push(data.orders[0].items[0]); },
    data => { data.orders[0].status = 'unknown'; },
    data => { data.orders[0].items = []; },
    data => { data.orders[0].completed_at = '2026-11-19T00:00:00.000Z'; },
    data => { data.captured_at = '2026-02-30T00:00:00.000Z'; }
  ]) {
    const data = sampleSnapshot();
    mutate(data);
    assert.throws(() => snapshot(data), { status: 400 });
  }
  assert.deepEqual(period({ from: '2026-11-01', to: '2026-11-22' }), { from: '2026-11-01', to: '2026-11-22' });
  for (const query of [{ from: '2026-02-30' }, { from: ['2026-01-01'] }, { from: '2026-11-22', to: '2026-11-01' }]) assert.throws(() => period(query), { status: 400 });
});

test('report HTTP: khóa đồng bộ riêng, xác thực đọc, validation và chuyển bộ lọc', async t => {
  const calls = [];
  const repository = {
    replace: async data => { calls.push(data); return { applied: true }; },
    read: async (...args) => { calls.push(args); return { data: [], meta: {} }; }
  };
  const clients = createClients({ timeout: 100, authVerifyUrl: 'http://auth' }, async () => Response.json({ valid: true }));
  const server = createReportApp({ pool: { execute: async () => [[]] }, clients, ingestKey: 'secret', repository }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: 'Bearer good' };
  for (const path of ['/reports/summary', '/reports/products', '/reports/products/1', '/reports/orders', '/reports/orders/1']) {
    assert.equal((await fetch(base + path)).status, 401);
  }
  assert.equal((await fetch(base + '/report-data', { method: 'PUT', headers: auth })).status, 401);
  assert.equal(calls.length, 0);
  const put = (body, key = 'secret') => fetch(base + '/report-data', {
    method: 'PUT', headers: { 'X-Report-Key': key, 'Content-Type': 'application/json' }, body
  });
  assert.equal((await put('{')).status, 400);
  assert.equal((await put('{}')).status, 400);
  assert.equal((await put(JSON.stringify(sampleSnapshot()))).status, 200);
  assert.equal(calls[0].captured_at, '2026-11-22 12:00:00.000');
  assert.equal((await fetch(base + '/reports/products/1?from=2026-11-01&to=2026-11-22', { headers: auth })).status, 200);
  assert.deepEqual(calls.at(-1), ['products', { from: '2026-11-01', to: '2026-11-22' }, 1]);
  assert.equal((await fetch(base + '/reports/orders/1abc', { headers: auth })).status, 400);
  assert.equal((await fetch(base + '/reports/summary?to=2026-02-30', { headers: auth })).status, 400);
  assert.deepEqual(await (await fetch(base + '/health')).json(), { status: 'ok', service: 'report-service' });
});

test('snapshot transaction: ghi thất bại rollback và từ chối snapshot cũ', async () => {
  const events = [];
  let current = { captured_at: null };
  const connection = {
    beginTransaction: async () => events.push('begin'), commit: async () => events.push('commit'),
    rollback: async () => events.push('rollback'), release: () => events.push('release'),
    execute: async sql => {
      if (sql.startsWith('SELECT')) return [[current]];
      events.push(sql);
      throw new Error('write failed');
    }
  };
  const repository = createReportRepository({ getConnection: async () => connection });
  await assert.rejects(repository.replace(snapshot(sampleSnapshot())), /write failed/);
  assert.deepEqual(events.slice(-2), ['rollback', 'release']);
  current = { captured_at: '2026-11-23 00:00:00.000' };
  await assert.rejects(repository.replace(snapshot(sampleSnapshot())), { status: 409 });
});
