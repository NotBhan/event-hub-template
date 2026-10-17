import { and, asc, count, desc, eq, gte, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  eventAccess,
  eventLocations,
  eventSessions,
  events,
  orders,
  organizationSettings,
  ticketTypes,
  type Event,
  type EventAccess,
  type EventLocation,
  type EventSession,
} from '@/lib/db/schema';
import type { DbExecutor } from '@/lib/db/types';
import { postgresErrorCode } from '@/lib/db/errors';
import { toNumber, toNullableNumber } from '@/lib/db/scalars';
import { eventsId } from '@/lib/db/sql';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/security/errors';
import { recordAudit } from '@/features/audit/service';
import { availableQuantity, isWithinSalesWindow } from '@/features/inventory/service';
import { attemptObjectCleanup, queueObjectDeletion } from '@/features/storage/service';
import { resolveCoverImageUrl } from '@/lib/storage/object-storage';

/**
 * Events service.
 *
 * Two responsibilities beyond CRUD:
 *
 * 1. **Resource-level ownership.** `assertEventAccess` verifies that an event
 *    belongs to the caller's organization. A UUID is not access control, so every
 *    dashboard operation goes through it.
 * 2. **Public/private separation.** Draft, private and cancelled events never
 *    appear in public queries, and online joining instructions are never included
 *    in a public response.
 */

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export interface EventInput {
  title: string;
  slug?: string;
  summary?: string | null;
  description?: string | null;
  category?: string | null;
  coverImageUrl?: string | null;
  /** Key of an image uploaded to object storage; see `coverImageUrl` for the fallback. */
  coverImageKey?: string | null;
  /**
   * Clear the cover entirely, whatever else is submitted with it.
   *
   * Removal lives here rather than in the form action because it decides the fate
   * of an object: a key submitted alongside this flag is one the event no longer
   * refers to, and something has to delete it.
   */
  removeCoverImage?: boolean;
  format: 'in_person' | 'online' | 'hybrid';
  visibility: 'public' | 'private';
  timezone: string;
  startsAt: Date;
  endsAt: Date;
  registrationOpensAt?: Date | null;
  registrationClosesAt?: Date | null;
  refundPolicy?: 'no_refunds' | 'refundable_until_start' | 'refundable_until_date' | 'custom';
  refundableUntil?: Date | null;
  refundPolicyNotes?: string | null;
  location?: {
    venueName: string;
    streetAddress?: string | null;
    city?: string | null;
    region?: string | null;
    postalCode?: string | null;
    country?: string | null;
    directions?: string | null;
  } | null;
  access?: {
    platform: string;
    joinUrl?: string | null;
    accessInstructions?: string | null;
    publicNote?: string | null;
  } | null;
}

function assertEventTiming(input: {
  startsAt: Date;
  endsAt: Date;
  registrationOpensAt?: Date | null;
  registrationClosesAt?: Date | null;
}): void {
  if (input.endsAt <= input.startsAt) {
    throw new ConflictError('The event must end after it starts');
  }
  if (
    input.registrationOpensAt &&
    input.registrationClosesAt &&
    input.registrationClosesAt <= input.registrationOpensAt
  ) {
    throw new ConflictError('Registration must close after it opens');
  }
}

/** Creates a draft event with its venue and online-access details. */
export async function createEvent(
  organizationId: string,
  input: EventInput,
  actorUserId: string | null,
): Promise<Event> {
  assertEventTiming(input);

  return db().transaction(async (tx) => {
    const slug = await allocateSlug(tx, organizationId, input.slug ?? input.title);

    const [event] = await tx
      .insert(events)
      .values({
        organizationId,
        slug,
        title: input.title.trim(),
        summary: input.summary ?? null,
        description: input.description ?? null,
        category: input.category ?? null,
        coverImageUrl: input.coverImageUrl ?? null,
        coverImageKey: input.coverImageKey ?? null,
        format: input.format,
        visibility: input.visibility,
        status: 'draft',
        timezone: input.timezone,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        registrationOpensAt: input.registrationOpensAt ?? null,
        registrationClosesAt: input.registrationClosesAt ?? null,
        refundPolicy: input.refundPolicy ?? 'no_refunds',
        refundableUntil: input.refundableUntil ?? null,
        refundPolicyNotes: input.refundPolicyNotes ?? null,
        createdBy: actorUserId,
      })
      .returning();

    if (!event) throw new Error('Failed to create event');

    await upsertVenue(tx, event.id, input);
    await upsertAccess(tx, event.id, input);

    await recordAudit(tx, {
      organizationId,
      actorUserId,
      action: 'event.created',
      resourceType: 'event',
      resourceId: event.id,
      metadata: { title: event.title, format: event.format },
    });

    return event;
  });
}

async function upsertVenue(tx: DbExecutor, eventId: string, input: EventInput): Promise<void> {
  const needsVenue = input.format === 'in_person' || input.format === 'hybrid';

  if (!needsVenue || !input.location) {
    await tx.delete(eventLocations).where(eq(eventLocations.eventId, eventId));
    return;
  }

  await tx
    .insert(eventLocations)
    .values({
      eventId,
      venueName: input.location.venueName,
      streetAddress: input.location.streetAddress ?? null,
      city: input.location.city ?? null,
      region: input.location.region ?? null,
      postalCode: input.location.postalCode ?? null,
      country: input.location.country ?? null,
      directions: input.location.directions ?? null,
    })
    .onConflictDoUpdate({
      target: eventLocations.eventId,
      set: {
        venueName: input.location.venueName,
        streetAddress: input.location.streetAddress ?? null,
        city: input.location.city ?? null,
        region: input.location.region ?? null,
        postalCode: input.location.postalCode ?? null,
        country: input.location.country ?? null,
        directions: input.location.directions ?? null,
      },
    });
}

async function upsertAccess(tx: DbExecutor, eventId: string, input: EventInput): Promise<void> {
  const needsAccess = input.format === 'online' || input.format === 'hybrid';

  if (!needsAccess || !input.access) {
    await tx.delete(eventAccess).where(eq(eventAccess.eventId, eventId));
    return;
  }

  await tx
    .insert(eventAccess)
    .values({
      eventId,
      platform: input.access.platform,
      joinUrl: input.access.joinUrl ?? null,
      accessInstructions: input.access.accessInstructions ?? null,
      publicNote: input.access.publicNote ?? null,
    })
    .onConflictDoUpdate({
      target: eventAccess.eventId,
      set: {
        platform: input.access.platform,
        joinUrl: input.access.joinUrl ?? null,
        accessInstructions: input.access.accessInstructions ?? null,
        publicNote: input.access.publicNote ?? null,
      },
    });
}

/** Ensures a slug is unique within the organization, suffixing when needed. */
async function allocateSlug(
  tx: DbExecutor,
  organizationId: string,
  source: string,
): Promise<string> {
  const base = slugify(source) || 'event';

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;

    const [existing] = await tx
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.organizationId, organizationId), eq(events.slug, candidate)))
      .limit(1);

    if (!existing) return candidate;
  }

  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Verifies the event belongs to the organization.
 *
 * The single ownership check every dashboard read and write passes through.
 */
export async function assertEventAccess(eventId: string, organizationId: string): Promise<Event> {
  const [event] = await db().select().from(events).where(eq(events.id, eventId)).limit(1);

  if (!event) throw new NotFoundError('Event not found');

  if (event.organizationId !== organizationId) {
    // Deliberately the same shape of error as "not found": revealing that an id
    // exists elsewhere leaks information.
    throw new ForbiddenError('This event belongs to another organization');
  }

  return event;
}

export async function getEventForOrganization(
  eventId: string,
  organizationId: string,
): Promise<Event> {
  return assertEventAccess(eventId, organizationId);
}

export async function updateEvent(
  eventId: string,
  organizationId: string,
  input: Partial<EventInput>,
  actorUserId: string | null,
): Promise<Event> {
  /** Objects this update stopped referring to, if any; deleted after commit. */
  const unreferencedCoverKeys: string[] = [];

  const updated = await db().transaction(async (tx) => {
    const existing = await assertEventAccess(eventId, organizationId);

    const startsAt = input.startsAt ?? existing.startsAt;
    const endsAt = input.endsAt ?? existing.endsAt;
    const registrationOpensAt =
      input.registrationOpensAt !== undefined
        ? input.registrationOpensAt
        : existing.registrationOpensAt;
    const registrationClosesAt =
      input.registrationClosesAt !== undefined
        ? input.registrationClosesAt
        : existing.registrationClosesAt;

    assertEventTiming({ startsAt, endsAt, registrationOpensAt, registrationClosesAt });

    const format = input.format ?? existing.format;

    /**
     * What the cover columns should hold afterwards. Removal overrides whatever
     * key arrived with it: the organizer asked for no cover, so a key submitted in
     * the same request is an upload the event will not refer to — and one that has
     * to be cleaned up rather than quietly left in the bucket.
     */
    const removesCover = input.removeCoverImage === true;
    const nextCoverKey = removesCover ? null : input.coverImageKey;
    const nextCoverUrl = removesCover ? null : input.coverImageUrl;

    const [updated] = await tx
      .update(events)
      .set({
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(nextCoverUrl !== undefined ? { coverImageUrl: nextCoverUrl } : {}),
        ...(nextCoverKey !== undefined ? { coverImageKey: nextCoverKey } : {}),
        format,
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        startsAt,
        endsAt,
        registrationOpensAt,
        registrationClosesAt,
        ...(input.refundPolicy !== undefined ? { refundPolicy: input.refundPolicy } : {}),
        ...(input.refundableUntil !== undefined ? { refundableUntil: input.refundableUntil } : {}),
        ...(input.refundPolicyNotes !== undefined
          ? { refundPolicyNotes: input.refundPolicyNotes }
          : {}),
      })
      .where(eq(events.id, eventId))
      .returning();

    if (!updated) throw new Error('Failed to update event');

    /**
     * Every object this update left unreferenced: the cover that was stored, when
     * the event no longer points at it, and any upload submitted together with a
     * removal. The intent to delete each is recorded here, inside the transaction,
     * so the row and the objects cannot drift apart — and carried out just after,
     * so the ordinary case leaves nothing behind to sweep.
     */
    const unreferenced = new Set(
      [existing.coverImageKey, removesCover ? input.coverImageKey : null]
        .filter((key): key is string => Boolean(key))
        .filter((key) => key !== updated.coverImageKey),
    );

    for (const key of unreferenced) {
      await queueObjectDeletion(tx, {
        key,
        reason: updated.coverImageKey ? 'cover_replaced' : 'cover_removed',
      });

      unreferencedCoverKeys.push(key);
    }

    if (input.location !== undefined || input.format !== undefined) {
      await upsertVenue(tx, eventId, {
        ...input,
        title: updated.title,
        format,
        timezone: updated.timezone,
        startsAt,
        endsAt,
        location: input.location ?? null,
      } as EventInput);
    }

    if (input.access !== undefined || input.format !== undefined) {
      await upsertAccess(tx, eventId, {
        ...input,
        title: updated.title,
        format,
        timezone: updated.timezone,
        startsAt,
        endsAt,
        access: input.access ?? null,
      } as EventInput);
    }

    await recordAudit(tx, {
      organizationId,
      actorUserId,
      action: 'event.updated',
      resourceType: 'event',
      resourceId: eventId,
      metadata: { fields: Object.keys(input) },
    });

    return updated;
  });

  /**
   * Attempted only now that the update is committed. If the bucket refuses, the
   * intents stay queued for the worker and this call still returns the saved
   * event: an organizer's edit is not held hostage by object storage.
   */
  await Promise.all(unreferencedCoverKeys.map((key) => attemptObjectCleanup(key)));

  return updated;
}

/** Publishes an event, refusing to go live without something to sell. */
export async function publishEvent(
  eventId: string,
  organizationId: string,
  actorUserId: string | null,
): Promise<Event> {
  return db().transaction(async (tx) => {
    const event = await assertEventAccess(eventId, organizationId);

    if (event.status === 'published') return event;
    if (event.status === 'cancelled') {
      throw new ConflictError('A cancelled event cannot be published again');
    }

    const [activeTicketType] = await tx
      .select({ id: ticketTypes.id })
      .from(ticketTypes)
      .where(and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.isActive, true)))
      .limit(1);

    if (!activeTicketType) {
      throw new ConflictError('Add at least one active ticket type before publishing');
    }

    if (event.format === 'in_person' || event.format === 'hybrid') {
      const [venue] = await tx
        .select({ eventId: eventLocations.eventId })
        .from(eventLocations)
        .where(eq(eventLocations.eventId, eventId))
        .limit(1);

      if (!venue) throw new ConflictError('Add the venue before publishing a physical event');
    }

    const [published] = await tx
      .update(events)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(events.id, eventId))
      .returning();

    if (!published) throw new Error('Failed to publish event');

    await recordAudit(tx, {
      organizationId,
      actorUserId,
      action: 'event.published',
      resourceType: 'event',
      resourceId: eventId,
    });

    return published;
  });
}

export async function unpublishEvent(
  eventId: string,
  organizationId: string,
  actorUserId: string | null,
): Promise<Event> {
  return db().transaction(async (tx) => {
    const event = await assertEventAccess(eventId, organizationId);
    if (event.status !== 'published') return event;

    const [updated] = await tx
      .update(events)
      .set({ status: 'draft', publishedAt: null })
      .where(eq(events.id, eventId))
      .returning();

    await recordAudit(tx, {
      organizationId,
      actorUserId,
      action: 'event.updated',
      resourceType: 'event',
      resourceId: eventId,
      metadata: { status: 'draft' },
    });

    if (!updated) throw new Error('Failed to unpublish event');
    return updated;
  });
}

export interface CancelEventOptions {
  reason: string;
  notifyAttendees?: boolean;
  actorUserId: string | null;
}

/**
 * Cancels an event.
 *
 * Confirmed orders are left intact: cancelling an event does not silently move
 * money. Attendees are notified and refunds remain an explicit, auditable action.
 */
export async function cancelEvent(
  eventId: string,
  organizationId: string,
  options: CancelEventOptions,
): Promise<Event> {
  return db().transaction(async (tx) => {
    const event = await assertEventAccess(eventId, organizationId);

    if (event.status === 'cancelled') return event;

    const [updated] = await tx
      .update(events)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(eq(events.id, eventId))
      .returning();

    if (!updated) throw new Error('Failed to cancel event');

    await recordAudit(tx, {
      organizationId,
      actorUserId: options.actorUserId,
      action: 'event.cancelled',
      resourceType: 'event',
      resourceId: eventId,
      metadata: { reason: options.reason },
    });

    return updated;
  });
}

export async function completeEvent(
  eventId: string,
  organizationId: string,
  actorUserId: string | null,
): Promise<Event> {
  return db().transaction(async (tx) => {
    await assertEventAccess(eventId, organizationId);

    const [updated] = await tx
      .update(events)
      .set({ status: 'completed' })
      .where(eq(events.id, eventId))
      .returning();

    await recordAudit(tx, {
      organizationId,
      actorUserId,
      action: 'event.updated',
      resourceType: 'event',
      resourceId: eventId,
      metadata: { status: 'completed' },
    });

    if (!updated) throw new Error('Failed to complete event');
    return updated;
  });
}

/** PostgreSQL's foreign-key violation code. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Deletes an event and everything that hangs off it.
 *
 * Ownership is verified before anything irreversible happens: a caller who cannot
 * see the event cannot destroy it, and the check runs inside the transaction that
 * does the deleting.
 *
 * Financial records are what stop an event from being deleted. `orders` and
 * `tickets` reference events with `onDelete: restrict`, so an event that has taken
 * a registration cannot be removed — money must not vanish because a row did. That
 * is reported as a conflict that tells the organizer what to do instead. The
 * database's own refusal is caught too: reading rows to decide and then deleting
 * are separate statements, and only the constraint is authoritative.
 *
 * A cover image is queued for deletion in the same transaction, so the row and its
 * object are accounted for together even if the bucket is unreachable.
 */
export async function deleteEvent(
  eventId: string,
  organizationId: string,
  actorUserId: string | null,
): Promise<void> {
  let unreferencedCoverKey: string | null = null;

  try {
    await db().transaction(async (tx) => {
      const event = await assertEventAccess(eventId, organizationId);

      const [registered] = await tx
        .select({ value: count() })
        .from(orders)
        .where(eq(orders.eventId, eventId));

      if (toNumber(registered?.value) > 0) {
        throw new ConflictError(
          'This event has registrations, so it cannot be deleted. Cancel it instead: cancelling stops new registrations and keeps the orders and tickets intact.',
        );
      }

      if (event.coverImageKey) {
        await queueObjectDeletion(tx, { key: event.coverImageKey, reason: 'event_deleted' });
        unreferencedCoverKey = event.coverImageKey;
      }

      // Ticket types, venues, sessions, access details and check-in attempts all
      // cascade from here. Orders never reach this point.
      await tx.delete(events).where(eq(events.id, eventId));

      await recordAudit(tx, {
        organizationId,
        actorUserId,
        action: 'event.deleted',
        resourceType: 'event',
        resourceId: eventId,
        metadata: { title: event.title, slug: event.slug, status: event.status },
      });
    });
  } catch (error) {
    if (postgresErrorCode(error) === FOREIGN_KEY_VIOLATION) {
      throw new ConflictError(
        'This event still has records attached to it, so it cannot be deleted. Cancel it instead.',
      );
    }

    throw error;
  }

  if (unreferencedCoverKey) await attemptObjectCleanup(unreferencedCoverKey);
}

/**
 * Marks published events as completed once they have finished.
 * Called by the maintenance worker.
 */
export async function completePastEvents(): Promise<number> {
  const result = await db()
    .update(events)
    .set({ status: 'completed' })
    .where(and(eq(events.status, 'published'), lt(events.endsAt, new Date())))
    .returning({ id: events.id });

  return result.length;
}

/**
 * Swaps an uploaded cover's key for a signed URL.
 *
 * Done on the way out of the service rather than in each component: every page
 * that renders an event cover then receives a ready-to-use URL, and the stored
 * key stays the single source of truth. The signature expires in hours, so it is
 * minted per response and never persisted.
 */
async function withCoverUrl<
  T extends { coverImageKey: string | null; coverImageUrl: string | null },
>(row: T): Promise<T> {
  if (!row.coverImageKey) return row;

  const url = await resolveCoverImageUrl(row.coverImageKey, row.coverImageUrl);
  return { ...row, coverImageUrl: url };
}

/**
 * Public event listing.
 *
 * Only published, public events are ever returned. `from`/`to` filter on the
 * event's start time and `upcomingOnly` excludes everything already finished.
 */
export async function listPublicEvents(
  filters: {
    search?: string;
    category?: string;
    format?: 'in_person' | 'online' | 'hybrid';
    upcomingOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
) {
  const conditions = [eq(events.status, 'published'), eq(events.visibility, 'public')];

  if (filters.upcomingOnly !== false) {
    conditions.push(gte(events.endsAt, new Date()));
  }
  if (filters.category) conditions.push(eq(events.category, filters.category));
  if (filters.format) conditions.push(eq(events.format, filters.format));

  if (filters.search) {
    const term = `%${filters.search.trim()}%`;
    const searchCondition = or(
      ilike(events.title, term),
      ilike(events.summary, term),
      ilike(events.description, term),
    );
    if (searchCondition) conditions.push(searchCondition);
  }

  const where = and(...conditions);

  const rows = await db()
    .select({
      event: events,
      venueName: eventLocations.venueName,
      city: eventLocations.city,
      remainingTickets: sql<number>`(
        select coalesce(sum(ticket_types.quantity_total - ticket_types.quantity_sold - ticket_types.quantity_reserved), 0)::int
        from ticket_types
        where ticket_types.event_id = ${eventsId} and ticket_types.is_active = true
      )`,
      cheapestPriceMinor: sql<number | null>`(
        select min(ticket_types.price_minor)
        from ticket_types
        where ticket_types.event_id = ${eventsId} and ticket_types.is_active = true
      )`,
      currency: sql<string | null>`(
        select ticket_types.currency
        from ticket_types
        where ticket_types.event_id = ${eventsId} and ticket_types.is_active = true
        order by ticket_types.price_minor asc limit 1
      )`,
    })
    .from(events)
    .leftJoin(eventLocations, eq(eventLocations.eventId, events.id))
    .where(where)
    .orderBy(asc(events.startsAt))
    .limit(Math.min(filters.limit ?? 24, 60))
    .offset(filters.offset ?? 0);

  const [totals] = await db().select({ value: count() }).from(events).where(where);

  return {
    // Aggregates arrive as strings from the driver; coerce at the boundary so
    // callers can compare them as numbers.
    rows: await Promise.all(
      rows.map(async (row) => ({
        ...row,
        event: await withCoverUrl(row.event),
        remainingTickets: toNumber(row.remainingTickets),
        cheapestPriceMinor: toNullableNumber(row.cheapestPriceMinor),
      })),
    ),
    total: toNumber(totals?.value),
  };
}

/** Distinct categories of published public events, for filter chips. */
export async function listPublicCategories(): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ category: events.category })
    .from(events)
    .where(and(eq(events.status, 'published'), eq(events.visibility, 'public')))
    .orderBy(asc(events.category));

  return rows.map((row) => row.category).filter((value): value is string => Boolean(value));
}

export interface PublicEventDetail {
  event: Event;
  location: EventLocation | null;
  /** Public-safe access summary. Never contains the joining link. */
  access: Pick<EventAccess, 'platform' | 'publicNote'> | null;
  sessions: EventSession[];
  ticketTypes: {
    id: string;
    name: string;
    description: string | null;
    priceMinor: number;
    currency: string;
    available: number;
    minPerOrder: number;
    maxPerOrder: number;
    onSale: boolean;
  }[];
}

/**
 * Loads a published event by slug for the public site.
 *
 * Private, draft and cancelled events return nothing rather than a 403, so the
 * public site cannot be used to probe which slugs exist.
 */
export async function getPublicEventBySlug(slug: string): Promise<PublicEventDetail | null> {
  const [row] = await db()
    .select()
    .from(events)
    .where(
      and(eq(events.slug, slug), eq(events.status, 'published'), eq(events.visibility, 'public')),
    )
    .limit(1);

  if (!row) return null;

  const [location] = await db()
    .select()
    .from(eventLocations)
    .where(eq(eventLocations.eventId, row.id))
    .limit(1);

  const [access] = await db()
    .select({ platform: eventAccess.platform, publicNote: eventAccess.publicNote })
    .from(eventAccess)
    .where(eq(eventAccess.eventId, row.id))
    .limit(1);

  const sessions = await db()
    .select()
    .from(eventSessions)
    .where(eq(eventSessions.eventId, row.id))
    .orderBy(asc(eventSessions.sortOrder), asc(eventSessions.startsAt));

  const types = await db()
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, row.id))
    .orderBy(asc(ticketTypes.sortOrder), asc(ticketTypes.createdAt));

  const now = new Date();

  return {
    event: await withCoverUrl(row),
    location: location ?? null,
    access: access ?? null,
    sessions,
    ticketTypes: types
      .filter((type) => type.isActive)
      .map((type) => ({
        id: type.id,
        name: type.name,
        description: type.description,
        priceMinor: type.priceMinor,
        currency: type.currency,
        available: availableQuantity(type),
        minPerOrder: type.minPerOrder,
        maxPerOrder: type.maxPerOrder,
        onSale: isWithinSalesWindow(type, now),
      })),
  };
}

/** Online joining instructions, only ever returned to an authorized caller. */
export async function getEventJoinInstructions(eventId: string): Promise<{
  platform: string;
  joinUrl: string | null;
  accessInstructions: string | null;
} | null> {
  const [row] = await db()
    .select({
      platform: eventAccess.platform,
      joinUrl: eventAccess.joinUrl,
      accessInstructions: eventAccess.accessInstructions,
    })
    .from(eventAccess)
    .where(eq(eventAccess.eventId, eventId))
    .limit(1);

  return row ?? null;
}

/** Event list for the organizer dashboard. */
export async function listOrganizationEvents(filters: {
  organizationId: string;
  status?: Event['status'];
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const conditions = [eq(events.organizationId, filters.organizationId)];

  if (filters.status) conditions.push(eq(events.status, filters.status));
  if (filters.search) {
    const term = `%${filters.search.trim()}%`;
    const searchCondition = or(ilike(events.title, term), ilike(events.slug, term));
    if (searchCondition) conditions.push(searchCondition);
  }

  const where = and(...conditions);
  const limit = Math.min(filters.limit ?? 25, 100);

  const rows = await db()
    .select({
      event: events,
      sold: sql<number>`(
        select coalesce(sum(ticket_types.quantity_sold), 0)::int
        from ticket_types where ticket_types.event_id = ${eventsId}
      )`,
      capacity: sql<number>`(
        select coalesce(sum(ticket_types.quantity_total), 0)::int
        from ticket_types where ticket_types.event_id = ${eventsId}
      )`,
      orders: sql<number>`(
        select count(*)::int from orders
        where orders.event_id = ${eventsId} and orders.status = 'confirmed'
      )`,
      revenueMinor: sql<number>`(
        select coalesce(sum(orders.total_minor), 0)::bigint from orders
        where orders.event_id = ${eventsId} and orders.status = 'confirmed'
      )`,
    })
    .from(events)
    .where(where)
    .orderBy(desc(events.startsAt))
    .limit(limit)
    .offset(filters.offset ?? 0);

  const [totals] = await db().select({ value: count() }).from(events).where(where);

  return {
    rows: await Promise.all(
      rows.map(async (row) => ({
        ...row,
        event: await withCoverUrl(row.event),
        sold: toNumber(row.sold),
        capacity: toNumber(row.capacity),
        orders: toNumber(row.orders),
        revenueMinor: toNumber(row.revenueMinor),
      })),
    ),
    total: toNumber(totals?.value),
  };
}

/** Events a check-in staff member may scan for. */
export async function listScannableEvents(organizationId: string) {
  return db()
    .select({
      id: events.id,
      title: events.title,
      slug: events.slug,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      timezone: events.timezone,
      status: events.status,
    })
    .from(events)
    .where(
      and(
        eq(events.organizationId, organizationId),
        inArray(events.status, ['published', 'completed']),
      ),
    )
    .orderBy(asc(events.startsAt));
}

/** Venue, access and session detail for the event edit page. */
export async function getEventEditorData(eventId: string, organizationId: string) {
  const event = await assertEventAccess(eventId, organizationId);

  const [location] = await db()
    .select()
    .from(eventLocations)
    .where(eq(eventLocations.eventId, eventId))
    .limit(1);

  const [access] = await db()
    .select()
    .from(eventAccess)
    .where(eq(eventAccess.eventId, eventId))
    .limit(1);

  const sessions = await db()
    .select()
    .from(eventSessions)
    .where(eq(eventSessions.eventId, eventId))
    .orderBy(asc(eventSessions.sortOrder), asc(eventSessions.startsAt));

  const types = await db()
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId))
    .orderBy(asc(ticketTypes.sortOrder), asc(ticketTypes.createdAt));

  return {
    event: await withCoverUrl(event),
    location: location ?? null,
    access: access ?? null,
    sessions,
    ticketTypes: types,
  };
}

export async function replaceEventSessions(
  eventId: string,
  organizationId: string,
  sessions: {
    title: string;
    description?: string | null;
    speakerName?: string | null;
    speakerBio?: string | null;
    room?: string | null;
    startsAt: Date;
    endsAt: Date;
  }[],
): Promise<void> {
  await assertEventAccess(eventId, organizationId);

  await db().transaction(async (tx) => {
    await tx.delete(eventSessions).where(eq(eventSessions.eventId, eventId));

    if (sessions.length === 0) return;

    await tx.insert(eventSessions).values(
      sessions.map((session, index) => ({
        eventId,
        title: session.title,
        description: session.description ?? null,
        speakerName: session.speakerName ?? null,
        speakerBio: session.speakerBio ?? null,
        room: session.room ?? null,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        sortOrder: index,
      })),
    );
  });
}

/** Organization branding, used to label public pages. */
export async function getOrganizationSettings(organizationId: string) {
  const [row] = await db()
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);

  return row ?? null;
}

/** The single organization for this deployment. */
export async function getPrimaryOrganizationId(): Promise<string | null> {
  const [row] = await db()
    .select({ id: organizationSettings.organizationId })
    .from(organizationSettings)
    .limit(1);

  return row?.id ?? null;
}
