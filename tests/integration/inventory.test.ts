import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrder } from '@/features/orders/service';
import { availableQuantity } from '@/features/inventory/service';
import {
  cleanupFixtures,
  createTestEvent,
  createTestOrganization,
  oneAttendee,
  readInventory,
  type TestEvent,
  type TestOrganization,
} from '../setup/fixtures';

/**
 * Inventory correctness under concurrency.
 *
 * This is the test the whole reservation design exists for. Selling the last
 * ticket twice is the failure mode that costs an organizer real money and
 * credibility, and it only happens under load — so it has to be tested by
 * actually issuing competing requests, not by reasoning about the code.
 */
describe('inventory', () => {
  let org: TestOrganization;
  let event: TestEvent;

  beforeEach(async () => {
    org = await createTestOrganization('owner');
  });

  afterAll(async () => {
    await cleanupFixtures();
  });

  it('reserves stock without marking it sold', async () => {
    event = await createTestEvent(org.organizationId, org.userId, {
      ticketTypes: [{ name: 'Standard', priceMinor: 100_000, quantityTotal: 5 }],
    });

    const ticketType = event.ticketTypes[0]!;

    const order = await createOrder({
      eventId: event.eventId,
      lines: [{ ticketTypeId: ticketType.id, attendees: oneAttendee() }],
      buyer: { name: 'Buyer', email: 'buyer@example.test' },
    });

    const inventory = await readInventory(ticketType.id);

    // The order is unpaid, so stock is held rather than sold.
    expect(inventory.reserved).toBe(1);
    expect(inventory.sold).toBe(0);
    expect(inventory.available).toBe(4);
    expect(order.order.status).toBe('pending_payment');
  });

  it('confirms a free order immediately and issues tickets', async () => {
    event = await createTestEvent(org.organizationId, org.userId, {
      ticketTypes: [{ name: 'Free', priceMinor: 0, quantityTotal: 3 }],
    });

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

    // No payment to wait for, so it is confirmed and the stock is sold.
    expect(created.order.status).toBe('confirmed');

    const inventory = await readInventory(ticketType.id);
    expect(inventory.sold).toBe(2);
    expect(inventory.reserved).toBe(0);
  });

  it('never sells the final ticket twice under concurrent checkout', async () => {
    // Capacity of one, and ten buyers trying at the same instant.
    event = await createTestEvent(org.organizationId, org.userId, {
      ticketTypes: [{ name: 'Last one', priceMinor: 250_000, quantityTotal: 1 }],
    });

    const ticketType = event.ticketTypes[0]!;

    const attempts = Array.from({ length: 10 }, (_, index) =>
      createOrder({
        eventId: event.eventId,
        lines: [
          {
            ticketTypeId: ticketType.id,
            attendees: oneAttendee(`Buyer ${index}`, `buyer${index}@example.test`),
          },
        ],
        buyer: { name: `Buyer ${index}`, email: `buyer${index}@example.test` },
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );

    const results = await Promise.all(attempts);

    const succeeded = results.filter((result) => result.ok);
    const failed = results.filter((result) => !result.ok);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(9);

    // Every failure must be a legitimate "sold out", not a crash.
    for (const failure of failed) {
      expect(failure.ok).toBe(false);
      if (!failure.ok) {
        expect(String(failure.error)).toMatch(/sold out|no longer available|Only 0/i);
      }
    }

    const inventory = await readInventory(ticketType.id);
    expect(inventory.reserved).toBe(1);
    expect(inventory.available).toBe(0);
  });

  it('holds capacity for the exact number of tickets requested', async () => {
    event = await createTestEvent(org.organizationId, org.userId, {
      ticketTypes: [{ name: 'Workshop', priceMinor: 100_000, quantityTotal: 10 }],
    });

    const ticketType = event.ticketTypes[0]!;

    // Four concurrent orders of three tickets each against ten seats: three
    // orders fit (nine held), the fourth must be refused.
    const attempts = Array.from({ length: 4 }, (_, index) =>
      createOrder({
        eventId: event.eventId,
        lines: [
          {
            ticketTypeId: ticketType.id,
            attendees: Array.from({ length: 3 }, (_, seat) => ({
              name: `Buyer ${index} Seat ${seat}`,
              email: `b${index}s${seat}@example.test`,
            })),
          },
        ],
        buyer: { name: `Buyer ${index}`, email: `buyer${index}@example.test` },
      }).then(
        () => 'ok' as const,
        () => 'refused' as const,
      ),
    );

    const results = await Promise.all(attempts);

    expect(results.filter((result) => result === 'ok')).toHaveLength(3);
    expect(results.filter((result) => result === 'refused')).toHaveLength(1);

    const inventory = await readInventory(ticketType.id);
    expect(inventory.reserved).toBe(9);
    expect(inventory.available).toBe(1);
  });

  it('refuses quantities outside the per-order limits', async () => {
    event = await createTestEvent(org.organizationId, org.userId, {
      ticketTypes: [{ name: 'Limited', priceMinor: 100_000, quantityTotal: 50, maxPerOrder: 2 }],
    });

    const ticketType = event.ticketTypes[0]!;

    await expect(
      createOrder({
        eventId: event.eventId,
        lines: [
          {
            ticketTypeId: ticketType.id,
            attendees: Array.from({ length: 3 }, (_, index) => ({
              name: `Seat ${index}`,
              email: `seat${index}@example.test`,
            })),
          },
        ],
        buyer: { name: 'Buyer', email: 'buyer@example.test' },
      }),
    ).rejects.toThrow(/between 1 and 2|maximum/i);

    // A refused order must not leave a reservation behind.
    const inventory = await readInventory(ticketType.id);
    expect(inventory.reserved).toBe(0);
  });

  it('treats availability as capacity minus sold minus reserved', () => {
    // The invariant the database enforces, exercised as a pure function too.
    expect(availableQuantity({ quantityTotal: 10, quantitySold: 3, quantityReserved: 2 })).toBe(5);
    expect(availableQuantity({ quantityTotal: 10, quantitySold: 10, quantityReserved: 0 })).toBe(0);
  });
});
