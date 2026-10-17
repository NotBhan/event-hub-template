/**
 * Money handling.
 *
 * Amounts are always integers in the currency's smallest unit — paise for INR,
 * cents for USD. Floating point is never used for money, and the currency code is
 * always stored alongside the amount so it can never be reinterpreted.
 *
 * For a price displayed as ₹499.00, the stored INR amount is 49900.
 */

/** Currencies whose smallest unit is the whole unit. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/** Currencies with three decimal places. */
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

function factorFor(currency: string): number {
  return 10 ** currencyExponent(currency);
}

/** Converts a major-unit amount (499.00) to minor units (49900). */
export function toMinorUnits(amount: number | string, currency: string): number {
  const numeric = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(numeric)) throw new Error(`Invalid money amount: ${String(amount)}`);

  const factor = factorFor(currency);
  // Round half away from zero so displayed and stored values agree.
  return Math.round((numeric + Number.EPSILON) * factor);
}

/** Converts minor units (49900) back to a major-unit number (499). */
export function toMajorUnits(amountMinor: number, currency: string): number {
  return amountMinor / factorFor(currency);
}

/** Formats for display, e.g. `formatMoney(49900, 'INR', 'en-IN')` → "₹499.00". */
export function formatMoney(amountMinor: number, currency: string, locale = 'en-IN'): string {
  const exponent = currencyExponent(currency);

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(toMajorUnits(amountMinor, currency));
}

/**
 * Sums money values that share a currency, rejecting mixed currencies rather
 * than silently producing a meaningless total.
 */
export function sumMinor(amounts: readonly { amountMinor: number; currency: string }[]): {
  amountMinor: number;
  currency: string | null;
} {
  let total = 0;
  let currency: string | null = null;

  for (const entry of amounts) {
    if (currency === null) currency = entry.currency;
    else if (currency !== entry.currency) {
      throw new Error(`Cannot sum mixed currencies: ${currency} and ${entry.currency}`);
    }
    total += entry.amountMinor;
  }

  return { amountMinor: total, currency };
}

/** Whole-number percentage of an amount, e.g. a tax rate. */
export function percentageOf(amountMinor: number, percent: number): number {
  return Math.round((amountMinor * percent) / 100);
}
