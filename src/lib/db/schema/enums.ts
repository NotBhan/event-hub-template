import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Lifecycle enums.
 *
 * These mirror the recommended state machines in the architecture spec. They are
 * defined as real PostgreSQL enums so invalid states are rejected by the database
 * even if application code has a bug.
 */

export const eventFormatEnum = pgEnum('event_format', ['in_person', 'online', 'hybrid']);

export const eventVisibilityEnum = pgEnum('event_visibility', ['public', 'private']);

export const eventStatusEnum = pgEnum('event_status', [
  'draft',
  'published',
  'cancelled',
  'completed',
]);

export const refundPolicyEnum = pgEnum('refund_policy', [
  'no_refunds',
  'refundable_until_start',
  'refundable_until_date',
  'custom',
]);

export const orderStatusEnum = pgEnum('order_status', [
  'pending_payment',
  'confirmed',
  'expired',
  'cancelled',
]);

export const paymentStatusEnum = pgEnum('payment_status', [
  'created',
  'authorized',
  'captured',
  'failed',
  'partially_refunded',
  'refunded',
]);

export const refundStatusEnum = pgEnum('refund_status', [
  'requested',
  'pending',
  'succeeded',
  'failed',
]);

export const ticketStatusEnum = pgEnum('ticket_status', ['issued', 'void']);

/**
 * Check-in is recorded as its own operation rather than a ticket status, so a
 * ticket can remain valid while carrying an accepted admission record.
 */
export const checkInOutcomeEnum = pgEnum('check_in_outcome', [
  'accepted',
  'already_checked_in',
  'wrong_event',
  'invalid_token',
  'void_ticket',
  'unauthorized',
]);

export const emailStatusEnum = pgEnum('email_status', ['pending', 'sent', 'failed', 'abandoned']);

export const notificationTypeEnum = pgEnum('notification_type', [
  'registration_confirmation',
  'order_confirmation',
  'tickets_issued',
  'event_reminder',
  'refund_processed',
  'event_cancelled',
  'staff_invitation',
]);

export const webhookStatusEnum = pgEnum('webhook_status', [
  'received',
  'processed',
  'failed',
  'ignored',
]);
