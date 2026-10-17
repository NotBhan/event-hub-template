import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrder, confirmOrder } from '@/features/orders/service';
import { listTicketsForOrder, tokenForTicket } from '@/features/tickets/service';
import { getCheckInStats, scanTicket } from '@/features/check-in/service';
import { hashQrToken } from '@/lib/security/tokens';
import { db } from '@/lib/db/client';
import { checkInAttempts, tickets } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import {
  cleanupFixtures,
  createTestEvent,
  createTestOrganization,
  type TestEvent,
  type TestOrganization,
} from '../setup/fixtures';

/**
 * Admission.
 *
 * The guarantee is that a ticket admits exactly one person once — including when
 * two scanners read the same code at the same instant. Every outcome is recorded,
 * including rejections, so a dispute at the door can be reconstructed.
 */
describe('check-in', () => {
  let org: TestOrganization;
  let event: TestEvent;
  let otherEvent: TestEvent;

  beforeEach(async () => {
    org = await createTestOrganization('checkin_staff');

    event = await createTestEvent(org.organizationId, null, {
      ticketTypes: [{ name: 'General', priceMinor: 0, quantityTotal: 50 }],
    });

    otherEvent = await createTestEvent(org.organizationId, null, {
      ticketTypes: [{ name: 'General', priceMinor: 0, quantityTotal: 50 }],
    });
  });

  afterAll(async () => {
    await cleanupFixtures();
  });

  /** Issues paid-for tickets on an event with zero-price ticket types. */
  async function issueTickets(target: TestEvent, count = 1) {
    const ticketType = target.ticketTypes[0]!;

    const created = await createOrder({
      eventId: target.eventId,
      lines: [
        {
          ticketTypeId: ticketType.id,
          attendees: Array.from({ length: count }, (_, index) => ({
            name: `Attendee ${index}`,
            email: `attendee${index}-${target.eventId.slice(0, 6)}@example.test`,
          })),
        },
      ],
      buyer: { name: 'Buyer', email: `buyer-${target.eventId.slice(0, 6)}@example.test` },
    });

    // Zero-price orders confirm immediately.
    if (created.order.status !== 'confirmed') {
      await confirmOrder({ orderId: created.order.id });
    }

    return listTicketsForOrder(created.order.id);
  }

  it('admits a valid ticket', async () => {
    const [issued] = await issueTickets(event, 1);

    const result = await scanTicket({
      eventId: event.eventId,
      token: tokenForTicket(issued!.ticket.id),
      scannerUserId: org.userId,
    });

    expect(result.outcome).toBe('accepted');
    expect(result.accepted).toBe(true);
    expect(result.attendee?.name).toBe('Attendee 0');
  });

  it('refuses a ticket that has already been admitted', async () => {
    const [issued] = await issueTickets(event, 1);
    const token = tokenForTicket(issued!.ticket.id);

    const first = await scanTicket({ eventId: event.eventId, token, scannerUserId: org.userId });
    const second = await scanTicket({ eventId: event.eventId, token, scannerUserId: org.userId });

    expect(first.outcome).toBe('accepted');
    expect(second.outcome).toBe('already_checked_in');
    expect(second.accepted).toBe(false);

    const stats = await getCheckInStats(event.eventId);
    expect(stats.admitted).toBe(1);
    expect(stats.duplicates).toBe(1);
  });

  it('rejects a ticket issued for a different event', async () => {
    const [issued] = await issueTickets(event, 1);

    const result = await scanTicket({
      eventId: otherEvent.eventId,
      token: tokenForTicket(issued!.ticket.id),
      scannerUserId: org.userId,
    });

    expect(result.outcome).toBe('wrong_event');
    expect(result.accepted).toBe(false);
  });

  it('rejects a forged credential even though the ticket id is real', async () => {
    const [issued] = await issueTickets(event, 1);

    // The signature is the only thing standing between a leaked ticket id and a
    // printable ticket, so it must be checked rather than recomputed from the id.
    const forged = `t1.${issued!.ticket.id}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

    const result = await scanTicket({
      eventId: event.eventId,
      token: forged,
      scannerUserId: org.userId,
    });

    expect(result.outcome).toBe('invalid_token');
    expect(result.accepted).toBe(false);
  });

  it('rejects a malformed credential without touching the database lookup', async () => {
    for (const token of ['', 'nonsense', 't1.not-a-uuid.signature', 't2.' + 'a'.repeat(36) + '.sig']) {
      const result = await scanTicket({
        eventId: event.eventId,
        token,
        scannerUserId: org.userId,
      });

      expect(result.outcome).toBe('invalid_token');
    }
  });

  it('rejects a voided ticket', async () => {
    const [issued] = await issueTickets(event, 1);

    await db()
      .update(tickets)
      .set({ status: 'void', voidedAt: new Date(), voidReason: 'Refunded' })
      .where(eq(tickets.id, issued!.ticket.id));

    const result = await scanTicket({
      eventId: event.eventId,
      token: tokenForTicket(issued!.ticket.id),
      scannerUserId: org.userId,
    });

    expect(result.outcome).toBe('void_ticket');
    expect(result.accepted).toBe(false);
  });

  it('admits a ticket exactly once when two scanners race', async () => {
    const [issued] = await issueTickets(event, 1);
    const token = tokenForTicket(issued!.ticket.id);

    const attempts = Array.from({ length: 8 }, () =>
      scanTicket({ eventId: event.eventId, token, scannerUserId: org.userId }).then(
        (result) => result.outcome,
        () => 'error' as const,
      ),
    );

    const outcomes = await Promise.all(attempts);

    expect(outcomes.filter((outcome) => outcome === 'accepted')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'already_checked_in')).toHaveLength(7);
    expect(outcomes).not.toContain('error');

    const stats = await getCheckInStats(event.eventId);
    expect(stats.admitted).toBe(1);
  });

  it('records every attempt, not only the successful ones', async () => {
    const [issued] = await issueTickets(event, 1);
    const token = tokenForTicket(issued!.ticket.id);

    await scanTicket({ eventId: event.eventId, token, scannerUserId: org.userId });
    await scanTicket({ eventId: event.eventId, token, scannerUserId: org.userId });
    await scanTicket({
      eventId: otherEvent.eventId,
      token,
      scannerUserId: org.userId,
    });
    await scanTicket({ eventId: event.eventId, token: 'garbage', scannerUserId: org.userId });

    const eventAttempts = await db()
      .select()
      .from(checkInAttempts)
      .where(eq(checkInAttempts.eventId, event.eventId));

    const outcomes = eventAttempts.map((row) => row.outcome).sort();

    expect(outcomes).toContain('accepted');
    expect(outcomes).toContain('already_checked_in');
    expect(outcomes).toContain('invalid_token');

    // The wrong-event scan is recorded against the event it was attempted for.
    const otherAttempts = await db()
      .select()
      .from(checkInAttempts)
      .where(eq(checkInAttempts.eventId, otherEvent.eventId));

    expect(otherAttempts.map((row) => row.outcome)).toContain('wrong_event');
  });

  it('stores only a hash of the credential, never the credential itself', async () => {
    const [issued] = await issueTickets(event, 1);
    const token = tokenForTicket(issued!.ticket.id);

    const [row] = await db().select().from(tickets).where(eq(tickets.id, issued!.ticket.id)).limit(1);

    expect(row?.qrTokenHash).toBe(hashQrToken(token));
    expect(row?.qrTokenHash).toMatch(/^[0-9a-f]{64}$/);

    // The raw credential must not be recoverable from the row.
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('derives a stable credential so a ticket page can be re-rendered', async () => {
    const [issued] = await issueTickets(event, 1);

    // Deterministic derivation is what makes it possible to show the QR again
    // later without ever having stored it.
    expect(tokenForTicket(issued!.ticket.id)).toBe(tokenForTicket(issued!.ticket.id));
    expect(tokenForTicket(issued!.ticket.id)).toContain(issued!.ticket.id);
  });
});
