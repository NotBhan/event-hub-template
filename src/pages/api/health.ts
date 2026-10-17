import type { APIRoute } from 'astro';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';

/**
 * Health check for load balancers and deployment verification.
 *
 * Verifies the database connection because a web process that cannot reach
 * PostgreSQL cannot serve anything useful, and a silent bad state is worse than a
 * failing check.
 */
export const GET: APIRoute = async () => {
  const startedAt = Date.now();

  try {
    await db().execute(sql`select 1`);

    return new Response(
      JSON.stringify({
        status: 'ok',
        database: 'reachable',
        checkedInMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    );
  } catch (error) {
    console.error('Health check failed', error);

    return new Response(
      JSON.stringify({
        status: 'degraded',
        database: 'unreachable',
        timestamp: new Date().toISOString(),
      }),
      {
        status: 503,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    );
  }
};
