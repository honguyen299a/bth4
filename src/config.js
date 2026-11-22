export const config = {
  port: Number(process.env.PORT || 3002),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'order_user',
    password: process.env.DB_PASSWORD || 'order_password',
    database: process.env.DB_NAME || 'order_service',
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z'
  },
  authVerifyUrl: process.env.AUTH_VERIFY_URL || 'http://localhost:3000/auth/verify',
  productServiceUrl: process.env.PRODUCT_SERVICE_URL || 'http://localhost:3001',
  timeout: Number(process.env.SERVICE_TIMEOUT_MS || 5000)
};
