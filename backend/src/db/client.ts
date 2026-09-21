import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  keepAlive: true,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected pg pool error');
});

export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 500) {
    logger.warn({ duration, rowCount: res.rowCount, sql: text.slice(0, 80) }, 'Slow query');
  }
  return res.rows as T[];
}

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  // A dropped socket on a checked-out client emits 'error' with no listener,
  // which crashes the whole process (the in-flight query rejects regardless).
  const onClientError = (err: Error) => logger.error({ err }, 'pg client error while checked out');
  client.on('error', onClientError);
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    broken = true;
    try {
      await client.query('ROLLBACK');
      broken = false;
    } catch {
      // connection is dead — don't mask the original error
    }
    throw err;
  } finally {
    client.removeListener('error', onClientError);
    // destroy dead connections instead of returning them to the pool
    client.release(broken);
  }
}
