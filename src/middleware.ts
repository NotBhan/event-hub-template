import { defineMiddleware } from 'astro:middleware';
import { getAuth } from '@/lib/auth';
import { resolveMembership } from '@/lib/auth/membership';
import { tryServerEnv } from '@/lib/security/env';
import { configurationErrorResponse } from '@/lib/security/config-error';

/**
 * Loads the session and organization membership onto `Astro.locals`, then applies
 * baseline security headers.
 *
 * Configuration is validated here, per request, rather than at import time. A
 * deployment with a missing variable then renders a page naming that variable
 * instead of a blank 500 — which is the difference between a five-minute fix and
 * a support thread. Nothing sensitive is shown: names and reasons only.
 *
 * Session loading is read-only; pages and endpoints still enforce their own
 * authorization.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const config = tryServerEnv();

  if (!config.ok) {
    /**
     * API routes answer in JSON, because their callers are machines: a load
     * balancer, a payment provider's webhook retry, an uptime monitor. The health
     * endpoint reports configuration itself, so it is left alone.
     */
    if (context.url.pathname.startsWith('/api/') && context.url.pathname !== '/api/health') {
      return new Response(
        JSON.stringify({
          status: 'misconfigured',
          issues: config.issues.map((issue) => issue.variable),
        }),
        {
          status: 503,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        },
      );
    }

    if (context.url.pathname === '/api/health') {
      return next();
    }

    return configurationErrorResponse(config.issues);
  }

  const isProduction = config.env.NODE_ENV === 'production';

  context.locals.user = null;
  context.locals.session = null;
  context.locals.membership = null;

  try {
    const result = await getAuth().api.getSession({ headers: context.request.headers });

    if (result) {
      context.locals.user = result.user;
      context.locals.session = result.session;

      context.locals.membership = await resolveMembership(
        result.user.id,
        (result.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
      );
    }
  } catch (error) {
    // A failed session lookup means "not signed in", never a 500.
    console.error('Session resolution failed', error);
  }

  const response = await next();

  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  // The admission scanner needs camera access from this origin only.
  response.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');

  if (isProduction) {
    /**
     * Razorpay's hosted checkout is loaded as a script and renders inside an
     * iframe, so those origins must be named explicitly. Without them the real
     * integration would be blocked by our own policy.
     */
    response.headers.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com",
        "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",
        'frame-src https://api.razorpay.com https://checkout.razorpay.com',
      ].join('; '),
    );
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  return response;
});
