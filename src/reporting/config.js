export const reportConfig = {
  port: Number(process.env.REPORT_PORT || 3003),
  db: {
    host: process.env.REPORT_DB_HOST || '127.0.0.1',
    port: Number(process.env.REPORT_DB_PORT || 3307),
    user: process.env.REPORT_DB_USER || 'report_user',
    password: process.env.REPORT_DB_PASSWORD || 'report_password',
    database: process.env.REPORT_DB_NAME || 'report_service',
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z',
    dateStrings: true
  },
  authVerifyUrl: process.env.AUTH_VERIFY_URL || 'http://localhost:3000/auth/verify',
  timeout: Number(process.env.SERVICE_TIMEOUT_MS || 5000),
  ingestKey: process.env.REPORT_INGEST_KEY || ''
};
