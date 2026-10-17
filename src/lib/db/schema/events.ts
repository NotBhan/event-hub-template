import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization, user } from './auth';
import { eventFormatEnum, eventStatusEnum, eventVisibilityEnum, refundPolicyEnum } from './enums';

/**
 * Events module: creation, publishing, scheduling, venues, sessions and
 * online access.
 */

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),

    slug: text('slug').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    description: text('description'),
    category: text('category'),
    coverImageUrl: text('cover_image_url'),

    format: eventFormatEnum('format').notNull().default('in_person'),
    visibility: eventVisibilityEnum('visibility').notNull().default('public'),
    status: eventStatusEnum('status').notNull().default('draft'),

    timezone: text('timezone').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),

    registrationOpensAt: timestamp('registration_opens_at', { withTimezone: true }),
    registrationClosesAt: timestamp('registration_closes_at', { withTimezone: true }),

    /** Cancellation policy shown at checkout and enforced by the refund service. */
    refundPolicy: refundPolicyEnum('refund_policy').notNull().default('no_refunds'),
    refundableUntil: timestamp('refundable_until', { withTimezone: true }),
    refundPolicyNotes: text('refund_policy_notes'),

    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('events_organization_slug_unique').on(table.organizationId, table.slug),
    index('events_status_starts_at_idx').on(table.status, table.startsAt),
    index('events_organization_id_idx').on(table.organizationId),
    index('events_visibility_status_idx').on(table.visibility, table.status),
    check('events_end_after_start', sql`${table.endsAt} > ${table.startsAt}`),
    check(
      'events_registration_window_valid',
      sql`${table.registrationClosesAt} IS NULL OR ${table.registrationOpensAt} IS NULL OR ${table.registrationClosesAt} > ${table.registrationOpensAt}`,
    ),
  ],
);

export const eventSessions = pgTable(
  'event_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),

    title: text('title').notNull(),
    description: text('description'),
    speakerName: text('speaker_name'),
    speakerBio: text('speaker_bio'),
    room: text('room'),

    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('event_sessions_event_id_idx').on(table.eventId),
    check('event_sessions_end_after_start', sql`${table.endsAt} > ${table.startsAt}`),
  ],
);

/** Venue details. Present for physical and hybrid events only. */
export const eventLocations = pgTable('event_locations', {
  eventId: uuid('event_id')
    .primaryKey()
    .references(() => events.id, { onDelete: 'cascade' }),

  venueName: text('venue_name').notNull(),
  streetAddress: text('street_address'),
  city: text('city'),
  region: text('region'),
  postalCode: text('postal_code'),
  country: text('country'),
  latitude: numeric('latitude', { precision: 9, scale: 6 }),
  longitude: numeric('longitude', { precision: 9, scale: 6 }),
  directions: text('directions'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

/**
 * Online access details. Private by definition: joining instructions are never
 * included in public event responses and are only released through an authorized
 * endpoint to confirmed attendees and event staff.
 */
export const eventAccess = pgTable('event_access', {
  eventId: uuid('event_id')
    .primaryKey()
    .references(() => events.id, { onDelete: 'cascade' }),

  platform: text('platform').notNull(),
  joinUrl: text('join_url'),
  accessInstructions: text('access_instructions'),
  /** Shown publicly before registration, e.g. "Link sent 24h before the event". */
  publicNote: text('public_note'),
  requiresConfirmedRegistration: boolean('requires_confirmed_registration').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type EventSession = typeof eventSessions.$inferSelect;
export type EventLocation = typeof eventLocations.$inferSelect;
export type EventAccess = typeof eventAccess.$inferSelect;
