import type { APIRoute } from 'astro';
import { auth } from '@/lib/auth';

/**
 * Better Auth catch-all handler: sign-in, sign-up, session, organization and
 * invitation endpoints all live under /api/auth/*.
 *
 * The forwarded IP is set from the connection so rate limiting cannot be bypassed
 * with a spoofed header.
 */
export const ALL: APIRoute = async (ctx) => {
  const forwardedFor = ctx.clientAddress;
  if (forwardedFor) {
    ctx.request.headers.set('x-forwarded-for', forwardedFor);
  }

  return auth.handler(ctx.request);
};
