import { and, count, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  checkInAttempts,
  events,
  attendees,
  orderItems,
  tickets,
  user,
} from '@/lib/db/schema';
import { recordAudit } from '@/features/audit/service';
import { toNumber } from '@/lib/db/scalars';
import { errorChainMessage, isUniqueViolation } from '@/lib/db/errors';
import { findTicketByToken } from '@/features/tickets/service';

/**
 * Check-in service.
 *
 * ## Atomicity
 *
 * Admission is recorded as an attempt row, and the database carries a partial
 * unique index:
 *
 *     unique (ticket_id) where outcome = 'accepted'
 *
 * So if two scanners submit the same ticket at the same instant, one insert wins
 * and the other fails with a unique violation. The loser is then recorded as
 * `already_checked_in`. No application-level locking or "check then insert" race
 * exists to get wrong.
 *
 * Every attempt is stored, not just successes, so rejected scans stay auditable.
 */

export type CheckInOutcome =
  | 'accepted'
  | 'already_checked_in'
  | 'wrong_event'
  | 'invalid_token'
  | 'void_ticket'
  | 'unauthorized';

export interface ScanInput {
  /** The event the scanner is authorized for. */
  eventId: string;
  /** Raw credential from the QR code. */
  token: string;
  scannerUserId: string | null;
  deviceReference?: string | null;
}

export interface ScanResult {
  outcome: CheckInOutcome;
  accepted: boolean;
  message: string;
  /** Shown to door staff; deliberately minimal. */
  attendee?: {
    name: string;
    ticketTypeName: string;
    ticketReference: string;
    eventTitle: string;
  };
  /** True when this scan was the one that admitted the attendee. */
  firstAdmission: boolean;
}

const OUTCOME_MESSAGES: Record<CheckInOutcome, string> = {
  accepted: 'Admitted',
  already_checked_in: 'Already checked in',
  wrong_event: 'Ticket is for a different event',
  invalid_token: 'Not a valid ticket',
  void_ticket: 'This ticket has been voided',
  unauthorized: 'You are not authorized to scan for this event',
};

/** Processes a scan and records the outcome. */
export async function scanTicket(input: ScanInput): Promise<ScanResult> {
  const lookup = await findTicketByToken(input.token);

  if (!lookup) {
    await recordAttempt({
      ticketId: null,
      eventId: input.eventId,
      scannerUserId: input.scannerUserId,
      outcome: 'invalid_token',
      accepted: false,
      deviceReference: input.deviceReference,
    });

    return { outcome: 'invalid_token', accepted: false, message: OUTCOME_MESSAGES.invalid_token, firstAdmission: false };
  }

  const summary = {
    name: lookup.attendeeName,
    ticketTypeName: lookup.ticketTypeName,
    ticketReference: lookup.ticket.publicReference,
    eventTitle: lookup.eventTitle,
  };

  // A ticket for another event is rejected before anything is written against
  // this event's admission counts.
  if (lookup.eventId !== input.eventId) {
    await recordAttempt({
      ticketId: lookup.ticket.id,
      eventId: input.eventId,
      scannerUserId: input.scannerUserId,
      outcome: 'wrong_event',
      accepted: false,
      deviceReference: input.deviceReference,
    });

    return {
      outcome: 'wrong_event',
      accepted: false,
      message: OUTCOME_MESSAGES.wrong_event,
      attendee: summary,
      firstAdmission: false,
    };
  }

  if (lookup.ticket.status === 'void') {
    await recordAttempt({
      ticketId: lookup.ticket.id,
      eventId: input.eventId,
      scannerUserId: input.scannerUserId,
      outcome: 'void_ticket',
      accepted: false,
      deviceReference: input.deviceReference,
    });

    return {
      outcome: 'void_ticket',
      accepted: false,
      message: OUTCOME_MESSAGES.void_ticket,
      attendee: summary,
      firstAdmission: false,
    };
  }

  /**
   * The admission itself. The partial unique index decides the winner, so this
   * block does not need — and must not rely on — a prior "has this been scanned?"
   * read.
   */
  try {
    await db().insert(checkInAttempts).values({
      ticketId: lookup.ticket.id,
      eventId: input.eventId,
      scannerUserId: input.scannerUserId,
      outcome: 'accepted',
      accepted: true,
      deviceReference: input.deviceReference ?? null,
    });

    await recordAudit(db(), {
      action: 'check_in.accepted',
      resourceType: 'ticket',
      resourceId: lookup.ticket.id,
      metadata: { eventId: input.eventId, scannedBy: input.scannerUserId },
    });

    return {
      outcome: 'accepted',
      accepted: true,
      message: OUTCOME_MESSAGES.accepted,
      attendee: summary,
      firstAdmission: true,
    };
  } catch (error) {
    if (!isUniqueViolation(error, 'check_in_attempts_one_accepted_per_ticket')) throw error;

    // Someone else admitted this ticket a moment ago.
    await recordAttempt({
      ticketId: lookup.ticket.id,
      eventId: input.eventId,
      scannerUserId: input.scannerUserId,
      outcome: 'already_checked_in',
      accepted: false,
      deviceReference: input.deviceReference,
    });

    return {
      outcome: 'already_checked_in',
      accepted: false,
      message: OUTCOME_MESSAGES.already_checked_in,
      attendee: summary,
      firstAdmission: false,
    };
  }
}

async function recordAttempt(input: {
  ticketId: string | null;
  eventId: string;
  scannerUserId: string | null;
  outcome: CheckInOutcome;
  accepted: boolean;
  deviceReference?: string | null;
}): Promise<void> {
  try {
    await db().insert(checkInAttempts).values({
      ticketId: input.ticketId,
      eventId: input.eventId,
      scannerUserId: input.scannerUserId,
      outcome: input.outcome,
      accepted: input.accepted,
      deviceReference: input.deviceReference ?? null,
    });

    await recordAudit(db(), {
      action: 'check_in.rejected',
      resourceType: 'ticket',
      resourceId: input.ticketId,
      metadata: { eventId: input.eventId, outcome: input.outcome },
    });
  } catch (error) {
    // Recording a rejection must never break the scanner response.
    console.error('Failed to record check-in attempt', {
      outcome: input.outcome,
      reason: errorChainMessage(error),
    });
  }
}

/** Records a scan by someone without permission for this event. */
export async function recordUnauthorizedScan(input: {
  eventId: string;
  scannerUserId: string | null;
  deviceReference?: string | null;
}): Promise<void> {
  await recordAttempt({
    ticketId: null,
    eventId: input.eventId,
    scannerUserId: input.scannerUserId,
    outcome: 'unauthorized',
    accepted: false,
    deviceReference: input.deviceReference,
  });
}

/** Admission counters for the live dashboard. */
export async function getCheckInStats(eventId: string): Promise<{
  issued: number;
  admitted: number;
  duplicates: number;
  rejected: number;
}> {
  const [issued] = await db()
    .select({ value: count() })
    .from(tickets)
    .where(and(eq(tickets.eventId, eventId), eq(tickets.status, 'issued')));

  const [admitted] = await db()
    .select({ value: count() })
    .from(checkInAttempts)
    .where(and(eq(checkInAttempts.eventId, eventId), eq(checkInAttempts.outcome, 'accepted')));

  const [duplicates] = await db()
    .select({ value: count() })
    .from(checkInAttempts)
    .where(and(eq(checkInAttempts.eventId, eventId), eq(checkInAttempts.outcome, 'already_checked_in')));

  const [rejected] = await db()
    .select({ value: count() })
    .from(checkInAttempts)
    .where(
      and(
        eq(checkInAttempts.eventId, eventId),
        sql`${checkInAttempts.outcome} in ('invalid_token','void_ticket','wrong_event','unauthorized')`,
      ),
    );

  return {
    issued: toNumber(issued?.value),
    admitted: toNumber(admitted?.value),
    duplicates: toNumber(duplicates?.value),
    rejected: toNumber(rejected?.value),
  };
}

/** Attempt history for an event, newest first. */
export async function listCheckInAttempts(filters: {
  eventId: string;
  outcome?: CheckInOutcome;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}) {
  const conditions = [eq(checkInAttempts.eventId, filters.eventId)];
  if (filters.outcome) conditions.push(eq(checkInAttempts.outcome, filters.outcome));
  if (filters.from) conditions.push(gte(checkInAttempts.scannedAt, filters.from));
  if (filters.to) conditions.push(lte(checkInAttempts.scannedAt, filters.to));

  return db()
    .select({
      id: checkInAttempts.id,
      outcome: checkInAttempts.outcome,
      accepted: checkInAttempts.accepted,
      scannedAt: checkInAttempts.scannedAt,
      deviceReference: checkInAttempts.deviceReference,
      scannerName: user.name,
      scannerId: user.id,
      ticketReference: tickets.publicReference,
      attendeeName: attendees.name,
      ticketTypeName: orderItems.ticketNameSnapshot,
    })
    .from(checkInAttempts)
    .leftJoin(tickets, eq(tickets.id, checkInAttempts.ticketId))
    .leftJoin(attendees, eq(attendees.id, tickets.attendeeId))
    .leftJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .leftJoin(user, eq(user.id, checkInAttempts.scannerUserId))
    .where(and(...conditions))
    .orderBy(desc(checkInAttempts.scannedAt))
    .limit(Math.min(filters.limit ?? 50, 200))
    .offset(filters.offset ?? 0);
}

/**
 * Reverses an admission so a genuine mistake at the door can be corrected.
 *
 * Only the accepted row for that ticket is removed, and the reversal is recorded
 * so it cannot be used to quietly let someone in twice.
 */
export async function reverseAdmission(input: {
  ticketId: string;
  actorUserId: string | null;
  organizationId?: string | null;
  reason: string;
}): Promise<boolean> {
  const deleted = await db()
    .delete(checkInAttempts)
    .where(and(eq(checkInAttempts.ticketId, input.ticketId), eq(checkInAttempts.outcome, 'accepted')))
    .returning({ id: checkInAttempts.id });

  if (deleted.length === 0) return false;

  await recordAudit(db(), {
    organizationId: input.organizationId ?? null,
    actorUserId: input.actorUserId,
    action: 'check_in.overridden',
    resourceType: 'ticket',
    resourceId: input.ticketId,
    metadata: { reason: input.reason },
  });

  return true;
}

/** Whether a ticket has been admitted, for the attendee's ticket page. */
export async function getAdmissionTime(ticketId: string): Promise<Date | null> {
  const [row] = await db()
    .select({ scannedAt: checkInAttempts.scannedAt })
    .from(checkInAttempts)
    .where(and(eq(checkInAttempts.ticketId, ticketId), eq(checkInAttempts.outcome, 'accepted')))
    .limit(1);

  return row?.scannedAt ?? null;
}

/** Look up the event's timezone, used to bound scanner availability. */
export async function getEventScanWindow(eventId: string): Promise<{
  title: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
} | null> {
  const [event] = await db()
    .select({
      title: events.title,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      timezone: events.timezone,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  return event ?? null;
}
