import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, closeDatabase } from '../../src/lib/db/client';
import {
  events,
  member,
  orders,
  organization,
  organizationSettings,
  ticketTypes,
  user,
} from '../../src/lib/db/schema';
import { createEvent, publishEvent } from '../../src/features/events/service';
import { createTicketType } from '../../src/features/inventory/service';
import type { OrganizationRole } from '../../src/lib/permissions';

/**
 * Test fixtures.
 *
 * Each fixture builds the smallest complete world a test needs: an organization,
 * a user with a role, an event and its ticket types. Everything is created
 * through the real services, so a fixture can never produce a state the
 * application itself could not.
 */

const createdOrganizationIds: string[] = [];

export interface TestOrganization {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  email: string;
}

/** Creates an organization with one member holding the given role. */
export async function createTestOrganization(
  role: OrganizationRole = 'owner',
): Promise<TestOrganization> {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const suffix = organizationId.slice(0, 8);
  const email = `${role}-${suffix}@example.test`;

  await db().insert(organization).values({
    id: organizationId,
    name: `Test Org ${suffix}`,
    slug: `test-org-${suffix}`,
  });

  await db().insert(user).values({
    id: userId,
    name: `Test ${role}`,
    email,
    emailVerified: true,
  });

  await db().insert(member).values({
    id: randomUUID(),
    organizationId,
    userId,
    role,
  });

  await db().insert(organizationSettings).values({
    organizationId,
    brandName: `Test Org ${suffix}`,
    defaultCurrency: 'INR',
    defaultTimezone: 'Asia/Kolkata',
  });

  createdOrganizationIds.push(organizationId);

  return { organizationId, userId, role, email };
}

export interface TestEventOptions {
  ticketTypes?: {
    name: string;
    priceMinor: number;
    quantityTotal: number;
    maxPerOrder?: number;
    isActive?: boolean;
  }[];
  format?: 'in_person' | 'online' | 'hybrid';
  visibility?: 'public' | 'private';
  published?: boolean;
}

export interface TestEvent {
  eventId: string;
  slug: string;
  ticketTypes: { id: string; name: string; priceMinor: number; quantityTotal: number }[];
}

/** Creates a published event with the ticket types a test asks for. */
export async function createTestEvent(
  organizationId: string,
  actorUserId: string | null,
  options: TestEventOptions = {},
): Promise<TestEvent> {
  const slug = `test-event-${randomUUID().slice(0, 8)}`;
  const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 4 * 60 * 60 * 1000);

  const event = await createEvent(
    organizationId,
    {
      title: `Test Event ${slug.slice(-8)}`,
      slug,
      format: options.format ?? 'in_person',
      visibility: options.visibility ?? 'public',
      timezone: 'Asia/Kolkata',
      startsAt,
      endsAt,
      location:
        (options.format ?? 'in_person') === 'online'
          ? null
          : { venueName: 'Test Venue', city: 'Bengaluru' },
      access:
        (options.format ?? 'in_person') === 'online'
          ? { platform: 'Test Stream' }
          : null,
    },
    actorUserId,
  );

  const definitions = options.ticketTypes ?? [
    { name: 'General', priceMinor: 50_000, quantityTotal: 10 },
  ];

  const created = [];

  for (const [index, definition] of definitions.entries()) {
    const ticketType = await createTicketType(db(), event.id, {
      name: definition.name,
      priceMinor: definition.priceMinor,
      currency: 'INR',
      quantityTotal: definition.quantityTotal,
      maxPerOrder: definition.maxPerOrder ?? 10,
      isActive: definition.isActive ?? true,
      sortOrder: index,
    });

    created.push({
      id: ticketType.id,
      name: ticketType.name,
      priceMinor: ticketType.priceMinor,
      quantityTotal: ticketType.quantityTotal,
    });
  }

  if (options.published !== false) {
    await publishEvent(event.id, organizationId, actorUserId);
  }

  return { eventId: event.id, slug, ticketTypes: created };
}

/** Reads a ticket type's counters, for assertions about inventory. */
export async function readInventory(ticketTypeId: string) {
  const [row] = await db()
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.id, ticketTypeId))
    .limit(1);

  if (!row) throw new Error('Ticket type not found');

  return {
    total: row.quantityTotal,
    sold: row.quantitySold,
    reserved: row.quantityReserved,
    available: row.quantityTotal - row.quantitySold - row.quantityReserved,
  };
}

/** Reads an order, for assertions about its lifecycle. */
export async function readOrder(orderId: string) {
  const [row] = await db().select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!row) throw new Error('Order not found');
  return row;
}

/** A single-attendee line, which most tests want. */
export function oneAttendee(name = 'Ada Lovelace', email = 'ada@example.test') {
  return [{ name, email }];
}

/**
 * Removes everything this process created.
 *
 * Financial records deliberately use `onDelete: restrict` — an order must not be
 * able to vanish because someone deleted an organization. Test teardown therefore
 * has to unwind the dependency graph explicitly, in order, rather than relying on
 * a cascade. Doing it here also documents those relationships.
 */
export async function cleanupFixtures(): Promise<void> {
  for (const organizationId of createdOrganizationIds) {
    await db().transaction(async (tx) => {
      const org = organizationId;

      // Admissions and credentials first.
      await tx.execute(sql`delete from check_in_attempts where event_id in (select id from events where organization_id = ${org})`);
      await tx.execute(sql`delete from tickets where event_id in (select id from events where organization_id = ${org})`);
      await tx.execute(sql`delete from refund_items where refund_id in (select id from refunds where organization_id = ${org})`);
      await tx.execute(sql`delete from refunds where organization_id = ${org}`);
      await tx.execute(sql`delete from payments where organization_id = ${org}`);
      await tx.execute(sql`delete from webhook_events where payload_summary->>'organizationId' = ${org}`);

      // Then the order graph.
      await tx.execute(sql`delete from attendees where order_id in (select id from orders where organization_id = ${org})`);
      await tx.execute(sql`delete from order_items where order_id in (select id from orders where organization_id = ${org})`);
      await tx.execute(sql`delete from orders where organization_id = ${org}`);

      // Operations, then the catalogue, then the organization itself.
      await tx.execute(sql`delete from email_outbox where organization_id = ${org}`);
      await tx.execute(sql`delete from audit_logs where organization_id = ${org}`);
      await tx.execute(sql`delete from event_sessions where event_id in (select id from events where organization_id = ${org})`);
      await tx.execute(sql`delete from event_locations where event_id in (select id from events where organization_id = ${org})`);
      await tx.execute(sql`delete from event_access where event_id in (select id from events where organization_id = ${org})`);
      await tx.execute(sql`delete from ticket_types where event_id in (select id from events where organization_id = ${org})`);
      await tx.execute(sql`delete from events where organization_id = ${org}`);

      await tx.execute(sql`delete from organization_settings where organization_id = ${org}`);
      await tx.execute(sql`delete from invitation where organization_id = ${org}`);
      await tx.execute(sql`delete from member where organization_id = ${org}`);
      await tx.execute(sql`delete from organization where id = ${org}`);
    });
  }

  createdOrganizationIds.length = 0;
}

/** Closes the pool; call once after the final test file. */
export async function closeFixtures(): Promise<void> {
  await closeDatabase();
}

void events;
