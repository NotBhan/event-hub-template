import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization, user } from './auth';
import { orderStatusEnum } from './enums';
import { events } from './events';
import { ticketTypes } from './inventory';

/**
 * Commerce module: orders and their line items.
 *
 * An order is not a payment and a payment is not a refund. Each is its own
 * record so failed attempts, retries and partial refunds stay auditable.
 *
 * Prices are snapshotted onto the order: editing a ticket type later must never
 * change an existing order.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),

    /** Null for guest checkout. */
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),

    buyerName: text('buyer_name').notNull(),
    buyerEmail: text('buyer_email').notNull(),
    buyerPhone: text('buyer_phone'),

    /**
     * Reference the buyer sees and quotes, e.g. ORD-9QX4M2-7KB3TN.
     *
     * Display only: it is never an authorization credential, because a
     * hard-to-guess string is not access control.
     */
    publicReference: text('public_reference').notNull(),

    /**
     * SHA-256 of the secret in the buyer's registration link. This is what
     * authorizes a guest — who has no account — to view their own tickets, and
     * what keeps the link out of reach of anyone who merely guesses a reference.
     */
    accessTokenHash: text('access_token_hash').notNull(),

    status: orderStatusEnum('status').notNull().default('pending_payment'),

    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull().default(0),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),
    discountMinor: bigint('discount_minor', { mode: 'number' }).notNull().default(0),
    feeMinor: bigint('fee_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull(),

    /** When the inventory reservation is released. Null for free orders. */
    reservationExpiresAt: timestamp('reservation_expires_at', { withTimezone: true }),

    /**
     * Client-supplied key that makes order creation safe to retry, e.g. a double
     * form submission. Unique across all orders.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    notes: text('notes'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('orders_idempotency_key_unique').on(table.idempotencyKey),
    uniqueIndex('orders_public_reference_unique').on(table.publicReference),
    index('orders_access_token_hash_idx').on(table.accessTokenHash),
    index('orders_event_status_idx').on(table.eventId, table.status),
    index('orders_event_created_at_idx').on(table.eventId, table.createdAt),
    index('orders_buyer_email_idx').on(table.buyerEmail),
    index('orders_user_id_idx').on(table.userId),
    index('orders_status_reservation_expires_idx').on(table.status, table.reservationExpiresAt),
    index('orders_organization_id_idx').on(table.organizationId),
    check('orders_total_non_negative', sql`${table.totalMinor} >= 0`),
    check('orders_subtotal_non_negative', sql`${table.subtotalMinor} >= 0`),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    ticketTypeId: uuid('ticket_type_id')
      .notNull()
      .references(() => ticketTypes.id, { onDelete: 'restrict' }),

    quantity: integer('quantity').notNull(),

    /** Immutable snapshots taken when the order was created. */
    ticketNameSnapshot: text('ticket_name_snapshot').notNull(),
    unitPriceMinorSnapshot: bigint('unit_price_minor_snapshot', { mode: 'number' })
      .notNull()
      .default(0),
    discountMinorSnapshot: bigint('discount_minor_snapshot', { mode: 'number' }).notNull().default(0),
    taxMinorSnapshot: bigint('tax_minor_snapshot', { mode: 'number' }).notNull().default(0),
    lineTotalMinor: bigint('line_total_minor', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('order_items_order_id_idx').on(table.orderId),
    index('order_items_ticket_type_id_idx').on(table.ticketTypeId),
    check('order_items_quantity_positive', sql`${table.quantity} > 0`),
  ],
);

/**
 * One attendee row per admission. An order for five tickets produces five
 * attendees, which is what makes ticket-specific check-in, cancellation and
 * refunds possible.
 */
export const attendees = pgTable(
  'attendees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),

    /** Answers to custom registration questions, stored as a plain object. */
    registrationAnswers: jsonb('registration_answers').$type<Record<string, string>>().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('attendees_order_id_idx').on(table.orderId),
    index('attendees_order_item_id_idx').on(table.orderItemId),
    index('attendees_email_idx').on(table.email),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
export type Attendee = typeof attendees.$inferSelect;
export type NewAttendee = typeof attendees.$inferInsert;
