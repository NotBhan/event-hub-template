import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { attendees, orderItems, orders } from './orders';
import { ticketStatusEnum } from './enums';
import { events } from './events';

/**
 * Ticket module: one ticket per attendee admission.
 *
 * The QR code encodes a high-entropy random token. Only a hash of that token is
 * stored, so a database leak does not yield usable admission credentials and the
 * token is never derivable from a sequential identifier.
 *
 * The QR payload deliberately contains no personal data — no email, phone or
 * payment information.
 */
export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    attendeeId: uuid('attendee_id')
      .notNull()
      .references(() => attendees.id, { onDelete: 'cascade' }),

    /** Human-readable reference for support conversations, e.g. EVT-7K2M-9QX4. */
    publicReference: text('public_reference').notNull(),
    /** SHA-256 of the random QR token. The token itself is never stored. */
    qrTokenHash: text('qr_token_hash').notNull(),

    status: ticketStatusEnum('status').notNull().default('issued'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('tickets_public_reference_unique').on(table.publicReference),
    uniqueIndex('tickets_qr_token_hash_unique').on(table.qrTokenHash),
    uniqueIndex('tickets_attendee_id_unique').on(table.attendeeId),
    index('tickets_event_id_idx').on(table.eventId),
    index('tickets_order_id_idx').on(table.orderId),
    index('tickets_order_item_id_idx').on(table.orderItemId),
  ],
);

export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
