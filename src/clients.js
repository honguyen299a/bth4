import { HttpError } from './errors.js';
import { cents, money } from './validation.js';

export function createClients(config, fetchFn = fetch) {
  async function request(url, token, service) {
    let response;
    try {
      response = await fetchFn(url, {
        headers: { Authorization: token, Accept: 'application/json' },
        signal: AbortSignal.timeout(config.timeout),
        redirect: 'error'
      });
    } catch {
      throw new HttpError(503, `Không kết nối được ${service}.`);
    }
    if (response.status === 401 || response.status === 403) throw new HttpError(response.status, 'Token không hợp lệ hoặc không đủ quyền.');
    if (service === 'Product Service' && response.status === 404) throw new HttpError(404, 'Không tìm thấy sản phẩm.');
    if (!response.ok) throw new HttpError(502, `${service} trả về lỗi.`);
    try { return await response.json(); }
    catch { throw new HttpError(502, `${service} trả về JSON không hợp lệ.`); }
  }

  return {
    async authenticate(token) {
      if (!/^Bearer\s+\S+$/i.test(token || '')) throw new HttpError(401, 'Cần Authorization: Bearer <token>.');
      const body = await request(config.authVerifyUrl, token, 'Auth Service');
      // Hỗ trợ {valid:true}, {active:true}, {user:{id}}, {id} và envelope {data:...}.
      const identity = body?.data ?? body;
      if (body?.success === false || identity?.valid === false || identity?.active === false ||
          !(identity?.valid === true || identity?.active === true || identity?.user?.id || identity?.id)) {
        throw new HttpError(401, 'Auth Service không xác nhận token.');
      }
      return identity;
    },
    async product(id, quantity, token) {
      const body = await request(`${config.productServiceUrl.replace(/\/$/, '')}/products/${id}`, token, 'Product Service');
      const product = body?.data ?? body?.product ?? body;
      const stock = product?.stock ?? product?.quantity;
      const numeric = value => (typeof value === 'number' && Number.isSafeInteger(value)) ||
        (typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)));
      if (!product || !numeric(product.id) || Number(product.id) !== id || typeof product.name !== 'string' ||
          !product.name.trim() || product.name.length > 255 || !numeric(stock) || Number(stock) < 0) {
        throw new HttpError(502, 'Dữ liệu sản phẩm không hợp lệ.');
      }
      if (Number(stock) < quantity) throw new HttpError(409, `Sản phẩm ${id} không đủ tồn kho (còn ${stock}).`);
      const price = cents(product.price);
      money(price * quantity);
      return { id, name: product.name.trim(), unitPrice: money(price), price };
    }
  };
}
