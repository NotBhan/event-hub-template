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

/** Vercel and Lambda both serve requests from short-lived function instances. */
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

function createDatabase(connectionString: string) {
  const sql = postgres(connectionString, {
    // A serverless instance is one client among many, and the pooled endpoint
    // behind it is already multiplexing. A ten-connection pool per instance
    // multiplies into the pooler's own limit and fails with "too many clients".
    max: Number(process.env.DATABASE_POOL_SIZE ?? (isServerless ? 1 : 10)),
    idle_timeout: 30,
    connect_timeout: 10,
    /**
     * Prepared statements are unusable through a transaction-mode pooler, which
     * is what a pooled serverless URL is. Postgres.js prepares each query under a
     * random per-connection name and reuses it for the life of that connection,
     * but a pooled connection is not pinned to one server backend: the next
     * transaction can land on a backend where the statement was never prepared.
     * The server then rejects the query ("prepared statement ... does not exist"),
     * Drizzle reports it as a failed query with no SQL error of its own, and the
     * page 500s intermittently — depending on which backend the pooler picked.
     * Docker deployments hold direct connections, where preparing is a win.
     */
    prepare: !isServerless,
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
