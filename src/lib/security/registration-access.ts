import type { AstroCookies } from 'astro';
import { hashRegistrationAccessToken, safeEqual } from './tokens';
import { serverEnv } from './env';
import { ForbiddenError } from './errors';

/**
 * Registration access.
 *
 * A guest who has just registered must be able to see their tickets, and later
 * return to them from the link in their confirmation email. Two things grant that
 * access, and neither is "the id is hard to guess":
 *
 *  1. **The emailed key.** The confirmation link carries a 256-bit random token;
 *     only its SHA-256 hash is stored. Anyone holding the key can view the
 *     registration — which is safe, because only the buyer ever receives it.
 *
 *  2. **A first-party cookie.** Set in the buyer's own browser at checkout, so the
 *     confirmation page works immediately without waiting for the email. It is
 *     HTTP-only, same-site and Secure in production.
 *
 * Order references are displayed for support and are never accepted as proof of
 * access on their own.
 */

const COOKIE_NAME = 'reg_access';
const MAX_ENTRIES = 10;
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

interface AccessEntry {
  /** Order id. */
  o: string;
  /** Raw access token. */
  t: string;
}

function readCookie(cookies: AstroCookies): AccessEntry[] {
  const raw = cookies.get(COOKIE_NAME)?.value;
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (entry): entry is AccessEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as AccessEntry).o === 'string' &&
        typeof (entry as AccessEntry).t === 'string',
    );
  } catch {
    return [];
  }
}

function writeCookie(cookies: AstroCookies, entries: AccessEntry[]): void {
  cookies.set(COOKIE_NAME, JSON.stringify(entries.slice(-MAX_ENTRIES)), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: serverEnv().NODE_ENV === 'production',
    maxAge: MAX_AGE_SECONDS,
  });
}

/** Records that this browser may view the given order. */
export function grantRegistrationAccess(
  cookies: AstroCookies,
  orderId: string,
  token: string,
): void {
  const entries = readCookie(cookies).filter((entry) => entry.o !== orderId);
  entries.push({ o: orderId, t: token });
  writeCookie(cookies, entries);
}

/**
 * Confirms the caller may view an order, from the emailed key or the cookie.
 * Throws when neither is valid.
 */
export function assertRegistrationAccess(input: {
  cookies: AstroCookies;
  order: { id: string; accessTokenHash: string; publicReference: string };
  key?: string | null;
  viewerUserId?: string | null;
  orderUserId?: string | null;
}): void {
  // A signed-in buyer can always see their own order.
  if (input.viewerUserId && input.orderUserId && input.viewerUserId === input.orderUserId) {
    return;
  }

  if (input.key) {
    const candidate = hashRegistrationAccessToken(input.key);
    if (safeEqual(candidate, input.order.accessTokenHash)) return;
  }

  const entry = readCookie(input.cookies).find((item) => item.o === input.order.id);
  if (entry) {
    const candidate = hashRegistrationAccessToken(entry.t);
    if (safeEqual(candidate, input.order.accessTokenHash)) return;
  }

  throw new ForbiddenError(
    'Open the link from your confirmation email to view this registration.',
  );
}

/** True when the caller may view the order. Non-throwing variant. */
export function hasRegistrationAccess(input: {
  cookies: AstroCookies;
  order: { id: string; accessTokenHash: string };
  key?: string | null;
  viewerUserId?: string | null;
  orderUserId?: string | null;
}): boolean {
  try {
    assertRegistrationAccess({
      cookies: input.cookies,
      order: { ...input.order, publicReference: '' },
      key: input.key,
      viewerUserId: input.viewerUserId,
      orderUserId: input.orderUserId,
    });
    return true;
  } catch {
    return false;
  }
}
