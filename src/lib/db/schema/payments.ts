import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization, user } from './auth';
import { paymentStatusEnum, refundStatusEnum, webhookStatusEnum } from './enums';
import { orderItems, orders } from './orders';
import { tickets } from './tickets';

/**
 * Payments module.
 *
 * Payment and refund records are separate from orders so that failed attempts,
 * retries and partial refunds remain individually auditable. Every record stores
 * its currency alongside the amount.
 */

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),

    /** Which adapter handled this payment, e.g. 'razorpay' or 'simulated'. */
    provider: text('provider').notNull(),
    providerOrderId: text('provider_order_id').notNull(),
    providerPaymentId: text('provider_payment_id'),
    providerSignature: text('provider_signature'),

    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),

    status: paymentStatusEnum('status').notNull().default('created'),
    method: text('method'),

    capturedAt: timestamp('captured_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),

    idempotencyKey: text('idempotency_key'),

    /** Non-sensitive provider metadata (payment method details, status codes). */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('payments_provider_order_id_unique').on(table.provider, table.providerOrderId),
    uniqueIndex('payments_provider_payment_id_unique').on(table.provider, table.providerPaymentId),
    index('payments_order_id_idx').on(table.orderId),
    index('payments_status_idx').on(table.status),
    index('payments_organization_id_idx').on(table.organizationId),
    index('payments_created_at_idx').on(table.createdAt),
    check('payments_amount_positive', sql`${table.amountMinor} >= 0`),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),

    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),

    /** Populated once the provider accepts the refund request. */
    providerRefundId: text('provider_refund_id'),

    reason: text('reason'),
    notes: text('notes'),
    requestedBy: text('requested_by').references(() => user.id, { onDelete: 'set null' }),

    status: refundStatusEnum('status').notNull().default('requested'),
    failureReason: text('failure_reason'),
    succeededAt: timestamp('succeeded_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('refunds_provider_refund_id_unique').on(table.providerRefundId),
    index('refunds_payment_id_idx').on(table.paymentId),
    index('refunds_order_id_idx').on(table.orderId),
    index('refunds_status_idx').on(table.status),
    index('refunds_organization_id_idx').on(table.organizationId),
    check('refunds_amount_positive', sql`${table.amountMinor} > 0`),
  ],
);

/**
 * Ties a refund to the specific tickets or line items it cancels. Required when
 * a refund must void particular admissions rather than the whole order.
 */
export const refundItems = pgTable(
  'refund_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'restrict' }),
    orderItemId: uuid('order_item_id').references(() => orderItems.id, { onDelete: 'restrict' }),

    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('refund_items_refund_id_idx').on(table.refundId),
    index('refund_items_ticket_id_idx').on(table.ticketId),
    check(
      'refund_items_target_present',
      sql`${table.ticketId} IS NOT NULL OR ${table.orderItemId} IS NOT NULL`,
    ),
  ],
);

/**
 * Webhook event log.
 *
 * The provider event ID is unique per provider so a duplicated delivery can never
 * apply a financial state change twice. The signature verification result is
 * recorded so rejected payloads remain auditable.
 *
 * Only a redacted summary of the payload is stored — never the full provider body.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),

    signatureVerified: boolean('signature_verified').notNull().default(false),
    status: webhookStatusEnum('status').notNull().default('received'),

    payloadSummary: jsonb('payload_summary').$type<Record<string, unknown>>().default({}),
    errorMessage: text('error_message'),

    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('webhook_events_provider_event_unique').on(table.provider, table.providerEventId),
    index('webhook_events_status_idx').on(table.status),
    index('webhook_events_received_at_idx').on(table.receivedAt),
  ],
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type Refund = typeof refunds.$inferSelect;
export type NewRefund = typeof refunds.$inferInsert;
export type RefundItem = typeof refundItems.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
