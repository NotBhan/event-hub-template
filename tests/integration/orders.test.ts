import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createOrder,
  confirmOrder,
  expireAbandonedOrders,
  cancelOrder,
  getOrder,
} from '@/features/orders/service';
import { issueTicketsForOrder, listTicketsForOrder } from '@/features/tickets/service';
import { db } from '@/lib/db/client';
import { emailOutbox, orders } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import {
  cleanupFixtures,
  createTestEvent,
  createTestOrganization,
  readInventory,
  type TestEvent,
  type TestOrganization,
} from '../setup/fixtures';

/**
 * Order lifecycle.
 *
 * The rules under test are the ones that decide whether money and tickets stay
 * consistent: idempotency, the difference between a held and a sold ticket, and
 * what happens when confirmation arrives twice.
 */
describe('orders', () => {
  let org: TestOrganization;
  let event: TestEvent;

  beforeEach(async () => {
    org = await createTestOrganization('owner');
    event = await createTestEvent(org.organizationId, org.userId, {
      ticketTypes: [{ name: 'Standard', priceMinor: 120_000, quantityTotal: 20 }],
    });
  });

  afterAll(async () => {
    await cleanupFixtures();
  });

  it('computes the total from database prices, not from the client', async () => {
    const ticketType = event.ticketTypes[0]!;

    const created = await createOrder({
      eventId: event.eventId,
      lines: [
        {
          ticketTypeId: ticketType.id,
          attendees: [
            { name: 'One', email: 'one@example.test' },
            { name: 'Two', email: 'two@example.test' },
            { name: 'Three', email: 'three@example.test' },
          ],
        },
      ],
      buyer: { name: 'Buyer', email: 'buyer@example.test' },
    });

    // 3 × ₹1200.00, in paise.
    expect(created.order.subtotalMinor).toBe(360_000);
    expect(created.order.totalMinor).toBe(360_000);
    expect(created.order.currency).toBe('INR');

    // The line item carries a snapshot, so a later price change cannot alter it.
    expect(created.items[0]?.unitPriceMinorSnapshot).toBe(120_000);
    expect(created.items[0]?.ticketNameSnapshot).toBe('Standard');
  });

  it('returns the original order when the same idempotency key is replayed', async () => {
    const ticketType = event.ticketTypes[0]!;
    const key = 'test-idempotency-key-1';

    const first = await createOrder({
      eventId: event.eventId,
      lines: [{ ticketTypeId: ticketType.id, attendees: [{ name: 'A', email: 'a@example.test' }] }],
      buyer: { name: 'Buyer', email: 'buyer@example.test' },
      idempotencyKey: key,
    });

    const second = await createOrder({
      eventId: event.eventId,
      lines: [{ ticketTypeId: ticketType.id, attendees: [{ name: 'A', email: 'a@example.test' }] }],
      buyer: { name: 'Buyer', email: 'buyer@example.test' },
      idempotencyKey: key,
    });

    expect(second.replayed).toBe(true);
    expect(second.order.id).toBe(first.order.id);

    // Critically: stock was held once, not twice.
    const inventory = await readInventory(ticketType.id);
    expect(inventory.reserved).toBe(1);
  });

  it('is safe to confirm twice, issuing tickets exactly once', async () => {
    const ticketType = event.ticketTypes[0]!;

    const created = await createOrder({
      eventId: event.eventId,
      lines: [
        {
          ticketTypeId: ticketType.id,
          attendees: [
            { name: 'One', email: 'one@example.test' },
            { name: 'Two', email: 'two@example.test' },
          ],
        },
      ],
      buyer: { name: 'Buyer', email: 'buyer@example.test' },
    });

    const first = await confirmOrder({ orderId: created.order.id });
    const second = await confirmOrder({ orderId: created.order.id });

    expect(first.alreadyConfirmed).toBe(false);
    expect(second.alreadyConfirmed).toBe(true);

    // Two attendees, two tickets — not four.
    const tickets = await listTicketsForOrder(created.order.id);
    expect(tickets).toHaveLength(2);

    const inventory = await readInventory(ticketType.id);
    expect(inventory.sold).toBe(2);
    expect(inventory.reserved).toBe(0);
  });

  it('issues one ticket per attendee, with a distinct reference each', async () => {
    const ticketType = event.ticketTypes[0]!;

    const created = await createOrder({
      eventId: event.eventId,
      lines: [
        {
          ticketTypeId: ticketType.id,
          attendees: Array.from({ length: 4 }, (_, index) => ({
            name: `Attendee ${index}`,
            email: `attendee${index}@example.test`,
          })),
        },
      ],
      buyer: { name: 'Buyer', email: 'buyer@example.test' },
    });

    await confirmOrder({ orderId: created.order.id });

    const tickets = await listTicketsForOrder(created.order.id);
    expect(tickets).toHaveLength(4);

    const references = tickets.map((row) => row.ticket.publicReference);
    expect(new Set(references).size).toBe(4);

    // Each ticket stores only a hash of its credential.
    for (const row of tickets) {
      expect(row.ticket.qrTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.ticket.status).toBe('issued');
    }
  });

  it('releases reserved stock when an unpaid order expires', async () => {
    const ticketType = event.ticketTypes[0]!;

    const created = await createOrder({
      eventId: event.eventId,
      lines: [
        {
          ticketTypeId: ticketType.id,
          attendees: [
            { name: 'One', email: 'one@example.test' },
            { name: 'Two', email: 'two@example.test' },
          ],
        },
      ],
      buyer: { name: 'Buyer', email: 'buyer@example.test' },
    });

    expect((await readInventory(ticketType.id)).reserved).toBe(2);

    // Wind the reservation clock back rather than waiting for it.
    await db()
      .update(orders)
      .set({ reservationExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(orders.id, created.order.id));

    const result = await expireAbandonedOrders();

    expect(result.expired).toBeGreaterThanOrEqual(1);

    const inventory = await readInventory(ticketType.id);
    expect(inventory.reserved).toBe(0);
    expect(inventory.sold).toBe(0);
    expect(inventory.available).toBe(20);

    expect((await getOrder(created.order.id))?.status).toBe('expired');
  });

  it('queues confirmation email only after the order is confirmed', async () => {
    const ticketType = event.ticketTypes[0]!;

    const created = await createOrder({
      eventId: event.eventId,
      lines: [{ ticketTypeId: ticketType.id, attendees: [{ name: 'A', email: 'a@example.test' }] }],
      buyer: { name: 'Buyer', email: 'buyer@example.test' },
    });

    const before = await db()
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.organizationId, org.organizationId));

    // A pending order must not have told the buyer anything yet.
    expect(before).toHaveLength(0);

    await confirmOrder({ orderId: created.order.id });

    const after = await db()
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.organizationId, org.organizationId));

    expect(after.length).toBeGreaterThan(0);
    expect(after.every((row) => row.status === 'pending')).toBe(true);
    expect(after.map((row) => row.notificationType)).toContain('tickets_issued');
  });

  it('releases held stock when a pending order is cancelled', async () => {
    const ticketType = event.ticketTypes[0]!;

    const created = await createOrder({
      eventId: event.eventId,
      lines: [{ ticketTypeId: ticketType.id, attendees: [{ name: 'A', email: 'a@example.test' }] }],
      buyer: { name: 'Buyer', email: 'buyer@example.test' },
    });

    await cancelOrder({ orderId: created.order.id, reason: 'Changed their mind' });

    const inventory = await readInventory(ticketType.id);
    expect(inventory.reserved).toBe(0);
    expect(inventory.available).toBe(20);
  });

  it('refuses to cancel a confirmed order, directing the caller to refund instead', async () => {
    const ticketType = event.ticketTypes[0]!;

    const created = await createOrder({
      eventId: event.eventId,
      lines: [{ ticketTypeId: ticketType.id, attendees: [{ name: 'A', email: 'a@example.test' }] }],
      buyer: { name: 'Buyer', email: 'buyer@example.test' },
    });

    await confirmOrder({ orderId: created.order.id });

    await expect(cancelOrder({ orderId: created.order.id })).rejects.toThrow(/refund/i);

    // Money and tickets are untouched.
    const inventory = await readInventory(ticketType.id);
    expect(inventory.sold).toBe(1);
  });

  it('never issues duplicate tickets when issuance runs twice', async () => {
    const ticketType = event.ticketTypes[0]!;

    const created = await createOrder({
      eventId: event.eventId,
      lines: [
        {
          ticketTypeId: ticketType.id,
          attendees: [
            { name: 'One', email: 'one@example.test' },
            { name: 'Two', email: 'two@example.test' },
          ],
        },
      ],
      buyer: { name: 'Buyer', email: 'buyer@example.test' },
    });

    const firstPass = await db().transaction((tx) => issueTicketsForOrder(tx, created.order.id));
    const secondPass = await db().transaction((tx) => issueTicketsForOrder(tx, created.order.id));

    expect(firstPass).toHaveLength(2);
    // The second pass finds every attendee already has a ticket and does nothing.
    expect(secondPass).toHaveLength(0);

    const tickets = await listTicketsForOrder(created.order.id);
    expect(tickets).toHaveLength(2);
  });
});
