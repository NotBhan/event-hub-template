/**
 * Timezone conversion.
 *
 * An event's date is chosen by the organizer as a wall-clock time in the event's
 * own timezone ("9:00 pm on 14 March in Asia/Kolkata"). `<input type="datetime-local">`
 * submits exactly that — a naive local string with no offset. Passing it straight
 * to `new Date()` would interpret it in whatever timezone the *server* happens to
 * run in, which silently shifts every event. This module does the conversion
 * properly, including across daylight-saving boundaries.
 */

/**
 * Converts a wall-clock string from a form ("2026-03-14T18:00") into the correct
 * UTC instant for the given IANA timezone.
 */
export function wallClockToUtc(value: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
  if (!match) throw new Error(`Unrecognised date/time value: ${value}`);

  const [, year, month, day, hour, minute, second] = match;
  const wallClockUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
  );

  /**
   * The zone offset depends on the instant, and the instant depends on the
   * offset. Two passes converge for every real zone: the first pass uses the
   * offset at the naive guess, the second corrects using the offset at the
   * resulting instant, which handles the hour either side of a DST change.
   */
  let instant = wallClockUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    instant = wallClockUtc - zoneOffsetMs(new Date(instant), timeZone);
  }

  return new Date(instant);
}

/**
 * Converts a UTC instant into the wall-clock parts of a timezone, for prefilling
 * form inputs.
 */
export function utcToWallClock(date: Date, timeZone: string, includeTime = true): string {
  const parts = zonedParts(date, timeZone);

  const datePart = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
  if (!includeTime) return datePart;

  return `${datePart}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/**
 * Offset of a timezone from UTC, in milliseconds, at a specific instant.
 * Positive east of Greenwich: +05:30 for Asia/Kolkata yields 19_800_000.
 */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);

  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour === 24 ? 0 : parts.hour,
    parts.minute,
    parts.second,
  );

  return asIfUtc - date.getTime();
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const result: Record<string, number> = {};

  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
  }

  return {
    year: result.year ?? 0,
    month: result.month ?? 1,
    day: result.day ?? 1,
    hour: result.hour ?? 0,
    minute: result.minute ?? 0,
    second: result.second ?? 0,
  };
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** Today's date in a timezone, as `YYYY-MM-DD`. */
export function todayInZone(timeZone: string, now = new Date()): string {
  return utcToWallClock(now, timeZone, false);
}

/** Validates an IANA timezone name, rejecting anything Intl cannot resolve. */
export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Common timezones offered when creating an event. */
export const COMMON_TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Africa/Nairobi',
  'UTC',
] as const;
