import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { serverEnv } from '../security/env';
import * as schema from './schema';

/**
 * PostgreSQL connection pool.
 *
 * Lazily initialised so that importing this module never opens sockets as a side
 * effect (important for build-time type checking and for tests).
 *
 * The runtime account has no DDL rights — schema changes are applied exclusively
 * through reviewed migrations using the separate migration account.
 */

export type Database = ReturnType<typeof createDatabase>['db'];
export type Sql = ReturnType<typeof createDatabase>['sql'];

let instance: { db: Database; sql: Sql } | undefined;

function createDatabase(connectionString: string) {
  const sql = postgres(connectionString, {
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    idle_timeout: 30,
    connect_timeout: 10,
    // Postgres.js would otherwise log notices; keep the console clean.
    onnotice: () => {},
  });

  const db = drizzle(sql, { schema, logger: process.env.DRIZZLE_LOG === 'true' });
  return { db, sql };
}

export function getDatabase(): { db: Database; sql: Sql } {
  if (instance) return instance;
  instance = createDatabase(serverEnv().DATABASE_URL);
  return instance;
}

/** Drizzle client. Equivalent to `getDatabase().db`. */
export function db(): Database {
  return getDatabase().db;
}

/** Raw SQL client, for the few places a transaction needs hand-written SQL. */
export function sql(): Sql {
  return getDatabase().sql;
}

export async function closeDatabase(): Promise<void> {
  if (!instance) return;
  await instance.sql.end({ timeout: 5 });
  instance = undefined;
}

export { schema };
