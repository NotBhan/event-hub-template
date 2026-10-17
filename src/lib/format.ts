import { site } from '@/config/site';

/**
 * Presentation helpers.
 *
 * Every date on this platform is rendered in the *event's* timezone, not the
 * server's or the viewer's. An attendee in London looking at a Bangalore event
 * must see the time they need to turn up in Bangalore.
 */

export function formatDateTime(value: Date, timezone: string, locale = site.locale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(value);
}

export function formatDate(value: Date, timezone: string, locale = site.locale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone: timezone,
  }).format(value);
}

export function formatLongDate(value: Date, timezone: string, locale = site.locale): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(value);
}

export function formatTime(value: Date, timezone: string, locale = site.locale): string {
  return new Intl.DateTimeFormat(locale, {
    timeStyle: 'short',
    timeZone: timezone,
  }).format(value);
}

/**
 * Human-friendly event window.
 *
 * Collapses to the readable minimum: a single-day event shows one date, a
 * multi-day event shows a range.
 */
export function formatEventWindow(
  startsAt: Date,
  endsAt: Date,
  timezone: string,
  locale = site.locale,
): string {
  const sameDay = isSameDayInZone(startsAt, endsAt, timezone);

  if (sameDay) {
    return `${formatLongDate(startsAt, timezone, locale)} · ${formatTime(startsAt, timezone, locale)} – ${formatTime(endsAt, timezone, locale)}`;
  }

  return `${formatLongDate(startsAt, timezone, locale)} ${formatTime(startsAt, timezone, locale)} → ${formatLongDate(endsAt, timezone, locale)} ${formatTime(endsAt, timezone, locale)}`;
}

function isSameDayInZone(a: Date, b: Date, timezone: string): boolean {
  const format = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  });
  return format.format(a) === format.format(b);
}

/** Short form for cards and tables, e.g. "Sat, 14 Mar 2026 · 6:00 pm". */
export function formatCompactWindow(
  startsAt: Date,
  timezone: string,
  locale = site.locale,
): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(startsAt);
}

/** Relative time for activity feeds, e.g. "3 minutes ago". */
export function formatRelative(value: Date, now = new Date(), locale = site.locale): string {
  const seconds = Math.round((value.getTime() - now.getTime()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  const divisions: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
    { amount: 60, unit: 'second' },
    { amount: 60, unit: 'minute' },
    { amount: 24, unit: 'hour' },
    { amount: 7, unit: 'day' },
    { amount: 4.34524, unit: 'week' },
    { amount: 12, unit: 'month' },
    { amount: Number.POSITIVE_INFINITY, unit: 'year' },
  ];

  let duration = seconds;
  for (const division of divisions) {
    if (Math.abs(duration) < division.amount) {
      return formatter.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }

  return formatter.format(Math.round(duration), 'year');
}

export const EVENT_FORMAT_LABELS: Record<string, string> = {
  in_person: 'In person',
  online: 'Online',
  hybrid: 'Hybrid',
};

export const EVENT_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  published: 'Published',
  cancelled: 'Cancelled',
  completed: 'Completed',
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  confirmed: 'Confirmed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  created: 'Created',
  authorized: 'Authorized',
  captured: 'Paid',
  failed: 'Failed',
  partially_refunded: 'Partly refunded',
  refunded: 'Refunded',
};

export const REFUND_STATUS_LABELS: Record<string, string> = {
  requested: 'Requested',
  pending: 'Pending',
  succeeded: 'Refunded',
  failed: 'Failed',
};

export const TICKET_STATUS_LABELS: Record<string, string> = {
  issued: 'Valid',
  void: 'Void',
};

export const CHECK_IN_LABELS: Record<string, string> = {
  accepted: 'Admitted',
  already_checked_in: 'Already checked in',
  wrong_event: 'Wrong event',
  invalid_token: 'Invalid ticket',
  void_ticket: 'Void ticket',
  unauthorized: 'Not authorized',
};

export const REFUND_POLICY_LABELS: Record<string, string> = {
  no_refunds: 'No refunds',
  refundable_until_start: 'Refundable until the event starts',
  refundable_until_date: 'Refundable until a set date',
  custom: 'Custom policy',
};

/**
 * Badge tone per status, so the same state reads the same colour everywhere.
 */
export const STATUS_TONES: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  draft: 'neutral',
  published: 'success',
  cancelled: 'danger',
  completed: 'info',

  pending_payment: 'warning',
  confirmed: 'success',
  expired: 'neutral',

  created: 'neutral',
  authorized: 'warning',
  captured: 'success',
  failed: 'danger',
  partially_refunded: 'warning',
  refunded: 'info',

  requested: 'warning',
  pending: 'warning',
  succeeded: 'success',

  issued: 'success',
  void: 'danger',

  accepted: 'success',
  already_checked_in: 'warning',
  wrong_event: 'danger',
  invalid_token: 'danger',
  void_ticket: 'danger',
  unauthorized: 'danger',
};
