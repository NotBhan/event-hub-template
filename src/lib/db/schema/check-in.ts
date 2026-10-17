import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { checkInOutcomeEnum } from './enums';
import { events } from './events';
import { tickets } from './tickets';

/**
 * Check-in module.
 *
 * Every scan attempt is recorded, not just successful admissions, so failures and
 * repeat scans stay auditable (who scanned what, when, from which device).
 *
 * The partial unique index below is the concurrency guarantee: even if two
 * scanners submit the same ticket at the same instant, only one row can be
 * accepted, and the loser receives a database error rather than a duplicate
 * admission.
 */
export const checkInAttempts = pgTable(
  'check_in_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),

    scannerUserId: text('scanner_user_id').references(() => user.id, { onDelete: 'set null' }),

    outcome: checkInOutcomeEnum('outcome').notNull(),
    accepted: boolean('accepted').notNull().default(false),

    /** Opaque reference for the scanning device or session, useful in disputes. */
    deviceReference: text('device_reference'),
    scannedAt: timestamp('scanned_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // At most one accepted check-in per ticket, enforced by the database.
    uniqueIndex('check_in_attempts_one_accepted_per_ticket')
      .on(table.ticketId)
      .where(sql`outcome = 'accepted'`),
    index('check_in_attempts_event_id_scanned_at_idx').on(table.eventId, table.scannedAt),
    index('check_in_attempts_ticket_id_idx').on(table.ticketId),
  ],
);

export type CheckInAttempt = typeof checkInAttempts.$inferSelect;
export type NewCheckInAttempt = typeof checkInAttempts.$inferInsert;
