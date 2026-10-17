import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrder, getLatestPayment, getOrder } from '@/features/orders/service';
import { handleClientReturn, processWebhook, startPayment } from '@/features/payments/service';
import { simulatedProvider } from '@/features/payments/providers';
import { listTicketsForOrder } from '@/features/tickets/service';
import { db } from '@/lib/db/client';
import { payments, webhookEvents } from '@/lib/db/schema';
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
 * Payments.
 *
 * These tests cover the failure modes that actually cause double tickets and
 * wrong money: a webhook delivered twice, a webhook delivered out of order, and a
 * capture whose amount does not match the order.
 *
 * The simulated provider is used deliberately. It produces a *signed* payload and
 * the code path under test is the same one a real gateway drives — only the
 * signature key differs — so the idempotency logic is genuinely exercised.
 */
describe('payments', () => {
  let org: TestOrganization;
  let event: TestEvent;

  beforeEach(async () => {
    org = await createTestOrganization('owner');
    event = await createTestEvent(org.organizationId, org.userId, {
      ticketTypes: [{ name: 'Standard', priceMinor: 150_000, quantityTotal: 10 }],
    });
  });

  afterAll(async () => {
    await cleanupFixtures();
  });

  /** Creates a paid order and starts checkout on it. */
  async function startPaidOrder(quantity = 2) {
    const ticketType = event.ticketTypes[0]!;

    const created = await createOrder({
      eventId: event.eventId,
      lines: [
        {
          ticketTypeId: ticketType.id,
          attendees: Array.from({ length: quantity }, (_, index) => ({
            name: `Attendee ${index}`,
            email: `attendee${index}@example.test`,
          })),
        },
      ],
      buyer: { name: 'Buyer', email: 'buyer@example.test' },
    });

    const session = await startPayment(created.order.id);

    return { order: created.order, session, ticketType };
  }

  it('creates a provider order and records the payment as created', async () => {
    const { session } = await startPaidOrder();

    expect(session.provider).toBe('simulated');
    expect(session.payment.status).toBe('created');
    // The amount comes from our order, never from the browser.
    expect(session.payment.amountMinor).toBe(300_000);
    expect(session.payment.currency).toBe('INR');

    // Only publishable values reach the browser.
    expect(session.checkoutPayload).not.toHaveProperty('key_secret');
  });

  it('issues tickets for the exact number of attendees when payment succeeds', async () => {
    const { order, session } = await startPaidOrder(3);

    const provider = simulatedProvider();
    if (!provider) throw new Error('Expected the simulated provider in tests');

    const { providerPaymentId, signature } = provider.createSimulatedPayment({
      providerOrderId: session.payment.providerOrderId,
      outcome: 'success',
    });

    const outcome = await handleClientReturn({
      orderId: order.id,
      providerPaymentId,
      signature,
    });

    expect(outcome.confirmed).toBe(true);

    const tickets = await listTicketsForOrder(order.id);
    expect(tickets).toHaveLength(3);

    const inventory = await readInventory(event.ticketTypes[0]!.id);
    expect(inventory.sold).toBe(3);
    expect(inventory.reserved).toBe(0);
  });

  it('rejects a client return with a forged signature', async () => {
    const { order, session } = await startPaidOrder(1);

    const provider = simulatedProvider();
    if (!provider) throw new Error('Expected the simulated provider');

    provider.createSimulatedPayment({
      providerOrderId: session.payment.providerOrderId,
      outcome: 'success',
    });

    await expect(
      handleClientReturn({
        orderId: order.id,
        providerPaymentId: session.payment.providerOrderId,
        signature: 'not-a-real-signature',
      }),
    ).rejects.toThrow();

    // Nothing was confirmed and no ticket exists.
    expect((await getOrder(order.id))?.status).not.toBe('confirmed');
    expect(await listTicketsForOrder(order.id)).toHaveLength(0);
  });

  it('processes a webhook once and ignores the redelivery', async () => {
    const { order, session } = await startPaidOrder(2);

    const provider = simulatedProvider();
    if (!provider) throw new Error('Expected the simulated provider');

    const { providerPaymentId } = provider.createSimulatedPayment({
      providerOrderId: session.payment.providerOrderId,
      outcome: 'success',
    });

    const webhook = provider.buildWebhook({
      eventType: 'payment.captured',
      data: {
        providerOrderId: session.payment.providerOrderId,
        providerPaymentId,
        amountMinor: 300_000,
        currency: 'INR',
      },
    });

    const body = new TextEncoder().encode(webhook.body);

    const first = await processWebhook({
      rawBody: body,
      signature: webhook.signature,
      eventIdHeader: webhook.eventId,
    });

    const second = await processWebhook({
      rawBody: body,
      signature: webhook.signature,
      eventIdHeader: webhook.eventId,
    });

    const third = await processWebhook({
      rawBody: body,
      signature: webhook.signature,
      eventIdHeader: webhook.eventId,
    });

    expect(first.status).toBe('processed');
    expect(second.status).toBe('duplicate');
    expect(third.status).toBe('duplicate');

    // The point of the whole test: three deliveries, two tickets.
    const tickets = await listTicketsForOrder(order.id);
    expect(tickets).toHaveLength(2);

    const inventory = await readInventory(event.ticketTypes[0]!.id);
    expect(inventory.sold).toBe(2);
  });

  it('records exactly one webhook row per provider event', async () => {
    const { session } = await startPaidOrder(1);

    const provider = simulatedProvider();
    if (!provider) throw new Error('Expected the simulated provider');

    const { providerPaymentId } = provider.createSimulatedPayment({
      providerOrderId: session.payment.providerOrderId,
      outcome: 'success',
    });

    const webhook = provider.buildWebhook({
      eventType: 'payment.captured',
      data: {
        providerOrderId: session.payment.providerOrderId,
        providerPaymentId,
        amountMinor: 150_000,
        currency: 'INR',
      },
    });

    const body = new TextEncoder().encode(webhook.body);

    await processWebhook({
      rawBody: body,
      signature: webhook.signature,
      eventIdHeader: webhook.eventId,
    });
    await processWebhook({
      rawBody: body,
      signature: webhook.signature,
      eventIdHeader: webhook.eventId,
    });

    const rows = await db()
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.providerEventId, webhook.eventId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.signatureVerified).toBe(true);
    expect(rows[0]?.status).toBe('processed');
  });

  it('rejects a webhook whose signature does not verify', async () => {
    const { order } = await startPaidOrder(1);

    const body = new TextEncoder().encode(
      JSON.stringify({ event: 'payment.captured', data: { providerOrderId: 'forged' } }),
    );

    const result = await processWebhook({
      rawBody: body,
      signature: 'deadbeef',
      eventIdHeader: 'forged-event-id',
    });

    expect(result.status).toBe('rejected');

    // A rejected delivery must not have consumed the real event id, otherwise an
    // attacker could suppress a genuine webhook by guessing its id.
    const rows = await db()
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.providerEventId, 'forged-event-id'));

    expect(rows).toHaveLength(0);

    const failed = await db()
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.signatureVerified, false));

    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect((await getOrder(order.id))?.status).not.toBe('confirmed');
  });

  it('flags an amount mismatch instead of issuing tickets', async () => {
    const { order, session } = await startPaidOrder(2);

    const provider = simulatedProvider();
    if (!provider) throw new Error('Expected the simulated provider');

    const { providerPaymentId } = provider.createSimulatedPayment({
      providerOrderId: session.payment.providerOrderId,
      outcome: 'success',
    });

    // The provider claims a capture of ₹1.00 against a ₹3000.00 order.
    const webhook = provider.buildWebhook({
      eventType: 'payment.captured',
      data: {
        providerOrderId: session.payment.providerOrderId,
        providerPaymentId,
        amountMinor: 100,
        currency: 'INR',
      },
    });

    const result = await processWebhook({
      rawBody: new TextEncoder().encode(webhook.body),
      signature: webhook.signature,
      eventIdHeader: webhook.eventId,
    });

    expect(result.status).toBe('processed');

    // Tickets are withheld and a human is asked to look.
    expect(await listTicketsForOrder(order.id)).toHaveLength(0);
    expect((await getOrder(order.id))?.status).not.toBe('confirmed');

    const payment = await getLatestPayment(order.id);
    expect(payment?.status).toBe('captured');

    const metadata = payment?.metadata as {
      amountMismatch?: { expected: number; received: number };
    };
    expect(metadata?.amountMismatch?.expected).toBe(300_000);
    expect(metadata?.amountMismatch?.received).toBe(100);
  });

  it('never downgrades a captured payment when a late failure arrives', async () => {
    const { order, session } = await startPaidOrder(1);

    const provider = simulatedProvider();
    if (!provider) throw new Error('Expected the simulated provider');

    const { providerPaymentId } = provider.createSimulatedPayment({
      providerOrderId: session.payment.providerOrderId,
      outcome: 'success',
    });

    await handleClientReturn({
      orderId: order.id,
      providerPaymentId,
      signature: (() => {
        const minted = provider.createSimulatedPayment({
          providerOrderId: session.payment.providerOrderId,
          outcome: 'success',
        });
        return minted.signature;
      })(),
    });

    // A failure event for the same order arrives afterwards.
    const failure = provider.buildWebhook({
      eventType: 'payment.failed',
      data: {
        providerOrderId: session.payment.providerOrderId,
        reason: 'Late failure notice',
      },
    });

    await processWebhook({
      rawBody: new TextEncoder().encode(failure.body),
      signature: failure.signature,
      eventIdHeader: failure.eventId,
    });

    const payment = await getLatestPayment(order.id);
    expect(payment?.status).toBe('captured');

    // And the tickets stay issued.
    expect((await getOrder(order.id))?.status).toBe('confirmed');
  });

  it('refuses to start a payment on an order that is already paid', async () => {
    const ticketType = event.ticketTypes[0]!;

    const created = await createOrder({
      eventId: event.eventId,
      lines: [{ ticketTypeId: ticketType.id, attendees: [{ name: 'A', email: 'a@example.test' }] }],
      buyer: { name: 'Buyer', email: 'buyer@example.test' },
    });

    const session = await startPayment(created.order.id);

    const provider = simulatedProvider();
    if (!provider) throw new Error('Expected the simulated provider');

    const { providerPaymentId, signature } = provider.createSimulatedPayment({
      providerOrderId: session.payment.providerOrderId,
      outcome: 'success',
    });

    await handleClientReturn({ orderId: created.order.id, providerPaymentId, signature });

    await expect(startPayment(created.order.id)).rejects.toThrow(/already been paid/i);

    const rows = await db().select().from(payments).where(eq(payments.orderId, created.order.id));
    expect(rows).toHaveLength(1);
  });
});
