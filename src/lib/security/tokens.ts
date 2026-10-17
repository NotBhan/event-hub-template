import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Secure identifier generation.
 *
 * ## Why the ticket credential is derived rather than stored
 *
 * A ticket QR code must satisfy three requirements at once:
 *
 *  1. A database leak must not yield printable tickets.
 *  2. The server must be able to render the QR code again on every visit to the
 *     ticket page — so the credential cannot be a value that is generated once
 *     and then forgotten.
 *  3. Scanning must be a single indexed lookup so it stays fast at the door.
 *
 * Storing the raw token fails (1). Storing only a hash of a one-off random token
 * fails (2). Deriving the token from a server-side secret and the ticket id
 * satisfies all three:
 *
 *     token      = HMAC-SHA256(TICKET_TOKEN_SECRET, ticketId)
 *     stored     = SHA-256(token)          ← indexed lookup key
 *
 * An attacker holding only the database has the ticket id and the hash, but not
 * the secret, so the credential cannot be reconstructed and no QR can be forged.
 * The secret lives in deployment configuration, never in the database.
 */

/** Crockford-style alphabet: no I, L, O or U, so references cannot be misread. */
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomString(length: number): string {
  let result = '';
  // Rejection sampling keeps the distribution uniform despite the alphabet size
  // not dividing 256 evenly.
  const max = 256 - (256 % REFERENCE_ALPHABET.length);

  while (result.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= max) continue;
      result += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
      if (result.length === length) break;
    }
  }

  return result;
}

/**
 * Derives the QR credential for a ticket. Deterministic: the same ticket always
 * produces the same token, which is what makes re-rendering possible.
 */
export function deriveTicketToken(ticketId: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(`ticket:${ticketId}`, 'utf8').digest();
  return `t1.${ticketId}.${digest.toString('base64url')}`;
}

/**
 * Hashes a QR credential for storage and indexed lookup.
 *
 * SHA-256 is appropriate here because the input already carries 256 bits of
 * keyed entropy: there is nothing to brute force, and scanning must be fast.
 */
export function hashQrToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Extracts the ticket id from a presented credential, without trusting it. */
export function parseTicketToken(token: string): { ticketId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, ticketId, signature] = parts;
  if (version !== 't1' || !ticketId || !signature) return null;
  // The ticket id must look like a UUID before it reaches a query.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ticketId)) {
    return null;
  }
  return { ticketId };
}

/** Constant-time comparison, for anything secret that is compared directly. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** Human-readable ticket reference, e.g. `TKT-7K2M9Q-X4NB3R`. */
export function generateTicketReference(): string {
  return `TKT-${randomString(6)}-${randomString(6)}`;
}

/**
 * Reference shown to buyers, e.g. `ORD-9QX4M2-7KB3TN`.
 *
 * This is a display identifier only. It is never used as an authorization
 * credential — a hard-to-guess reference is not access control.
 */
export function generateOrderReference(): string {
  return `ORD-${randomString(6)}-${randomString(6)}`;
}

/**
 * Idempotency key for an order.
 *
 * Combined with the unique index on `orders.idempotency_key`, this is what makes
 * a double form submission create one order instead of two.
 */
export function generateIdempotencyKey(): string {
  return `ord_${randomUUID()}`;
}

/** Opaque reference for a scanning device, recorded in check-in audit rows. */
export function generateDeviceReference(): string {
  return randomString(12);
}

/**
 * Credential that authorizes access to a single registration.
 *
 * Emailed to the buyer as a link, stored only as a hash. Unlike the ticket QR
 * credential this is a one-off random value: it authorizes viewing, not
 * admission, so it never needs to be re-derived — rotating it is safe.
 */
export function generateRegistrationAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRegistrationAccessToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
