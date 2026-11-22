import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../errors.js';
import { idParam } from '../validation.js';
import { snapshot, period } from './validation.js';
import { createReportRepository } from './repository.js';

export function createReportApp({ pool, clients, ingestKey, repository = createReportRepository(pool) }) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', async (req, res) => {
    await pool.execute('SELECT 1');
    res.json({ status: 'ok', service: 'report-service' });
  });
  app.put('/report-data', (req, res, next) => {
    if (!ingestKey) throw new HttpError(503, 'Chưa cấu hình REPORT_INGEST_KEY.');
    const supplied = req.get('X-Report-Key') || '';
    const digest = value => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(supplied), digest(ingestKey))) throw new HttpError(401, 'Khóa đồng bộ không hợp lệ.');
    next();
  }, express.json({ limit: '2mb' }), async (req, res) => {
    res.json({ data: await repository.replace(snapshot(req.body)) });
  });
  const router = express.Router();
  router.use(async (req, res, next) => {
    req.user = await clients.authenticate(req.headers.authorization);
    next();
  });
  router.get('/summary', async (req, res) => res.json(await repository.read('summary', period(req.query))));
  for (const kind of ['products', 'orders']) {
    router.get(`/${kind}`, async (req, res) => res.json(await repository.read(kind, period(req.query))));
    router.get(`/${kind}/:id`, async (req, res) => res.json(await repository.read(kind, period(req.query), idParam(req.params.id))));
  }
  app.use('/reports', router);
  app.use((req, res) => res.status(404).json({ error: { message: 'Endpoint không tồn tại.' } }));
  app.use((error, req, res, next) => {
    let status = error.status || 500;
    let message = error.message;
    if (error.type === 'entity.parse.failed') { status = 400; message = 'JSON không hợp lệ.'; }
    if (error.type === 'entity.too.large') { status = 413; message = 'Body quá lớn.'; }
    if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) { status = 409; message = 'Xung đột đồng bộ, vui lòng thử lại.'; }
    if (status === 500) {
      console.error('Report service error:', error.code || error.name);
      message = 'Lỗi nội bộ của Report Service.';
    }
    res.status(status).json({ error: { message } });
  });
  return app;
}
