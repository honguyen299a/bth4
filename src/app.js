import express from 'express';
import { createControllers } from './controllers/orders.js';

export function createApp({ pool, clients }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));
  app.get('/health', async (req, res) => {
    await pool.execute('SELECT 1');
    res.json({ status: 'ok', service: 'order-service' });
  });
  const router = express.Router();
  router.use(async (req, res, next) => {
    req.user = await clients.authenticate(req.headers.authorization);
    next();
  });
  const c = createControllers(pool, clients);
  router.route('/orders').get(c.listOrders).post(c.createOrder);
  router.route('/orders/:id').get(c.getOrder).put(c.updateOrder).delete(c.deleteOrder);
  router.route('/order_items').get(c.listItems).post(c.createItem);
  router.route('/order_items/:id').get(c.getItem).put(c.updateItem).delete(c.deleteItem);
  app.use(router);
  app.use((req, res) => res.status(404).json({ error: { message: 'Endpoint không tồn tại.' } }));
  app.use((error, req, res, next) => {
    let status = error.status || 500;
    let message = error.message;
    if (error.type === 'entity.parse.failed') { status = 400; message = 'JSON không hợp lệ.'; }
    if (error.type === 'entity.too.large') { status = 413; message = 'Body quá lớn.'; }
    if (error.code === 'ER_DUP_ENTRY') { status = 409; message = 'Sản phẩm đã có trong đơn hàng.'; }
    if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) { status = 409; message = 'Xung đột cập nhật, vui lòng thử lại.'; }
    if (status >= 500 && status !== 502 && status !== 503) {
      console.error('Order service error:', error.code || error.name);
      message = 'Lỗi nội bộ của Order Service.';
    }
    res.status(status).json({ error: { message } });
  });
  return app;
}
