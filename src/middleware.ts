import { defineMiddleware } from 'astro:middleware';
import { auth } from '@/lib/auth';
import { resolveMembership } from '@/lib/auth/membership';
import { serverEnv } from '@/lib/security/env';

const env = serverEnv();
const isProduction = env.NODE_ENV === 'production';

/**
 * Loads the session and organization membership onto `Astro.locals`, then applies
 * baseline security headers.
 *
 * Session loading is read-only: middleware never mutates data, so a page that
 * renders but is not authorized still fails inside the endpoint or page guard.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.user = null;
  context.locals.session = null;
  context.locals.membership = null;

  try {
    const result = await auth.api.getSession({ headers: context.request.headers });

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
