import { describe, expect, it } from 'vitest';
import {
  currencyExponent,
  formatMoney,
  percentageOf,
  sumMinor,
  toMajorUnits,
  toMinorUnits,
} from '@/lib/money';

/**
 * Money.
 *
 * Every assertion here is about avoiding floating-point error in prices. A
 * platform that stores ₹499.00 as 499.00000000000006 will eventually take the
 * wrong amount, so the conversions are tested directly.
 */
describe('money', () => {
  it('converts major units to minor units without floating point drift', () => {
    expect(toMinorUnits(499, 'INR')).toBe(49_900);
    expect(toMinorUnits('499.00', 'INR')).toBe(49_900);
    expect(toMinorUnits(499.5, 'INR')).toBe(49_950);
    expect(toMinorUnits(0.01, 'INR')).toBe(1);
    expect(toMinorUnits(0, 'INR')).toBe(0);
  });

  it('rounds half away from zero rather than truncating', () => {
    // 19.99 * 100 is 1998.9999999999998 in binary floating point.
    expect(toMinorUnits(19.99, 'INR')).toBe(1_999);
    expect(toMinorUnits(0.615, 'INR')).toBe(62);
    expect(toMinorUnits(1.005, 'INR')).toBe(101);
  });

  it('converts back to major units', () => {
    expect(toMajorUnits(49_900, 'INR')).toBe(499);
    expect(toMajorUnits(1, 'INR')).toBe(0.01);
  });

  it('knows which currencies do not have two decimal places', () => {
    expect(currencyExponent('INR')).toBe(2);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KRW')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('jpy')).toBe(0);
  });

  it('handles zero-decimal currencies without inventing paise', () => {
    expect(toMinorUnits(1500, 'JPY')).toBe(1500);
    expect(toMajorUnits(1500, 'JPY')).toBe(1500);
  });

  it('formats an amount the way a buyer expects to read it', () => {
    expect(formatMoney(49_900, 'INR', 'en-IN')).toContain('499.00');
    expect(formatMoney(0, 'INR', 'en-IN')).toContain('0.00');
    expect(formatMoney(1500, 'JPY', 'en-JP')).toContain('1,500');
  });

  it('refuses to sum mixed currencies instead of producing a meaningless total', () => {
    expect(
      sumMinor([
        { amountMinor: 100, currency: 'INR' },
        { amountMinor: 250, currency: 'INR' },
      ]),
    ).toEqual({
      amountMinor: 350,
      currency: 'INR',
    });

    expect(() =>
      sumMinor([
        { amountMinor: 100, currency: 'INR' },
        { amountMinor: 100, currency: 'USD' },
      ]),
    ).toThrow(/mixed currencies/i);
  });

  it('rejects values that are not numbers', () => {
    expect(() => toMinorUnits('not a price', 'INR')).toThrow(/invalid money amount/i);
    expect(() => toMinorUnits(Number.NaN, 'INR')).toThrow(/invalid money amount/i);
  });

  it('computes a percentage without drift', () => {
    expect(percentageOf(49_900, 18)).toBe(8_982);
    expect(percentageOf(100_000, 0)).toBe(0);
  });
});
