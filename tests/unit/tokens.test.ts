import { describe, expect, it } from 'vitest';
import {
  deriveTicketToken,
  generateIdempotencyKey,
  generateOrderReference,
  generateRegistrationAccessToken,
  generateTicketReference,
  hashQrToken,
  hashRegistrationAccessToken,
  parseTicketToken,
  safeEqual,
} from '@/lib/security/tokens';
import { toNullableNumber, toNumber } from '@/lib/db/scalars';

/**
 * Credentials.
 *
 * The ticket credential is the security boundary of the whole platform: whoever
 * holds it gets in. These tests pin the properties that make it safe — derived
 * rather than stored, unique per ticket, and unguessable without the secret.
 */
describe('ticket credentials', () => {
  const secret = 'a'.repeat(48);
  const otherSecret = 'b'.repeat(48);

  const ticketId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

  it('derives the same credential for the same ticket', () => {
    // Determinism is what allows the QR to be re-rendered without storing it.
    expect(deriveTicketToken(ticketId, secret)).toBe(deriveTicketToken(ticketId, secret));
  });

  it('derives a different credential for every ticket', () => {
    const another = '11111111-2222-4333-8444-555555555555';

    expect(deriveTicketToken(ticketId, secret)).not.toBe(deriveTicketToken(another, secret));
  });

  it('depends on the secret, so rotating it invalidates old credentials', () => {
    expect(deriveTicketToken(ticketId, secret)).not.toBe(deriveTicketToken(ticketId, otherSecret));
  });

  it('hashes to a stable, indexed value', () => {
    const token = deriveTicketToken(ticketId, secret);

    expect(hashQrToken(token)).toBe(hashQrToken(token));
    expect(hashQrToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses its own output back to the ticket id', () => {
    const parsed = parseTicketToken(deriveTicketToken(ticketId, secret));

    expect(parsed).toEqual({ ticketId });
  });

  it('refuses anything that is not a well-formed credential', () => {
    expect(parseTicketToken('')).toBeNull();
    expect(parseTicketToken('nonsense')).toBeNull();
    expect(parseTicketToken(`t1.${ticketId}`)).toBeNull();
    expect(parseTicketToken(`t1.${ticketId}.sig.extra`)).toBeNull();
    // A different version is not silently accepted.
    expect(parseTicketToken(`t2.${ticketId}.sig`)).toBeNull();
    // The id must be a UUID before it is allowed near a query.
    expect(parseTicketToken("t1.' OR 1=1 --.sig")).toBeNull();
    expect(parseTicketToken('t1.not-a-uuid.sig')).toBeNull();
  });

  it('produces a signature that cannot be guessed from the id', () => {
    const token = deriveTicketToken(ticketId, secret);
    const [, , signature] = token.split('.');

    expect(signature).toBeTruthy();
    expect(signature!.length).toBeGreaterThan(30);

    // A trivial replacement must not verify.
    expect(hashQrToken(`t1.${ticketId}.forged`)).not.toBe(hashQrToken(token));
  });
});

describe('reference generation', () => {
  it('produces readable references without ambiguous characters', () => {
    const reference = generateTicketReference();

    expect(reference).toMatch(/^TKT-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}$/);
    // No I, L, O or U, so a reference cannot be misread over the phone.
    const body = reference.slice(4).replace('-', '');
    expect(body).not.toMatch(/[ILOU]/);
  });

  it('produces unique order references', () => {
    const references = new Set(Array.from({ length: 500 }, () => generateOrderReference()));

    expect(references.size).toBe(500);
    expect([...references][0]).toMatch(/^ORD-/);
  });

  it('produces unique idempotency keys', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateIdempotencyKey()));

    expect(keys.size).toBe(200);
    expect([...keys][0]).toMatch(/^ord_/);
  });
});

describe('registration access tokens', () => {
  it('hashes deterministically and never stores the raw value', () => {
    const token = generateRegistrationAccessToken();

    expect(hashRegistrationAccessToken(token)).toBe(hashRegistrationAccessToken(token));
    expect(hashRegistrationAccessToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRegistrationAccessToken(token)).not.toBe(token);
  });

  it('produces a distinct secret each time', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateRegistrationAccessToken()));

    expect(tokens.size).toBe(100);
  });
});

describe('safeEqual', () => {
  it('compares equal values and rejects different ones', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    // Different lengths must not throw.
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('database scalar coercion', () => {
  it('converts the string form the driver returns for aggregates', () => {
    // `sum()` and `min()` arrive as strings; comparing them to numbers silently fails.
    expect(toNumber('2046')).toBe(2046);
    expect(toNumber('0')).toBe(0);
    expect(toNumber(42)).toBe(42);
    expect(toNumber(10n)).toBe(10);
  });

  it('never turns a missing value into NaN', () => {
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber(null)).toBe(0);
    expect(toNumber('')).toBe(0);
    expect(toNumber('not a number')).toBe(0);
    expect(toNumber(Number.NaN)).toBe(0);
    expect(toNumber('abc', 7)).toBe(7);
  });

  it('preserves SQL NULL as null where that is meaningful', () => {
    expect(toNullableNumber(null)).toBeNull();
    expect(toNullableNumber(undefined)).toBeNull();
    expect(toNullableNumber('')).toBeNull();
    expect(toNullableNumber('0')).toBe(0);
    expect(toNullableNumber(0)).toBe(0);
  });
});
