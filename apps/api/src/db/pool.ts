import pg from 'pg';
import { MIGRATIONS } from './migrations';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(databaseUrl: string, appRole: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  if (appRole) {
    pool.on('connect', (client) => {
      // Run as the non-superuser role so row-level security applies.
      client.query(`SET ROLE ${pg.escapeIdentifier(appRole)}`).catch(() => undefined);
    });
  }
  return pool;
}

async function inTransaction<T>(db: Db, settings: Record<string, string>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(settings)) {
      await client.query('SELECT set_config($1, $2, true)', [key, value]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Run `fn` in a transaction where row-level security admits only `tenantId`. */
export function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction(db, { 'app.tenant_id': tenantId }, fn);
}

/**
 * Cross-tenant system work (outbox dispatch, recovery, operator-wide reporting).
 * Never used for a request made on behalf of a tenant member.
 */
export function withSystem<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction(db, { 'app.bypass_rls': 'on' }, fn);
}

/** Apply pending migrations. Runs as the connecting (owner) role, not lomi_app. */
export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    // Serialize concurrent migrators (api and worker start together).
    await client.query('SELECT pg_advisory_lock(7317001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    const done = new Set((await client.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
    for (const migration of MIGRATIONS) {
      if (done.has(migration.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
        await client.query('COMMIT');
        applied.push(migration.id);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.id} failed: ${(error as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7317001)').catch(() => undefined);
    await client.end();
  }
  return applied;
}
