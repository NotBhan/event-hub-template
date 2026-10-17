import type { APIRoute } from 'astro';
import { auth } from '@/lib/auth';

/**
 * Sign out.
 *
 * A dedicated route rather than posting straight at the auth handler, so the
 * session can be revoked server-side and the visitor then sent somewhere
 * sensible.
 *
 * The auth library's own response is used for its `Set-Cookie` headers: it is the
 * only code that knows which cookies to clear and how, and reimplementing that
 * here would eventually drift out of sync with it.
 */
export const POST: APIRoute = async (ctx) => {
  const headers = new Headers({ location: '/' });

  try {
    const response = await auth.api.signOut({
      headers: ctx.request.headers,
      asResponse: true,
    });

    for (const cookie of response.headers.getSetCookie()) {
      headers.append('set-cookie', cookie);
    }
  } catch (error) {
    // An already-invalid session is not worth reporting to the visitor.
    console.error('Sign out failed', error);
  }

  return new Response(null, { status: 303, headers });
};

/** Signing out by navigating to a URL is a common accident; say so clearly. */
export const GET: APIRoute = async () => new Response('Use POST to sign out', { status: 405 });
