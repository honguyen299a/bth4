import { createHash } from 'node:crypto';
import { transaction } from '../transaction.js';
import { HttpError } from '../errors.js';

// Money stays in MySQL DECIMAL throughout aggregation; mysql2 returns strings.
const metrics = `COALESCE(SUM(i.quantity), 0) AS sold_quantity,
  COALESCE(SUM(i.quantity * i.unit_price), 0.00) AS revenue,
  COALESCE(SUM(i.quantity * i.unit_cost), 0.00) AS cost,
  COALESCE(SUM(i.quantity * (i.unit_price - i.unit_cost)), 0.00) AS profit`;
const capturedAt = "LEFT(DATE_FORMAT(captured_at, '%Y-%m-%d %H:%i:%s.%f'), 23) AS captured_at";

function salesFilter(period, alias = 'o') {
  const clauses = [`${alias}.status = 'completed'`];
  const params = [];
  if (period.from) { clauses.push(`${alias}.completed_at >= ?`); params.push(period.from); }
  if (period.to) { clauses.push(`${alias}.completed_at < DATE_ADD(?, INTERVAL 1 DAY)`); params.push(period.to); }
  return { sql: clauses.join(' AND '), params };
}

export function createReportRepository(pool) {
  return {
    async replace(data) {
      const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
      return transaction(pool, async db => {
        const [[current]] = await db.execute(`SELECT ${capturedAt}, content_hash FROM report_snapshot WHERE id = 1 FOR UPDATE`);
        if (current.captured_at && data.captured_at <= current.captured_at) {
          if (data.captured_at === current.captured_at && hash === current.content_hash) return { applied: false, captured_at: current.captured_at };
          throw new HttpError(409, 'Snapshot cũ hoặc cùng thời gian nhưng khác dữ liệu.');
        }
        await db.execute('DELETE FROM report_orders');
        await db.execute('DELETE FROM report_products');
        for (const product of data.products) {
          await db.execute('INSERT INTO report_products (product_id, product_name, stock) VALUES (?, ?, ?)',
            [product.product_id, product.product_name, product.stock]);
        }
        for (const order of data.orders) {
          await db.execute('INSERT INTO report_orders (order_id, status, created_at, completed_at) VALUES (?, ?, ?, ?)',
            [order.order_id, order.status, order.created_at, order.completed_at]);
          for (const item of order.items) {
            await db.execute('INSERT INTO report_items (order_id, product_id, product_name, quantity, unit_price, unit_cost) VALUES (?, ?, ?, ?, ?, ?)',
              [order.order_id, item.product_id, item.product_name, item.quantity, item.unit_price, item.unit_cost]);
          }
        }
        await db.execute('UPDATE report_snapshot SET captured_at = ?, content_hash = ? WHERE id = 1', [data.captured_at, hash]);
        return { applied: true, captured_at: data.captured_at, products: data.products.length, orders: data.orders.length };
      });
    },
    async read(kind, period, id) {
      const filter = salesFilter(period);
      // A single repeatable-read transaction ties metadata, stock and sales to one snapshot.
      return transaction(pool, async db => {
        const [[meta]] = await db.execute(`SELECT ${capturedAt} FROM report_snapshot WHERE id = 1`);
        if (!meta.captured_at) throw new HttpError(503, 'Chưa có dữ liệu báo cáo. Hãy đồng bộ snapshot trước.');
        let rows;
        if (kind === 'summary') {
          [rows] = await db.execute(`SELECT COUNT(DISTINCT o.order_id) AS completed_orders, ${metrics}
            FROM report_orders o LEFT JOIN report_items i ON i.order_id = o.order_id WHERE ${filter.sql}`, filter.params);
          const [[stock]] = await db.execute('SELECT COALESCE(SUM(stock), 0) AS stock_quantity FROM report_products');
          rows[0] = { ...stock, ...rows[0] };
        } else if (kind === 'products') {
          [rows] = await db.execute(`SELECT p.product_id, p.product_name, p.stock AS stock_quantity,
              COALESCE(s.sold_quantity, 0) AS sold_quantity, COALESCE(s.revenue, 0.00) AS revenue,
              COALESCE(s.cost, 0.00) AS cost, COALESCE(s.profit, 0.00) AS profit
            FROM (
              SELECT product_id, product_name, stock FROM report_products
              UNION ALL
              SELECT product_id, MAX(product_name), NULL FROM report_items
                WHERE product_id NOT IN (SELECT product_id FROM report_products) GROUP BY product_id
            ) p
            LEFT JOIN (SELECT i.product_id, ${metrics}
              FROM report_items i JOIN report_orders o ON o.order_id = i.order_id
              WHERE ${filter.sql} GROUP BY i.product_id) s ON s.product_id = p.product_id
            ${id ? 'WHERE p.product_id = ?' : ''} ORDER BY p.product_id`, [...filter.params, ...(id ? [id] : [])]);
        } else {
          [rows] = await db.execute(`SELECT o.order_id, o.status, o.created_at, o.completed_at,
              COALESCE(s.sold_quantity, 0) AS sold_quantity, COALESCE(s.revenue, 0.00) AS revenue,
              COALESCE(s.cost, 0.00) AS cost, COALESCE(s.profit, 0.00) AS profit
            FROM report_orders o LEFT JOIN (SELECT i.order_id, ${metrics}
              FROM report_items i JOIN report_orders o ON o.order_id = i.order_id
              WHERE ${filter.sql} GROUP BY i.order_id) s ON s.order_id = o.order_id
            WHERE 1 = 1 ${id ? 'AND o.order_id = ?' : ''}
              ${period.from ? 'AND COALESCE(o.completed_at, o.created_at) >= ?' : ''}
              ${period.to ? 'AND COALESCE(o.completed_at, o.created_at) < DATE_ADD(?, INTERVAL 1 DAY)' : ''}
            ORDER BY o.order_id`, [...filter.params, ...(id ? [id] : []), ...(period.from ? [period.from] : []), ...(period.to ? [period.to] : [])]);
        }
        if (id && !rows.length) throw new HttpError(404, 'Không tìm thấy dữ liệu báo cáo trong kỳ.');
        return { data: kind === 'summary' || id ? rows[0] : rows, meta: { captured_at: meta.captured_at, period, timezone: 'UTC' } };
      }, { repeatableRead: true });
    }
  };
}
