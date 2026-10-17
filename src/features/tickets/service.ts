import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  attendees,
  events,
  orderItems,
  orders,
  ticketTypes,
  tickets,
  type Ticket,
} from '@/lib/db/schema';
import type { DbExecutor } from '@/lib/db/types';
import { toNumber } from '@/lib/db/scalars';
import { serverEnv } from '@/lib/security/env';
import { ConflictError, NotFoundError } from '@/lib/security/errors';
import {
  deriveTicketToken,
  generateTicketReference,
  hashQrToken,
  parseTicketToken,
} from '@/lib/security/tokens';
import { recordAudit } from '@/features/audit/service';

/**
 * Ticket module.
 *
 * One ticket per attendee admission, even when a single order contains five
 * tickets. That is what makes ticket-specific check-in, voiding and refunds
 * possible.
 *
 * The QR credential is derived from `TICKET_TOKEN_SECRET` and the ticket id, then
 * only its hash is stored — see `@/lib/security/tokens` for why.
 */

export interface IssuedTicket {
  ticket: Ticket;
  /** The credential to encode in the QR code. Never persisted. */
  token: string;
}

/**
 * Issues tickets for every attendee on a confirmed order.
 *
 * Idempotent by construction: it only inserts rows for attendees that do not
 * already have a ticket, so a duplicate webhook or a retried confirmation cannot
 * issue a second ticket for the same admission.
 *
 * Must run inside the same transaction that confirms the order, so either
 * everything commits or nothing does.
 */
export async function issueTicketsForOrder(
  tx: DbExecutor,
  orderId: string,
): Promise<IssuedTicket[]> {
  const secret = serverEnv().TICKET_TOKEN_SECRET;

  const rows = await tx
    .select({
      attendeeId: attendees.id,
      orderItemId: attendees.orderItemId,
      orderId: orders.id,
      eventId: orders.eventId,
      existingTicketId: tickets.id,
    })
    .from(attendees)
    .innerJoin(orders, eq(orders.id, attendees.orderId))
    .leftJoin(tickets, eq(tickets.attendeeId, attendees.id))
    .where(and(eq(attendees.orderId, orderId), isNull(tickets.id)));

  if (rows.length === 0) return [];

  const issued: IssuedTicket[] = [];

  for (const row of rows) {
    // The id is generated here rather than by the database so the QR credential
    // can be derived before the insert.
    const ticketId = randomUUID();
    const token = deriveTicketToken(ticketId, secret);

    const [ticket] = await tx
      .insert(tickets)
      .values({
        id: ticketId,
        eventId: row.eventId,
        orderId: row.orderId,
        orderItemId: row.orderItemId,
        attendeeId: row.attendeeId,
        publicReference: generateTicketReference(),
        qrTokenHash: hashQrToken(token),
      })
      .returning();

    if (!ticket) throw new Error('Failed to issue ticket');
    issued.push({ ticket, token });
  }

  if (issued.length > 0) {
    await recordAudit(tx, {
      action: 'ticket.issued',
      resourceType: 'order',
      resourceId: orderId,
      metadata: { count: issued.length },
    });
  }

  return issued;
}

/** Re-derives the QR credential for an existing ticket, for re-display. */
export function tokenForTicket(ticketId: string): string {
  return deriveTicketToken(ticketId, serverEnv().TICKET_TOKEN_SECRET);
}

/** Every ticket on an order, with the attendee and ticket-type detail to display. */
export async function listTicketsForOrder(orderId: string) {
  return db()
    .select({
      ticket: tickets,
      attendeeName: attendees.name,
      attendeeEmail: attendees.email,
      ticketTypeName: orderItems.ticketNameSnapshot,
    })
    .from(tickets)
    .innerJoin(attendees, eq(attendees.id, tickets.attendeeId))
    .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .where(eq(tickets.orderId, orderId))
    .orderBy(tickets.issuedAt);
}

export interface TicketLookup {
  ticket: Ticket;
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  eventStartsAt: Date;
  eventEndsAt: Date;
  eventTimezone: string;
  attendeeName: string;
  attendeeEmail: string;
  ticketTypeName: string;
  orderId: string;
}

/**
 * Resolves a scanned credential to a ticket.
 *
 * The presented token is hashed and compared against the stored hash. That single
 * comparison validates the whole credential: the ticket id *and* the signature
 * derived from `TICKET_TOKEN_SECRET`.
 *
 * This is the reason the signature must never be taken for granted. Re-deriving
 * the expected token from the id alone would accept `t1.<real-id>.anything`,
 * turning a leaked ticket id into a printable ticket. Hashing what was actually
 * presented is what makes the secret load-bearing.
 */
export async function findTicketByToken(token: string): Promise<TicketLookup | null> {
  const parsed = parseTicketToken(token);
  if (!parsed) return null;

  const presentedHash = hashQrToken(token);

  const [row] = await db()
    .select({
      ticket: tickets,
      eventTitle: events.title,
      eventSlug: events.slug,
      eventStartsAt: events.startsAt,
      eventEndsAt: events.endsAt,
      eventTimezone: events.timezone,
      attendeeName: attendees.name,
      attendeeEmail: attendees.email,
      ticketTypeName: orderItems.ticketNameSnapshot,
    })
    .from(tickets)
    .innerJoin(events, eq(events.id, tickets.eventId))
    .innerJoin(attendees, eq(attendees.id, tickets.attendeeId))
    .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .where(and(eq(tickets.id, parsed.ticketId), eq(tickets.qrTokenHash, presentedHash)))
    .limit(1);

  if (!row) return null;

  return {
    ticket: row.ticket,
    eventId: row.ticket.eventId,
    eventTitle: row.eventTitle,
    eventSlug: row.eventSlug,
    eventStartsAt: row.eventStartsAt,
    eventEndsAt: row.eventEndsAt,
    eventTimezone: row.eventTimezone,
    attendeeName: row.attendeeName,
    attendeeEmail: row.attendeeEmail,
    ticketTypeName: row.ticketTypeName,
    orderId: row.ticket.orderId,
  };
}

export interface VoidTicketInput {
  ticketId: string;
  reason: string;
  actorUserId?: string | null;
  organizationId?: string | null;
}

/**
 * Voids a ticket so it can no longer be admitted.
 *
 * Refuses to silently void a ticket that has already been admitted: an attendee
 * who is physically inside must be handled as an explicit decision, not as a
 * side effect of a refund.
 */
export async function voidTicket(tx: DbExecutor, input: VoidTicketInput): Promise<Ticket> {
  const [existing] = await tx
    .select()
    .from(tickets)
    .where(eq(tickets.id, input.ticketId))
    .limit(1)
    .for('update');

  if (!existing) throw new NotFoundError('Ticket not found');

  if (existing.status === 'void') return existing;

  const [accepted] = await tx.execute<{ id: string }>(
    sql`select id from check_in_attempts where ticket_id = ${input.ticketId} and outcome = 'accepted' limit 1`,
  );

  if (accepted) {
    throw new ConflictError(
      'This ticket has already been admitted and cannot be voided. Reverse the admission first.',
    );
  }

  const [updated] = await tx
    .update(tickets)
    .set({ status: 'void', voidedAt: new Date(), voidReason: input.reason })
    .where(eq(tickets.id, input.ticketId))
    .returning();

  if (!updated) throw new Error('Failed to void ticket');

  await recordAudit(tx, {
    organizationId: input.organizationId ?? null,
    actorUserId: input.actorUserId ?? null,
    action: 'ticket.voided',
    resourceType: 'ticket',
    resourceId: input.ticketId,
    metadata: { reason: input.reason, publicReference: existing.publicReference },
  });

  return updated;
}

/** Voids every ticket covered by a confirmed refund. */
export async function voidTicketsForRefund(
  tx: DbExecutor,
  input: { ticketIds: string[]; reason: string; actorUserId?: string | null; organizationId?: string | null },
): Promise<{ voided: number; skipped: number }> {
  let voided = 0;
  let skipped = 0;

  for (const ticketId of input.ticketIds) {
    try {
      await voidTicket(tx, {
        ticketId,
        reason: input.reason,
        actorUserId: input.actorUserId,
        organizationId: input.organizationId,
      });
      voided += 1;
    } catch (error) {
      // An already-admitted ticket cannot be voided; count it and continue so one
      // problematic admission does not block the rest of the refund.
      if (error instanceof ConflictError) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }

  return { voided, skipped };
}

export interface TicketDetail extends TicketLookup {
  ticketStatus: Ticket['status'];
  checkedInAt: Date | null;
}

/** Ticket plus its current admission state, for the attendee's ticket page. */
export async function getTicketDetail(ticketId: string): Promise<TicketDetail | null> {
  const [row] = await db()
    .select({
      ticket: tickets,
      eventTitle: events.title,
      eventSlug: events.slug,
      eventStartsAt: events.startsAt,
      eventEndsAt: events.endsAt,
      eventTimezone: events.timezone,
      attendeeName: attendees.name,
      attendeeEmail: attendees.email,
      ticketTypeName: orderItems.ticketNameSnapshot,
    })
    .from(tickets)
    .innerJoin(events, eq(events.id, tickets.eventId))
    .innerJoin(attendees, eq(attendees.id, tickets.attendeeId))
    .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .where(eq(tickets.id, ticketId))
    .limit(1);

  if (!row) return null;

  const [admission] = await db().execute<{ scanned_at: Date }>(
    sql`select scanned_at from check_in_attempts where ticket_id = ${ticketId} and outcome = 'accepted' limit 1`,
  );

  return {
    ticket: row.ticket,
    eventId: row.ticket.eventId,
    eventTitle: row.eventTitle,
    eventSlug: row.eventSlug,
    eventStartsAt: row.eventStartsAt,
    eventEndsAt: row.eventEndsAt,
    eventTimezone: row.eventTimezone,
    attendeeName: row.attendeeName,
    attendeeEmail: row.attendeeEmail,
    ticketTypeName: row.ticketTypeName,
    orderId: row.ticket.orderId,
    ticketStatus: row.ticket.status,
    checkedInAt: admission?.scanned_at ?? null,
  };
}

/** Ticket counts per ticket type, for the event overview. */
export async function getTicketCountsByType(eventId: string) {
  const rows = await db()
    .select({
      ticketTypeId: ticketTypes.id,
      name: ticketTypes.name,
      quantityTotal: ticketTypes.quantityTotal,
      quantitySold: ticketTypes.quantitySold,
      quantityReserved: ticketTypes.quantityReserved,
      issued: sql<number>`count(${tickets.id})::int`,
      voided: sql<number>`count(case when ${tickets.status} = 'void' then 1 end)::int`,
    })
    .from(ticketTypes)
    .leftJoin(orderItems, eq(orderItems.ticketTypeId, ticketTypes.id))
    .leftJoin(tickets, eq(tickets.orderItemId, orderItems.id))
    .where(eq(ticketTypes.eventId, eventId))
    .groupBy(
      ticketTypes.id,
      ticketTypes.name,
      ticketTypes.quantityTotal,
      ticketTypes.quantitySold,
      ticketTypes.quantityReserved,
    )
    .orderBy(ticketTypes.sortOrder);

  // Aggregates cross the driver boundary as strings.
  return rows.map((row) => ({
    ...row,
    issued: toNumber(row.issued),
    voided: toNumber(row.voided),
  }));
}

/** Tickets belonging to a signed-in user, across all their orders. */
export async function listTicketsForUser(userId: string) {
  return db()
    .select({
      ticket: tickets,
      eventTitle: events.title,
      eventSlug: events.slug,
      eventStartsAt: events.startsAt,
      eventTimezone: events.timezone,
      attendeeName: attendees.name,
      ticketTypeName: orderItems.ticketNameSnapshot,
    })
    .from(tickets)
    .innerJoin(orders, eq(orders.id, tickets.orderId))
    .innerJoin(events, eq(events.id, tickets.eventId))
    .innerJoin(attendees, eq(attendees.id, tickets.attendeeId))
    .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .where(eq(orders.userId, userId))
    .orderBy(events.startsAt);
}

/** Tickets for a set of attendees, used while reconciling refunds. */
export async function listTicketsForAttendees(
  executor: DbExecutor,
  attendeeIds: string[],
): Promise<Ticket[]> {
  if (attendeeIds.length === 0) return [];
  return executor.select().from(tickets).where(inArray(tickets.attendeeId, attendeeIds));
}
