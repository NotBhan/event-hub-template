/**
 * PostgreSQL error inspection.
 *
 * Drizzle wraps driver failures in a `DrizzleQueryError`, so the PostgreSQL
 * error code and constraint name are not on the error itself — they are further
 * down the `cause` chain. Checking `error.code` directly therefore never matches,
 * and a perfectly expected condition (a duplicate key) turns into an unhandled
 * 500.
 *
 * These helpers walk the chain so callers can ask the real question: "was this a
 * unique violation, and on which constraint?"
 */

interface PostgresErrorLike {
  code?: unknown;
  constraint?: unknown;
  constraint_name?: unknown;
  detail?: unknown;
  message?: unknown;
  cause?: unknown;
}

/** Walks the cause chain and returns the first PostgreSQL error code found. */
export function postgresErrorCode(error: unknown): string | null {
  let current = error as PostgresErrorLike | undefined;
  let depth = 0;

  while (current && depth < 10) {
    if (typeof current.code === 'string') return current.code;
    current = current.cause as PostgresErrorLike | undefined;
    depth += 1;
  }

  return null;
}

/** Walks the cause chain and returns the first constraint name found. */
export function postgresConstraint(error: unknown): string | null {
  let current = error as PostgresErrorLike | undefined;
  let depth = 0;

  while (current && depth < 10) {
    const constraint = current.constraint_name ?? current.constraint;
    if (typeof constraint === 'string') return constraint;
    current = current.cause as PostgresErrorLike | undefined;
    depth += 1;
  }

  return null;
}

/** The `detail` field, e.g. `Key (ticket_id)=(...) already exists.` */
export function postgresDetail(error: unknown): string | null {
  let current = error as PostgresErrorLike | undefined;
  let depth = 0;

  while (current && depth < 10) {
    if (typeof current.detail === 'string') return current.detail;
    current = current.cause as PostgresErrorLike | undefined;
    depth += 1;
  }

  return null;
}

/** Every message in the cause chain, for logging without losing the real reason. */
export function errorChainMessage(error: unknown): string {
  const messages: string[] = [];
  let current = error as PostgresErrorLike | undefined;
  let depth = 0;

  while (current && depth < 10) {
    if (typeof current.message === 'string' && current.message) messages.push(current.message);
    current = current.cause as PostgresErrorLike | undefined;
    depth += 1;
  }

  return messages.join(' ← ') || 'Unknown error';
}

/** PostgreSQL's unique-violation code. */
const UNIQUE_VIOLATION = '23505';

/**
 * True when the failure was a unique constraint violation, optionally limited to
 * one named constraint. Used to turn an expected duplicate into a domain result
 * instead of an error.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (postgresErrorCode(error) !== UNIQUE_VIOLATION) {
    // A conflict target without a named constraint surfaces only in the detail.
    const detail = postgresDetail(error);
    if (!detail?.includes('already exists')) return false;
  }

  if (!constraint) return true;

  const found = postgresConstraint(error);
  if (found === constraint) return true;

  // `onConflictDoNothing` and some drivers omit the constraint name, so fall back
  // to the message text before giving up.
  return errorChainMessage(error).includes(constraint);
}
