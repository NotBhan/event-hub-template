import { describe, expect, it } from 'vitest';
import {
  isValidTimezone,
  todayInZone,
  utcToWallClock,
  wallClockToUtc,
  zoneOffsetMs,
} from '@/lib/timezone';

/**
 * Timezones.
 *
 * An event platform that quietly shifts every event by five and a half hours is
 * broken in a way nobody notices until the doors open. These tests pin the
 * conversions, including either side of a daylight-saving transition.
 */
describe('timezone conversion', () => {
  it('treats a form value as wall-clock time in the event timezone', () => {
    // 6:00 pm in India is 12:30 pm UTC.
    expect(wallClockToUtc('2026-03-14T18:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-03-14T12:30:00.000Z',
    );
  });

  it('handles a timezone with no offset', () => {
    expect(wallClockToUtc('2026-03-14T18:00', 'UTC').toISOString()).toBe('2026-03-14T18:00:00.000Z');
  });

  it('is correct on both sides of a daylight-saving change', () => {
    // US clocks move forward on 2026-03-08. Before: UTC-5, after: UTC-4.
    expect(wallClockToUtc('2026-03-01T12:00', 'America/New_York').toISOString()).toBe(
      '2026-03-01T17:00:00.000Z',
    );
    expect(wallClockToUtc('2026-03-20T12:00', 'America/New_York').toISOString()).toBe(
      '2026-03-20T16:00:00.000Z',
    );
  });

  it('is correct on both sides of a southern-hemisphere change', () => {
    // Sydney moves back on 2026-04-05.
    const before = wallClockToUtc('2026-04-01T12:00', 'Australia/Sydney');
    const after = wallClockToUtc('2026-04-20T12:00', 'Australia/Sydney');

    expect(before.toISOString()).toBe('2026-04-01T01:00:00.000Z');
    expect(after.toISOString()).toBe('2026-04-20T02:00:00.000Z');
  });

  it('round-trips a timestamp through a wall-clock string', () => {
    const original = new Date('2026-03-14T12:30:00.000Z');
    const wallClock = utcToWallClock(original, 'Asia/Kolkata');

    expect(wallClock).toBe('2026-03-14T18:00');
    expect(wallClockToUtc(wallClock, 'Asia/Kolkata').toISOString()).toBe(original.toISOString());
  });

  it('omits the time when only a date is wanted', () => {
    expect(utcToWallClock(new Date('2026-03-14T12:30:00.000Z'), 'Asia/Kolkata', false)).toBe(
      '2026-03-14',
    );
  });

  it('reports the offset east of Greenwich as positive', () => {
    expect(zoneOffsetMs(new Date('2026-03-14T12:30:00.000Z'), 'Asia/Kolkata')).toBe(19_800_000);
    expect(zoneOffsetMs(new Date('2026-03-14T12:30:00.000Z'), 'UTC')).toBe(0);
  });

  it('accepts a space instead of the ISO "T" separator', () => {
    expect(wallClockToUtc('2026-03-14 18:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-03-14T12:30:00.000Z',
    );
  });

  it('rejects a value it cannot parse rather than guessing', () => {
    expect(() => wallClockToUtc('14/03/2026', 'Asia/Kolkata')).toThrow(/unrecognised/i);
    expect(() => wallClockToUtc('', 'Asia/Kolkata')).toThrow(/unrecognised/i);
  });

  it('validates timezone names', () => {
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });

  it('reports today in the requested zone', () => {
    // 2026-03-14T20:00Z is already the 15th in India.
    const now = new Date('2026-03-14T20:00:00.000Z');

    expect(todayInZone('UTC', now)).toBe('2026-03-14');
    expect(todayInZone('Asia/Kolkata', now)).toBe('2026-03-15');
  });
});
