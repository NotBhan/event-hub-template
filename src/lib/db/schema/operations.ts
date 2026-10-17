import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organization, user } from './auth';
import { emailStatusEnum, notificationTypeEnum } from './enums';

/**
 * Operational records: audit trail and the transactional email outbox.
 *
 * The outbox decouples sending from the request/transaction that triggered it, so
 * an email failure can never roll back a confirmed order, and retries are
 * explicit rather than implicit.
 */

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').references(() => organization.id, { onDelete: 'cascade' }),
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
    organizationId: text('organization_id').references(() => organization.id, { onDelete: 'cascade' }),

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
