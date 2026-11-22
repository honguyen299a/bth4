import { HttpError } from '../errors.js';
import { transaction } from '../db.js';
import { cents, customer, idParam, money, objectBody, positiveInt } from '../validation.js';

export function createControllers(pool, clients) {
  async function order(db, id, lock = false) {
    const [rows] = await db.execute(`SELECT * FROM orders WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!rows.length) throw new HttpError(404, 'Không tìm thấy đơn hàng.');
    return rows[0];
  }
  async function item(db, id) {
    const [rows] = await db.execute('SELECT * FROM order_items WHERE id = ?', [id]);
    if (!rows.length) throw new HttpError(404, 'Không tìm thấy chi tiết đơn hàng.');
    return rows[0];
  }
  function editable(order) {
    if (order.status !== 'pending') throw new HttpError(409, 'Chỉ được sửa chi tiết khi đơn hàng ở trạng thái pending.');
  }
  async function recalculate(db, id) {
    const [rows] = await db.execute('SELECT unit_price, quantity FROM order_items WHERE order_id = ?', [id]);
    const total = money(rows.reduce((sum, row) => sum + cents(row.unit_price) * row.quantity, 0));
    await db.execute('UPDATE orders SET total_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [total, id]);
  }
  async function detail(db, id) {
    const result = await order(db, id);
    const [items] = await db.execute('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [id]);
    return { ...result, items };
  }
  async function duplicate(db, orderId, productId, except = 0) {
    const [rows] = await db.execute('SELECT id FROM order_items WHERE order_id = ? AND product_id = ? AND id <> ?', [orderId, productId, except]);
    if (rows.length) throw new HttpError(409, 'Sản phẩm đã có trong đơn hàng; hãy cập nhật quantity của mặt hàng đó.');
  }

  return {
    async listOrders(req, res) {
      const [rows] = await pool.execute('SELECT * FROM orders ORDER BY id DESC');
      res.json({ data: rows });
    },
    async getOrder(req, res) {
      const id = idParam(req.params.id);
      const result = await transaction(pool, db => detail(db, id));
      res.json({ data: result });
    },
    async createOrder(req, res) {
      const { name, email } = customer(req.body);
      if (!Array.isArray(req.body.items) || !req.body.items.length || req.body.items.length > 100) {
        throw new HttpError(400, 'items phải có từ 1 đến 100 mặt hàng.');
      }
      const seen = new Set();
      const prepared = [];
      let total = 0;
      for (const input of req.body.items) {
        objectBody(input);
        const productId = positiveInt(input.product_id, 'product_id');
        const quantity = positiveInt(input.quantity, 'quantity');
        if (seen.has(productId)) throw new HttpError(400, 'Không được lặp product_id trong items.');
        seen.add(productId);
        const product = await clients.product(productId, quantity, req.headers.authorization);
        total += product.price * quantity;
        money(total);
        prepared.push({ product, quantity });
      }
      const result = await transaction(pool, async db => {
        const [insert] = await db.execute('INSERT INTO orders (customer_name, customer_email, total_amount) VALUES (?, ?, ?)', [name, email, money(total)]);
        for (const { product, quantity } of prepared) {
          await db.execute('INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)',
            [insert.insertId, product.id, product.name, quantity, product.unitPrice]);
        }
        return detail(db, insert.insertId);
      });
      res.status(201).location(`/orders/${result.id}`).json({ data: result });
    },
    async updateOrder(req, res) {
      const id = idParam(req.params.id);
      objectBody(req.body);
      const { status } = req.body;
      if (!['pending', 'completed', 'cancelled'].includes(status)) throw new HttpError(400, 'status phải là pending, completed hoặc cancelled.');
      const result = await transaction(pool, async db => {
        const current = await order(db, id, true);
        if (current.status !== status && current.status !== 'pending') {
          throw new HttpError(409, 'Đơn đã completed/cancelled không thể chuyển trạng thái khác.');
        }
        if (status === 'completed' && current.status === 'pending') {
          const [items] = await db.execute('SELECT * FROM order_items WHERE order_id = ?', [id]);
          if (!items.length) throw new HttpError(409, 'Không thể hoàn thành đơn hàng trống.');
          for (const row of items) await clients.product(row.product_id, row.quantity, req.headers.authorization);
        }
        await db.execute('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
        return detail(db, id);
      });
      res.json({ data: result });
    },
    async deleteOrder(req, res) {
      const id = idParam(req.params.id);
      await transaction(pool, async db => {
        await order(db, id, true);
        await db.execute('DELETE FROM orders WHERE id = ?', [id]);
      });
      res.status(204).end();
    },
    async listItems(req, res) {
      let rows;
      if (req.query.order_id !== undefined) {
        const id = idParam(req.query.order_id, 'order_id');
        await order(pool, id);
        [rows] = await pool.execute('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [id]);
      } else {
        [rows] = await pool.execute('SELECT * FROM order_items ORDER BY id');
      }
      res.json({ data: rows });
    },
    async getItem(req, res) {
      res.json({ data: await item(pool, idParam(req.params.id)) });
    },
    async createItem(req, res) {
      objectBody(req.body);
      const orderId = positiveInt(req.body.order_id, 'order_id');
      const productId = positiveInt(req.body.product_id, 'product_id');
      const quantity = positiveInt(req.body.quantity, 'quantity');
      const result = await transaction(pool, async db => {
        editable(await order(db, orderId, true));
        await duplicate(db, orderId, productId);
        const product = await clients.product(productId, quantity, req.headers.authorization);
        const [insert] = await db.execute('INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)',
          [orderId, productId, product.name, quantity, product.unitPrice]);
        await recalculate(db, orderId);
        return item(db, insert.insertId);
      });
      res.status(201).location(`/order_items/${result.id}`).json({ data: result });
    },
    async updateItem(req, res) {
      const id = idParam(req.params.id);
      objectBody(req.body);
      const quantity = positiveInt(req.body.quantity, 'quantity');
      const found = await item(pool, id);
      const result = await transaction(pool, async db => {
        editable(await order(db, found.order_id, true));
        const current = await item(db, id);
        if (req.body.order_id !== undefined && req.body.order_id !== current.order_id) throw new HttpError(400, 'Không được chuyển mặt hàng sang đơn khác.');
        const productId = req.body.product_id === undefined ? current.product_id : positiveInt(req.body.product_id, 'product_id');
        await duplicate(db, current.order_id, productId, id);
        const product = await clients.product(productId, quantity, req.headers.authorization);
        // Giữ giá tại thời điểm đặt hàng nếu vẫn cùng sản phẩm.
        const price = productId === current.product_id ? current.unit_price : product.unitPrice;
        money(cents(price) * quantity);
        await db.execute('UPDATE order_items SET product_id = ?, product_name = ?, quantity = ?, unit_price = ? WHERE id = ?',
          [productId, productId === current.product_id ? current.product_name : product.name, quantity, price, id]);
        await recalculate(db, current.order_id);
        return item(db, id);
      });
      res.json({ data: result });
    },
    async deleteItem(req, res) {
      const id = idParam(req.params.id);
      const found = await item(pool, id);
      await transaction(pool, async db => {
        editable(await order(db, found.order_id, true));
        await item(db, id);
        await db.execute('DELETE FROM order_items WHERE id = ?', [id]);
        await recalculate(db, found.order_id);
      });
      res.status(204).end();
    }
  };
}
