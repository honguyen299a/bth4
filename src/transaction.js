export async function transaction(pool, action, { repeatableRead = false } = {}) {
  const connection = await pool.getConnection();
  try {
    if (repeatableRead) await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.beginTransaction();
    const result = await action(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
