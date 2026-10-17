/**
 * Database scalar coercion.
 *
 * PostgreSQL aggregates do not arrive as JavaScript numbers. `sum()` and
 * `min()` come back as strings, and anything `::bigint` is deliberately returned
 * as a string by the driver so that values beyond `Number.MAX_SAFE_INTEGER` are
 * not silently rounded.
 *
 * Money is stored in minor units and totals can legitimately exceed 2^31, so the
 * string form is the correct wire format — but comparing it to a number, as in
 * `if (cheapest === 0)`, silently fails. Every aggregate crosses this boundary
 * through one of these helpers instead of being cast at the call site.
 */

/** Coerces a numeric database scalar to a number, with a fallback. */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/** Coerces an optional aggregate, preserving SQL NULL as `null`. */
export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
