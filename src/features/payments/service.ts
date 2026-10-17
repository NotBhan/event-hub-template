import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  events,
  orders,
  payments,
  refunds,
  webhookEvents,
  type Order,
  type Payment,
} from '@/lib/db/schema';
import { toNumber } from '@/lib/db/scalars';
import { BadRequestError, ConflictError, NotFoundError } from '@/lib/security/errors';
import { recordAudit } from '@/features/audit/service';
import { confirmOrder, releaseOrderInventory } from '@/features/orders/service';
import { voidTicketsForRefund } from '@/features/tickets/service';
import { enqueueEmail } from '@/features/notifications/outbox';
import { formatMoney } from '@/lib/money';
import { paymentProvider, WebhookVerificationError, type PaymentProvider } from './providers';
import { simulatedProvider } from './providers';

/**
 * Payments service.
 *
 * ## The three rules that keep money and tickets correct
 *
 * 1. **A browser success message proves nothing.** The client-return path
 *    verifies the provider's signature, then re-fetches the payment from the
 *    provider, then compares the captured amount against the order. Only then is
 *    anything confirmed — and confirmation itself is idempotent.
 *
 * 2. **Webhooks are delivered at least once, out of order, and sometimes twice.**
 *    Every delivery is claimed by `(provider, provider_event_id)` under a unique
 *    index before it is acted on, so a redelivery is a no-op.
 *
 * 3. **A payment is not an order.** Failures, retries and partial refunds each get
 *    their own record, so an investigation can replay exactly what happened.
 */

export interface CheckoutSession {
  order: Order;
  payment: Payment;
  provider: string;
  simulated: boolean;
  /** Exactly what the browser needs. Never contains a secret key. */
  checkoutPayload: Record<string, unknown>;
}

/**
 * Starts (or restarts) payment for a pending order.
 *
 * Reuses a still-valid provider order when one exists, so a buyer refreshing the
 * payment page does not create a new gateway order each time.
 */
export async function startPayment(orderId: string): Promise<CheckoutSession> {
  const provider = paymentProvider();

  const [order] = await db().select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new NotFoundError('Order not found');

  if (order.status === 'confirmed') {
    throw new ConflictError('This order has already been paid');
  }

  if (order.status === 'cancelled' || order.status === 'expired') {
    throw new ConflictError('This order is no longer payable');
  }

  if (order.totalMinor <= 0) {
    throw new BadRequestError('This order does not require payment');
  }

  const [existing] = await db()
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, 'created')))
    .orderBy(desc(payments.createdAt))
    .limit(1);

  if (existing && existing.provider === provider.name) {
    const checkoutPayload = await rebuildCheckoutPayload(provider, existing, order);
    return {
      order,
      payment: existing,
      provider: provider.name,
      simulated: provider.simulated,
      checkoutPayload,
    };
  }

  const providerOrder = await provider.createOrder({
    amountMinor: order.totalMinor,
    currency: order.currency,
    receipt: order.publicReference,
    notes: { orderId: order.id, eventId: order.eventId },
  });

  const [payment] = await db()
    .insert(payments)
    .values({
      organizationId: order.organizationId,
      orderId: order.id,
      provider: provider.name,
      providerOrderId: providerOrder.providerOrderId,
      // The amount comes from our own order row, never from the provider echo.
      amountMinor: order.totalMinor,
      currency: order.currency,
      status: 'created',
      metadata: { receipt: order.publicReference },
    })
    .returning();

  if (!payment) throw new Error('Failed to record payment');

  return {
    order,
    payment,
    provider: provider.name,
    simulated: provider.simulated,
    checkoutPayload: providerOrder.checkoutPayload,
  };
}

async function rebuildCheckoutPayload(
  provider: PaymentProvider,
  payment: Payment,
  order: Order,
): Promise<Record<string, unknown>> {
  const base = {
    key: 'reused',
    order_id: payment.providerOrderId,
    amount: order.totalMinor,
    currency: order.currency,
  };

  if (provider.simulated) return { ...base, simulated: true };

  const { serverEnv } = await import('@/lib/security/env');
  return { ...base, key: serverEnv().RAZORPAY_KEY_ID };
}

export interface ClientReturnInput {
  orderId: string;
  providerPaymentId: string;
  signature: string;
  method?: string;
}

export interface PaymentOutcome {
  order: Order;
  payment: Payment;
  confirmed: boolean;
  needsReconciliation: boolean;
  message: string;
}

/**
 * Handles the browser returning from checkout.
 *
 * This never trusts what the browser reports: it verifies the signature, fetches
 * the authoritative payment from the provider, and checks the captured amount
 * against the order before confirmation.
 */
export async function handleClientReturn(input: ClientReturnInput): Promise<PaymentOutcome> {
  const provider = paymentProvider();

  const [order] = await db().select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
  if (!order) throw new NotFoundError('Order not found');

  const [payment] = await db()
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.provider, provider.name)))
    .orderBy(desc(payments.createdAt))
    .limit(1);

  if (!payment) throw new NotFoundError('No payment has been started for this order');

  const verified = await provider.verifyPayment({
    providerOrderId: payment.providerOrderId,
    providerPaymentId: input.providerPaymentId,
    signature: input.signature,
  });

  return settleVerifiedPayment({
    order,
    payment,
    providerPaymentId: verified.providerPaymentId,
    reportedAmountMinor: verified.amountMinor,
    reportedCurrency: verified.currency,
    status: verified.status,
    method: verified.method ?? input.method,
    source: 'client_return',
  });
}

interface SettleInput {
  order: Order;
  payment: Payment;
  providerPaymentId: string;
  reportedAmountMinor: number;
  reportedCurrency: string;
  status: 'authorized' | 'captured' | 'failed';
  method?: string;
  source: 'client_return' | 'webhook' | 'reconciliation';
}

/**
 * Applies a verified payment result to the order.
 *
 * Shared by the client return, the webhook and the reconciliation worker so all
 * three routes reach the same conclusion through the same code.
 */
async function settleVerifiedPayment(input: SettleInput): Promise<PaymentOutcome> {
  const { order, payment } = input;

  if (input.status === 'failed') {
    await db()
      .update(payments)
      .set({
        status: 'failed',
        providerPaymentId: input.providerPaymentId,
        failedAt: new Date(),
        failureReason: 'Payment failed at the provider',
        method: input.method ?? payment.method,
      })
      .where(eq(payments.id, payment.id));

    await recordAudit(db(), {
      organizationId: order.organizationId,
      action: 'payment.failed',
      resourceType: 'payment',
      resourceId: payment.id,
      metadata: { source: input.source, providerOrderId: payment.providerOrderId },
    });

    return {
      order,
      payment,
      confirmed: false,
      needsReconciliation: false,
      message: 'The payment did not complete. You can try again.',
    };
  }

  // The captured amount must match what we asked for. A mismatch is never
  // resolved by issuing tickets: it is flagged for a human.
  const amountMatches =
    input.reportedAmountMinor === order.totalMinor && input.reportedCurrency === order.currency;

  if (!amountMatches) {
    const [updated] = await db()
      .update(payments)
      .set({
        status: 'captured',
        providerPaymentId: input.providerPaymentId,
        capturedAt: new Date(),
        method: input.method ?? payment.method,
        metadata: {
          ...(payment.metadata ?? {}),
          amountMismatch: {
            expected: order.totalMinor,
            received: input.reportedAmountMinor,
            expectedCurrency: order.currency,
            receivedCurrency: input.reportedCurrency,
            detectedVia: input.source,
          },
        },
      })
      .where(eq(payments.id, payment.id))
      .returning();

    await recordAudit(db(), {
      organizationId: order.organizationId,
      action: 'payment.reconciled',
      resourceType: 'payment',
      resourceId: payment.id,
      metadata: {
        issue: 'amount_mismatch',
        expectedMinor: order.totalMinor,
        receivedMinor: input.reportedAmountMinor,
      },
    });

    return {
      order,
      payment: updated ?? payment,
      confirmed: false,
      needsReconciliation: true,
      message:
        'We have received your payment but it needs manual review. Our team has been notified.',
    };
  }

  const [updated] = await db()
    .update(payments)
    .set({
      status: 'captured',
      providerPaymentId: input.providerPaymentId,
      capturedAt: new Date(),
      method: input.method ?? payment.method,
    })
    .where(eq(payments.id, payment.id))
    .returning();

  const confirmation = await confirmOrder({
    orderId: order.id,
    paymentId: payment.id,
  });

  return {
    order: confirmation.order,
    payment: updated ?? payment,
    confirmed: !confirmation.needsReconciliation,
    needsReconciliation: confirmation.needsReconciliation,
    message: confirmation.needsReconciliation
      ? 'Your payment succeeded but the order could not be completed automatically. Our team has been notified.'
      : 'Payment received. Your tickets are ready.',
  };
}

export interface WebhookResult {
  status: 'processed' | 'ignored' | 'duplicate' | 'failed' | 'rejected';
  message: string;
}

/**
 * Processes a webhook delivery end to end.
 *
 * Webhooks are the authoritative signal: they arrive whether or not the buyer
 * ever returns to the site.
 */
export async function processWebhook(input: {
  rawBody: Uint8Array;
  signature: string | null;
  eventIdHeader?: string | null;
}): Promise<WebhookResult> {
  const provider = paymentProvider();

  let verified;
  try {
    verified = await provider.verifyWebhook(input);
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      /**
       * Rejected payloads are recorded for investigation, but under a generated
       * id: an attacker must not be able to occupy a real event id and thereby
       * suppress a genuine delivery.
       */
      await db()
        .insert(webhookEvents)
        .values({
          provider: provider.name,
          providerEventId: `rejected_${crypto.randomUUID()}`,
          eventType: 'unknown',
          signatureVerified: false,
          status: 'failed',
          errorMessage: 'Signature verification failed',
        });

      await recordAudit(db(), {
        action: 'webhook.rejected',
        resourceType: 'webhook',
        metadata: { provider: provider.name, reason: 'signature_verification_failed' },
      });

      return { status: 'rejected', message: 'Signature verification failed' };
    }
    throw error;
  }

  // Claim the delivery. A second delivery of the same event id loses the race
  // and returns immediately without applying anything twice.
  const claim = await claimWebhookEvent({
    provider: provider.name,
    providerEventId: verified.eventId,
    eventType: verified.eventType,
    payloadSummary: verified.payloadSummary,
  });

  if (!claim.claimed) {
    return { status: 'duplicate', message: 'This event has already been processed' };
  }

  try {
    const intent = verified.intent;

    if (intent.kind === 'ignored') {
      await markWebhook(claim.id, 'ignored');
      return { status: 'ignored', message: intent.reason };
    }

    if (intent.kind === 'payment_captured') {
      await handlePaymentCaptured(intent);
      await markWebhook(claim.id, 'processed');
      return { status: 'processed', message: 'Payment captured' };
    }

    if (intent.kind === 'payment_failed') {
      await handlePaymentFailed(intent);
      await markWebhook(claim.id, 'processed');
      return { status: 'processed', message: 'Payment failure recorded' };
    }

    await handleRefundProcessed(intent);
    await markWebhook(claim.id, 'processed');
    return { status: 'processed', message: 'Refund updated' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markWebhook(claim.id, 'failed', message);
    console.error('Webhook processing failed', { eventId: verified.eventId, error });

    // A 500 tells the provider to retry, which is what we want for transient faults.
    throw error;
  }
}

async function claimWebhookEvent(input: {
  provider: string;
  providerEventId: string;
  eventType: string;
  payloadSummary: Record<string, unknown>;
}): Promise<{ claimed: boolean; id: string }> {
  const [row] = await db()
    .insert(webhookEvents)
    .values({
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      signatureVerified: true,
      status: 'received',
      payloadSummary: input.payloadSummary,
    })
    // If the row already exists, the delivery is a duplicate and claims nothing.
    .onConflictDoNothing({
      target: [webhookEvents.provider, webhookEvents.providerEventId],
    })
    .returning({ id: webhookEvents.id });

  if (row) return { claimed: true, id: row.id };

  const [existing] = await db()
    .select({ id: webhookEvents.id, status: webhookEvents.status })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.provider, input.provider),
        eq(webhookEvents.providerEventId, input.providerEventId),
      ),
    )
    .limit(1);

  return { claimed: false, id: existing?.id ?? '' };
}

async function markWebhook(
  id: string,
  status: 'processed' | 'ignored' | 'failed',
  errorMessage?: string,
): Promise<void> {
  if (!id) return;

  await db()
    .update(webhookEvents)
    .set({
      status,
      processedAt: new Date(),
      errorMessage: errorMessage ?? null,
    })
    .where(eq(webhookEvents.id, id));
}

async function handlePaymentCaptured(intent: {
  providerOrderId: string;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  method?: string;
}): Promise<void> {
  const [payment] = await db()
    .select()
    .from(payments)
    .where(eq(payments.providerOrderId, intent.providerOrderId))
    .limit(1);

  if (!payment) {
    /**
     * A capture for an order we do not know about. Recorded as failed so the
     * reconciliation worker surfaces it rather than losing the money trail.
     */
    throw new Error(`No payment record for provider order ${intent.providerOrderId}`);
  }

  const [order] = await db().select().from(orders).where(eq(orders.id, payment.orderId)).limit(1);
  if (!order) throw new Error(`No order for payment ${payment.id}`);

  await settleVerifiedPayment({
    order,
    payment,
    providerPaymentId: intent.providerPaymentId,
    reportedAmountMinor: intent.amountMinor,
    reportedCurrency: intent.currency,
    status: 'captured',
    method: intent.method,
    source: 'webhook',
  });
}

async function handlePaymentFailed(intent: {
  providerOrderId: string;
  providerPaymentId?: string;
  reason?: string;
}): Promise<void> {
  const [payment] = await db()
    .select()
    .from(payments)
    .where(eq(payments.providerOrderId, intent.providerOrderId))
    .limit(1);

  if (!payment) return;

  // A payment can fail after a later attempt succeeded; never downgrade a capture.
  if (payment.status === 'captured' || payment.status === 'refunded') return;

  await db()
    .update(payments)
    .set({
      status: 'failed',
      providerPaymentId: intent.providerPaymentId ?? payment.providerPaymentId,
      failedAt: new Date(),
      failureReason: intent.reason ?? 'Payment failed at the provider',
    })
    .where(eq(payments.id, payment.id));
}

async function handleRefundProcessed(intent: {
  providerRefundId: string;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  status: 'succeeded' | 'failed';
}): Promise<void> {
  const [refund] = await db()
    .select()
    .from(refunds)
    .where(eq(refunds.providerRefundId, intent.providerRefundId))
    .limit(1);

  if (!refund) {
    // Could be a refund raised directly in the provider dashboard. Nothing to
    // update locally, but the payment's refunded total should be re-checked.
    await reconcilePaymentByProviderId(intent.providerPaymentId);
    return;
  }

  if (refund.status === 'succeeded') return;

  if (intent.status === 'failed') {
    await db()
      .update(refunds)
      .set({ status: 'failed', failureReason: 'The provider rejected the refund' })
      .where(eq(refunds.id, refund.id));

    await recordAudit(db(), {
      organizationId: refund.organizationId,
      action: 'refund.failed',
      resourceType: 'refund',
      resourceId: refund.id,
    });
    return;
  }

  await finaliseRefund(refund.id);
}

/**
 * Marks a refund as succeeded and applies its consequences: the payment's
 * refunded state, ticket voiding and the buyer's notification.
 */
export async function finaliseRefund(refundId: string): Promise<void> {
  await db().transaction(async (tx) => {
    const [refund] = await tx
      .select()
      .from(refunds)
      .where(eq(refunds.id, refundId))
      .limit(1)
      .for('update');

    if (!refund || refund.status === 'succeeded') return;

    await tx
      .update(refunds)
      .set({ status: 'succeeded', succeededAt: new Date() })
      .where(eq(refunds.id, refund.id));

    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, refund.paymentId))
      .limit(1)
      .for('update');

    if (payment) {
      const [aggregate] = await tx
        .select({ total: sql<number>`coalesce(sum(${refunds.amountMinor}), 0)::bigint` })
        .from(refunds)
        .where(and(eq(refunds.paymentId, payment.id), eq(refunds.status, 'succeeded')));

      const refundedTotal = toNumber(aggregate?.total) + refund.amountMinor;
      const isFull = refundedTotal >= payment.amountMinor;

      await tx
        .update(payments)
        .set({ status: isFull ? 'refunded' : 'partially_refunded' })
        .where(eq(payments.id, payment.id));
    }

    // Tickets covered by the refund are voided; an admission that already
    // happened is reported rather than silently reversed.
    const covered = await tx.execute<{ ticket_id: string | null }>(
      sql`select ticket_id from refund_items where refund_id = ${refund.id} and ticket_id is not null`,
    );

    const ticketIds = covered.map((row) => row.ticket_id).filter((id): id is string => Boolean(id));

    if (ticketIds.length > 0) {
      const result = await voidTicketsForRefund(tx, {
        ticketIds,
        reason: 'Refund processed',
        organizationId: refund.organizationId,
      });

      if (result.skipped > 0) {
        await recordAudit(tx, {
          organizationId: refund.organizationId,
          action: 'refund.succeeded',
          resourceType: 'refund',
          resourceId: refund.id,
          metadata: { voided: result.voided, admittedNotVoided: result.skipped },
        });
      }
    } else {
      // A whole-order refund: every ticket on the order is void and the stock
      // returns to availability.
      const ticketRows = await tx.execute<{ id: string }>(
        sql`select id from tickets where order_id = ${refund.orderId} and status = 'issued'`,
      );

      if (ticketRows.length > 0) {
        await voidTicketsForRefund(tx, {
          ticketIds: ticketRows.map((row) => row.id),
          reason: 'Refund processed',
          organizationId: refund.organizationId,
        });
      }

      await releaseOrderInventory(tx, refund.orderId);
    }

    const [order] = await tx
      .select({
        buyerEmail: orders.buyerEmail,
        buyerName: orders.buyerName,
        eventId: orders.eventId,
      })
      .from(orders)
      .where(eq(orders.id, refund.orderId))
      .limit(1);

    const [event] = order
      ? await tx
          .select({ title: events.title })
          .from(events)
          .where(eq(events.id, order.eventId))
          .limit(1)
      : [];

    if (order) {
      await enqueueEmail(tx, {
        organizationId: refund.organizationId,
        recipient: order.buyerEmail,
        type: 'refund_processed',
        data: {
          eventTitle: event?.title ?? 'your event',
          amount: formatMoney(refund.amountMinor, refund.currency),
          refundId: refund.id,
        },
      });
    }
  });
}

async function reconcilePaymentByProviderId(providerPaymentId: string): Promise<void> {
  const provider = paymentProvider();

  try {
    const remote = await provider.getPayment(providerPaymentId);
    const [payment] = await db()
      .select()
      .from(payments)
      .where(eq(payments.providerPaymentId, providerPaymentId))
      .limit(1);

    if (!payment) return;

    const status =
      remote.amountRefundedMinor >= payment.amountMinor
        ? 'refunded'
        : remote.amountRefundedMinor > 0
          ? 'partially_refunded'
          : payment.status;

    await db().update(payments).set({ status }).where(eq(payments.id, payment.id));
  } catch (error) {
    console.error('Failed to reconcile payment from provider', { providerPaymentId, error });
  }
}

/**
 * Finds payments whose outcome is unknown and asks the provider what happened.
 *
 * This is the safety net for provider timeouts, abandoned checkouts that were
 * actually paid, delayed confirmations and amount mismatches.
 */
export async function reconcileUnresolvedPayments(
  options: { limit?: number; olderThanMinutes?: number } = {},
) {
  const limit = options.limit ?? 50;
  const olderThanMinutes = options.olderThanMinutes ?? 15;
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const provider = paymentProvider();

  const candidates = await db()
    .select({ payment: payments, order: orders })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(
      and(
        inArray(payments.status, ['created', 'authorized']),
        lt(payments.createdAt, cutoff),
        or(eq(orders.status, 'pending_payment'), eq(orders.status, 'expired')),
      ),
    )
    .orderBy(payments.createdAt)
    .limit(limit);

  const report = { checked: 0, recovered: 0, stillPending: 0, mismatched: 0, failed: 0 };

  for (const candidate of candidates) {
    report.checked += 1;

    try {
      const remote = await provider.getPayment(candidate.payment.providerPaymentId ?? '');

      if (remote.status === 'captured' || remote.status === 'authorized') {
        const outcome = await settleVerifiedPayment({
          order: candidate.order,
          payment: candidate.payment,
          providerPaymentId: remote.providerPaymentId,
          reportedAmountMinor: remote.amountMinor,
          reportedCurrency: remote.currency,
          status: remote.status,
          method: remote.method,
          source: 'reconciliation',
        });

        if (outcome.needsReconciliation) report.mismatched += 1;
        else report.recovered += 1;
      } else if (remote.status === 'failed') {
        await handlePaymentFailed({
          providerOrderId: candidate.payment.providerOrderId,
          providerPaymentId: remote.providerPaymentId,
          reason: remote.failureReason,
        });
        report.failed += 1;
      } else {
        report.stillPending += 1;
      }
    } catch (error) {
      // A payment with no provider id yet cannot be queried; it is not an error.
      if (error instanceof Error && error.message.includes('Unexpected')) {
        report.stillPending += 1;
        continue;
      }
      console.error('Payment reconciliation failed', {
        paymentId: candidate.payment.id,
        error,
      });
    }
  }

  return report;
}

export { settleVerifiedPayment, simulatedProvider };
