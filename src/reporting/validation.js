import { HttpError } from '../errors.js';
import { objectBody, positiveInt } from '../validation.js';

export function decimal(value, field) {
  if (!['number', 'string'].includes(typeof value) || !/^\d{1,10}(\.\d{1,2})?$/.test(String(value))) {
    throw new HttpError(400, `${field} phải là số tiền không âm, tối đa 9999999999.99.`);
  }
  const [whole, fraction = ''] = String(value).split('.');
  return `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
}

function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 255) {
    throw new HttpError(400, 'product_name phải có từ 1 đến 255 ký tự.');
  }
  return value.trim();
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value || Number(value.slice(0, 4)) < 1000) {
    throw new HttpError(400, `${field} phải là thời gian UTC, ví dụ 2026-11-22T10:00:00.000Z.`);
  }
  return value.replace('T', ' ').replace('Z', '');
}

function unique(rows, field) {
  if (new Set(rows.map(row => row[field])).size !== rows.length) throw new HttpError(400, `${field} bị trùng.`);
}

export function snapshot(body) {
  objectBody(body);
  const capturedAt = timestamp(body.captured_at, 'captured_at');
  if (!Array.isArray(body.products) || !Array.isArray(body.orders) || body.products.length > 1000 || body.orders.length > 1000) {
    throw new HttpError(400, 'products và orders phải là mảng, mỗi mảng tối đa 1000 phần tử.');
  }
  const products = body.products.map(row => {
    objectBody(row);
    if (!Number.isInteger(row.stock) || row.stock < 0 || row.stock > 2147483647) throw new HttpError(400, 'stock phải là số nguyên không âm.');
    return { product_id: positiveInt(row.product_id, 'product_id'), product_name: name(row.product_name), stock: row.stock };
  });
  const orders = body.orders.map(row => {
    objectBody(row);
    const orderId = positiveInt(row.order_id, 'order_id');
    if (!['pending', 'completed', 'cancelled'].includes(row.status)) throw new HttpError(400, 'status không hợp lệ.');
    const createdAt = timestamp(row.created_at, 'created_at');
    const completedAt = row.status === 'completed' ? timestamp(row.completed_at, 'completed_at') : null;
    if (createdAt > capturedAt || (completedAt && (completedAt < createdAt || completedAt > capturedAt))) {
      throw new HttpError(400, 'Thời gian đơn hàng không hợp lệ so với captured_at.');
    }
    if (!Array.isArray(row.items) || row.items.length > 100 || (row.status === 'completed' && !row.items.length)) {
      throw new HttpError(400, 'items tối đa 100 phần tử; đơn completed phải có mặt hàng.');
    }
    const items = row.items.map(item => {
      objectBody(item);
      return {
        product_id: positiveInt(item.product_id, 'product_id'),
        product_name: name(item.product_name),
        quantity: positiveInt(item.quantity, 'quantity'),
        unit_price: decimal(item.unit_price, 'unit_price'),
        unit_cost: decimal(item.unit_cost, 'unit_cost')
      };
    });
    unique(items, 'product_id');
    return { order_id: orderId, status: row.status, created_at: createdAt, completed_at: completedAt, items };
  });
  unique(products, 'product_id');
  unique(orders, 'order_id');
  return { captured_at: capturedAt, products, orders };
}

export function period(query) {
  const result = {};
  for (const field of ['from', 'to']) {
    const value = query[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number(value.slice(0, 4)) < 1000 || Number(value.slice(0, 4)) > 9998 ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
      throw new HttpError(400, `${field} phải là ngày YYYY-MM-DD hợp lệ.`);
    }
    result[field] = value;
  }
  if (result.from && result.to && result.from > result.to) throw new HttpError(400, 'from phải nhỏ hơn hoặc bằng to.');
  return result;
}
