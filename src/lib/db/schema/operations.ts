import {
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
import {
  emailStatusEnum,
  notificationTypeEnum,
  objectCleanupReasonEnum,
  objectCleanupStatusEnum,
} from './enums';

/**
 * Operational records: audit trail, the transactional email outbox and the object
 * cleanup queue.
 *
 * Both queues exist for the same reason: the work they carry talks to a system
 * outside the database, and no external outage should be able to roll back a
 * committed business change. The intent is recorded transactionally and carried
 * out afterwards, with retries that are explicit rather than implicit.
 */

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),
    actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),

    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),

    /** Minimal supporting context. Never contains credentials or full payloads. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('audit_logs_organization_created_idx').on(table.organizationId, table.createdAt),
    index('audit_logs_resource_idx').on(table.resourceType, table.resourceId),
    index('audit_logs_actor_idx').on(table.actorUserId, table.createdAt),
  ],
);

export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),

    recipient: text('recipient').notNull(),
    notificationType: notificationTypeEnum('notification_type').notNull(),
    subject: text('subject').notNull(),

    /** Template name plus its data. Kept separate from the rendered body. */
    template: text('template').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().default({}),

    status: emailStatusEnum('status').notNull().default('pending'),
    retryCount: integer('retry_count').notNull().default(0),
    maxRetries: integer('max_retries').notNull().default(5),
    lastError: text('last_error'),

    /** Allows a send to be deferred, e.g. an event reminder. */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('email_outbox_status_scheduled_idx').on(table.status, table.scheduledAt),
    index('email_outbox_recipient_idx').on(table.recipient),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
export type EmailOutboxEntry = typeof emailOutbox.$inferSelect;
export type NewEmailOutboxEntry = typeof emailOutbox.$inferInsert;

/**
 * Objects waiting to be removed from storage.
 *
 * Deleting an object cannot be part of the transaction that unreferences it: the
 * database and the bucket are separate systems, and a bucket outage must never
 * roll back an event edit or an event deletion. The intent to delete is therefore
 * recorded inside that transaction — so a committed change never loses the
 * cleanup it implies — and carried out afterwards, with retries.
 *
 * One row per key: queuing the same object twice (replaced, then deleted with its
 * event) updates the existing row rather than creating a second intent.
 */
export const objectCleanupQueue = pgTable(
  'object_cleanup_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    objectKey: text('object_key').notNull(),
    reason: objectCleanupReasonEnum('reason').notNull(),

    status: objectCleanupStatusEnum('status').notNull().default('pending'),
    retryCount: integer('retry_count').notNull().default(0),
    maxRetries: integer('max_retries').notNull().default(5),
    /** The provider's message, kept for whoever has to explain a stuck object. */
    lastError: text('last_error'),

    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).defaultNow().notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('object_cleanup_queue_object_key_unique').on(table.objectKey),
    index('object_cleanup_queue_status_scheduled_idx').on(table.status, table.scheduledAt),
  ],
);

export type ObjectCleanupEntry = typeof objectCleanupQueue.$inferSelect;
export type NewObjectCleanupEntry = typeof objectCleanupQueue.$inferInsert;
