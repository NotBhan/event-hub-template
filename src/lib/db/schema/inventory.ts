import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { events } from './events';

/**
 * Inventory module: ticket categories, capacity and reservation counters.
 *
 * Counters are maintained on the row itself and guarded by a database check
 * constraint, so overselling is impossible even under concurrent requests:
 *
 *   available = quantity_total - quantity_sold - quantity_reserved
 *
 * Money is stored as an integer in the currency's smallest unit (paise for INR).
 */
export const ticketTypes = pgTable(
  'ticket_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    description: text('description'),

    priceMinor: bigint('price_minor', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull(),

    quantityTotal: integer('quantity_total').notNull(),
    quantitySold: integer('quantity_sold').notNull().default(0),
    quantityReserved: integer('quantity_reserved').notNull().default(0),

    /** Per-order purchase limits. */
    minPerOrder: integer('min_per_order').notNull().default(1),
    maxPerOrder: integer('max_per_order').notNull().default(10),

    salesStartAt: timestamp('sales_start_at', { withTimezone: true }),
    salesEndAt: timestamp('sales_end_at', { withTimezone: true }),

    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('ticket_types_event_id_idx').on(table.eventId),
    check('ticket_types_price_non_negative', sql`${table.priceMinor} >= 0`),
    check('ticket_types_total_positive', sql`${table.quantityTotal} >= 0`),
    check('ticket_types_sold_non_negative', sql`${table.quantitySold} >= 0`),
    check('ticket_types_reserved_non_negative', sql`${table.quantityReserved} >= 0`),
    // The capacity invariant, enforced by the database itself.
    check(
      'ticket_types_capacity_not_exceeded',
      sql`${table.quantitySold} + ${table.quantityReserved} <= ${table.quantityTotal}`,
    ),
    check('ticket_types_order_limits_valid', sql`${table.minPerOrder} <= ${table.maxPerOrder}`),
    check(
      'ticket_types_sales_window_valid',
      sql`${table.salesEndAt} IS NULL OR ${table.salesStartAt} IS NULL OR ${table.salesEndAt} > ${table.salesStartAt}`,
    ),
  ],
);

export type TicketType = typeof ticketTypes.$inferSelect;
export type NewTicketType = typeof ticketTypes.$inferInsert;

/** Remaining capacity, derived consistently wherever it is displayed. */
export function availableQuantity(
  ticketType: Pick<TicketType, 'quantityTotal' | 'quantitySold' | 'quantityReserved'>,
): number {
  return ticketType.quantityTotal - ticketType.quantitySold - ticketType.quantityReserved;
}
