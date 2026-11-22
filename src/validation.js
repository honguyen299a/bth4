import { HttpError } from './errors.js';

export function positiveInt(value, field) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647) {
    throw new HttpError(400, `${field} phải là số nguyên dương (tối đa 2147483647).`);
  }
  return value;
}

export function idParam(value, field = 'id') {
  if (!/^[1-9]\d*$/.test(value)) throw new HttpError(400, `${field} không hợp lệ.`);
  return positiveInt(Number(value), field);
}

export function objectBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body phải là JSON object.');
  return body;
}

export function customer(body) {
  objectBody(body);
  const name = typeof body.customer_name === 'string' ? body.customer_name.trim() : '';
  const email = typeof body.customer_email === 'string' ? body.customer_email.trim() : '';
  if (!name || name.length > 255) throw new HttpError(400, 'customer_name phải có từ 1 đến 255 ký tự.');
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'customer_email không hợp lệ.');
  return { name, email };
}

// Số tiền được tính bằng xu nguyên, không cộng số thực IEEE-754.
export function cents(value) {
  if (!['number', 'string'].includes(typeof value) || !/^\d+(\.\d{1,2})?$/.test(String(value))) {
    throw new HttpError(502, 'Product Service trả về giá không hợp lệ.');
  }
  const [whole, fraction = ''] = String(value).split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (amount > 9999999999n) throw new HttpError(502, 'Giá sản phẩm vượt DECIMAL(10,2).');
  return Number(amount);
}

export function money(amount) {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 9999999999) {
    throw new HttpError(400, 'Tổng tiền vượt giới hạn DECIMAL(10,2).');
  }
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}
