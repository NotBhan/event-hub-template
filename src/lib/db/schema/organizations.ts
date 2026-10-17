import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organization } from './auth';

/**
 * Application-owned organization settings.
 *
 * Authentication metadata is not a substitute for business configuration, so
 * branding, contact details, currency and feature switches live here instead of
 * inside the auth library's organization record.
 *
 * One row per organization: a client installation provisions exactly one.
 */
export const organizationSettings = pgTable(
  'organization_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id')
      .notNull()
      .unique()
      .references(() => organization.id, { onDelete: 'cascade' }),

    brandName: text('brand_name').notNull(),
    logoUrl: text('logo_url'),
    primaryColor: text('primary_color').default('#4f46e5'),
    supportEmail: text('support_email'),
    supportPhone: text('support_phone'),

    /** ISO 4217 code used for new events and money formatting. */
    defaultCurrency: text('default_currency').notNull().default('INR'),
    defaultTimezone: text('default_timezone').notNull().default('Asia/Kolkata'),

    contactAddressLines: jsonb('contact_address_lines').$type<string[]>().default([]),
    /** Deployment-level feature switches, e.g. { qrCheckIn: false }. */
    featureFlags: jsonb('feature_flags').$type<Record<string, boolean>>().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('organization_settings_organization_id_idx').on(table.organizationId)],
);

export type OrganizationSettings = typeof organizationSettings.$inferSelect;
export type NewOrganizationSettings = typeof organizationSettings.$inferInsert;
