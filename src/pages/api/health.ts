import type { APIRoute } from 'astro';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { tryServerEnv } from '@/lib/security/env';

/**
 * Health check for load balancers and deployment verification.
 *
 * Reports three distinct states, because they need different responses:
 *
 *   503  misconfigured — a required variable is missing or unsafe. No point
 *        probing the database; report which variables need attention.
 *   503  degraded — configuration is fine but PostgreSQL is unreachable.
 *   200  ok
 *
 * Only variable names are returned, never values.
 */
export const GET: APIRoute = async () => {
  const startedAt = Date.now();

  const config = tryServerEnv();

  if (!config.ok) {
    return json(
      {
        status: 'misconfigured',
        issues: config.issues.map((issue) => ({
          variable: issue.variable,
          reason: issue.message,
        })),
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }

  try {
    await db().execute(sql`select 1`);

    return json(
      {
        status: 'ok',
        database: 'reachable',
        checkedInMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
      200,
    );
  } catch (error) {
    console.error('Health check failed', error);

    return json(
      {
        status: 'degraded',
        database: 'unreachable',
        hint: 'Check DATABASE_URL and that the database accepts connections from this host.',
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }
};

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
