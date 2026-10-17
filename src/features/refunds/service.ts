import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  attendees,
  events,
  orderItems,
  orders,
  payments,
  refundItems,
  refunds,
  tickets,
  type Payment,
  type Refund,
} from '@/lib/db/schema';
import type { DbExecutor } from '@/lib/db/types';
import { toNumber } from '@/lib/db/scalars';
import { formatMoney } from '@/lib/money';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@/lib/security/errors';
import { recordAudit } from '@/features/audit/service';
import { paymentProvider, PaymentProviderError } from '@/features/payments/providers';
import { finaliseRefund } from '@/features/payments/service';
import { listTicketsForAttendees } from '@/features/tickets/service';

/**
 * Refunds service.
 *
 * ## The rule that matters
 *
 * A refund must never exceed the remaining refundable amount, *including when two
 * staff members click refund at the same moment*. That is enforced by locking the
 * payment row before computing the balance: the second request waits, re-reads
 * the balance, and is rejected if the money is already committed.
 *
 * Refund states are `requested → pending → succeeded | failed`. A pending refund
 * is displayed distinctly from a successful one, because the provider has not
 * necessarily moved the money yet.
 */

export interface RequestRefundInput {
  orderId: string;
  /** Omit for a full refund. */
  amountMinor?: number;
  /** Restrict the refund to particular tickets. Omit for the whole order. */
  ticketIds?: string[];
  reason: string;
  notes?: string | null;
  actorUserId?: string | null;
  organizationId: string;
}

export interface RefundRequestResult {
  refund: Refund;
  payment: Payment;
  /** True when the provider has already confirmed the refund. */
  settled: boolean;
}

/** How much of a payment can still be refunded. */
export async function refundableBalance(
  executor: DbExecutor,
  paymentId: string,
): Promise<{ refundableMinor: number; alreadyRefundedMinor: number; currency: string }> {
  const [payment] = await executor
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!payment) throw new NotFoundError('Payment not found');

  /**
   * Refunds that are requested, pending or succeeded all hold a claim on the
   * money. Only failed ones release it.
   */
  const [aggregate] = await executor
    .select({ total: sql<number>`coalesce(sum(${refunds.amountMinor}), 0)::bigint` })
    .from(refunds)
    .where(
      and(
        eq(refunds.paymentId, paymentId),
        inArray(refunds.status, ['requested', 'pending', 'succeeded']),
      ),
    );

  const committed = toNumber(aggregate?.total);

  return {
    refundableMinor: Math.max(payment.amountMinor - committed, 0),
    alreadyRefundedMinor: committed,
    currency: payment.currency,
  };
}

/**
 * Raises a refund against a captured payment.
 *
 * Order of operations is deliberate: validate, reserve the balance under a row
 * lock, record the request, *then* call the provider. If the provider call fails,
 * the local record stays in `requested` state for an operator to retry rather
 * than silently losing the intent.
 */
export async function requestRefund(input: RequestRefundInput): Promise<RefundRequestResult> {
  const prepared = await db().transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);

    if (!order) throw new NotFoundError('Order not found');

    // The caller's organization must own this order. A hard-to-guess id is not
    // access control, so ownership is checked explicitly.
    if (order.organizationId !== input.organizationId) {
      throw new ForbiddenError('This order belongs to another organization');
    }

    if (order.status !== 'confirmed') {
      throw new ConflictError('Only confirmed orders can be refunded');
    }

    const [event] = await tx
      .select({
        refundPolicy: events.refundPolicy,
        refundableUntil: events.refundableUntil,
        refundPolicyNotes: events.refundPolicyNotes,
        title: events.title,
      })
      .from(events)
      .where(eq(events.id, order.eventId))
      .limit(1);

    if (event) assertPolicyPermitsRefund(event, input.ticketIds?.length ?? 0);

    // The payment row is locked so concurrent refund requests serialize here.
    const [payment] = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.orderId, order.id),
          inArray(payments.status, ['captured', 'partially_refunded']),
        ),
      )
      .orderBy(desc(payments.createdAt))
      .limit(1)
      .for('update');

    if (!payment) {
      throw new ConflictError('This order has no captured payment to refund');
    }

    const balance = await refundableBalance(tx, payment.id);

    if (balance.refundableMinor <= 0) {
      throw new ConflictError('This payment has already been fully refunded');
    }

    let amountMinor = input.amountMinor ?? balance.refundableMinor;

    // Ticket-scoped refunds are priced from the tickets actually covered.
    let coveredTicketIds: string[] = [];
    let coveredOrderItemIds: string[] = [];

    if (input.ticketIds && input.ticketIds.length > 0) {
      const ticketRows = await tx
        .select({
          ticketId: tickets.id,
          attendeeId: tickets.attendeeId,
          orderItemId: tickets.orderItemId,
          status: tickets.status,
        })
        .from(tickets)
        .where(and(eq(tickets.orderId, order.id), inArray(tickets.id, input.ticketIds)));

      if (ticketRows.length !== input.ticketIds.length) {
        throw new BadRequestError('One or more tickets do not belong to this order');
      }

      const voidable = ticketRows.filter((row) => row.status === 'issued');
      if (voidable.length === 0) {
        throw new ConflictError('The selected tickets are already void');
      }

      coveredTicketIds = voidable.map((row) => row.ticketId);
      coveredOrderItemIds = [...new Set(voidable.map((row) => row.orderItemId))];

      if (input.amountMinor === undefined) {
        amountMinor = await priceTickets(tx, coveredTicketIds);
      }
    }

    if (amountMinor <= 0) throw new BadRequestError('The refund amount must be greater than zero');

    if (amountMinor > balance.refundableMinor) {
      throw new ConflictError(
        `Only ${formatMoney(balance.refundableMinor, payment.currency)} remains refundable on this payment`,
      );
    }

    const [refund] = await tx
      .insert(refunds)
      .values({
        organizationId: order.organizationId,
        paymentId: payment.id,
        orderId: order.id,
        amountMinor,
        currency: payment.currency,
        reason: input.reason,
        notes: input.notes ?? null,
        requestedBy: input.actorUserId ?? null,
        status: 'requested',
      })
      .returning();

    if (!refund) throw new Error('Failed to record the refund request');

    if (coveredTicketIds.length > 0) {
      await tx.insert(refundItems).values(
        coveredTicketIds.map((ticketId) => ({
          refundId: refund.id,
          ticketId,
          amountMinor: 0,
        })),
      );
    } else if (coveredOrderItemIds.length > 0) {
      await tx.insert(refundItems).values(
        coveredOrderItemIds.map((orderItemId) => ({
          refundId: refund.id,
          orderItemId,
          amountMinor: 0,
        })),
      );
    }

    await recordAudit(tx, {
      organizationId: order.organizationId,
      actorUserId: input.actorUserId ?? null,
      action: 'refund.requested',
      resourceType: 'refund',
      resourceId: refund.id,
      metadata: {
        orderId: order.id,
        amountMinor,
        currency: payment.currency,
        ticketCount: coveredTicketIds.length,
      },
    });

    return { refund, payment, coveredTicketIds };
  });

  // Provider submission happens outside the transaction: a slow gateway must not
  // hold a database lock, and a provider outage must not roll back the request.
  return submitRefundToProvider(prepared.refund, prepared.payment, input);
}

async function submitRefundToProvider(
  refund: Refund,
  payment: Payment,
  input: RequestRefundInput,
): Promise<RefundRequestResult> {
  const provider = paymentProvider();

  if (!payment.providerPaymentId) {
    await db()
      .update(refunds)
      .set({ status: 'failed', failureReason: 'The payment has no provider reference yet' })
      .where(eq(refunds.id, refund.id));

    return { refund: { ...refund, status: 'failed' }, payment, settled: false };
  }

  try {
    const providerRefund = await provider.refund({
      providerPaymentId: payment.providerPaymentId,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
      reason: input.reason,
      notes: { orderId: refund.orderId, refundId: refund.id },
    });

    const [updated] = await db()
      .update(refunds)
      .set({
        providerRefundId: providerRefund.providerRefundId,
        status: providerRefund.status === 'succeeded' ? 'pending' : providerRefund.status,
        failureReason: providerRefund.failureReason ?? null,
      })
      .where(eq(refunds.id, refund.id))
      .returning();

    /**
     * Some gateways settle synchronously. When they do, the refund is finalised
     * immediately; otherwise it stays `pending` until its webhook arrives.
     */
    if (providerRefund.status === 'succeeded') {
      await finaliseRefund(refund.id);
      const [final] = await db().select().from(refunds).where(eq(refunds.id, refund.id)).limit(1);
      return { refund: final ?? updated ?? refund, payment, settled: true };
    }

    if (providerRefund.status === 'failed') {
      await db()
        .update(refunds)
        .set({ status: 'failed', failureReason: providerRefund.failureReason ?? 'Rejected' })
        .where(eq(refunds.id, refund.id));
    }

    return { refund: updated ?? refund, payment, settled: false };
  } catch (error) {
    const message =
      error instanceof PaymentProviderError ? error.message : 'Refund submission failed';

    // Left in `requested` state on purpose: the intent is recorded and an
    // operator can retry, rather than the request vanishing.
    await db().update(refunds).set({ failureReason: message }).where(eq(refunds.id, refund.id));

    console.error('Refund submission failed', { refundId: refund.id, error });
    return { refund: { ...refund, failureReason: message }, payment, settled: false };
  }
}

/** Sums the price of specific tickets from their order-item snapshots. */
async function priceTickets(executor: DbExecutor, ticketIds: string[]): Promise<number> {
  if (ticketIds.length === 0) return 0;

  const rows = await executor
    .select({
      unitPriceMinor: orderItems.unitPriceMinorSnapshot,
      orderItemId: orderItems.id,
    })
    .from(tickets)
    .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .where(inArray(tickets.id, ticketIds));

  return rows.reduce((total, row) => total + row.unitPriceMinor, 0);
}

function assertPolicyPermitsRefund(
  event: {
    refundPolicy: 'no_refunds' | 'refundable_until_start' | 'refundable_until_date' | 'custom';
    refundableUntil: Date | null;
    refundPolicyNotes: string | null;
  },
  ticketCount: number,
): void {
  if (event.refundPolicy === 'no_refunds') {
    throw new ConflictError(event.refundPolicyNotes ?? 'This event does not allow refunds');
  }

  if (event.refundPolicy === 'custom' && ticketCount === 0) {
    throw new ConflictError(
      event.refundPolicyNotes ??
        'This event handles refunds manually. Request a ticket-specific refund.',
    );
  }

  if (event.refundableUntil && new Date() > event.refundableUntil) {
    throw new ConflictError(
      `The refund window for this event closed on ${event.refundableUntil.toISOString().slice(0, 10)}`,
    );
  }
}

/** Refunds raised against an order, newest first. */
export async function listRefundsForOrder(orderId: string) {
  return db()
    .select()
    .from(refunds)
    .where(eq(refunds.orderId, orderId))
    .orderBy(desc(refunds.createdAt));
}

/** Refund queue for the dashboard, scoped to one organization. */
export async function listRefunds(filters: {
  organizationId: string;
  status?: Refund['status'];
  eventId?: string;
  limit?: number;
}) {
  const conditions = [eq(refunds.organizationId, filters.organizationId)];
  if (filters.status) conditions.push(eq(refunds.status, filters.status));
  if (filters.eventId) conditions.push(eq(orders.eventId, filters.eventId));

  return db()
    .select({
      refund: refunds,
      orderReference: orders.publicReference,
      buyerName: orders.buyerName,
      buyerEmail: orders.buyerEmail,
      eventTitle: events.title,
      eventId: events.id,
    })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .innerJoin(events, eq(events.id, orders.eventId))
    .where(and(...conditions))
    .orderBy(desc(refunds.createdAt))
    .limit(Math.min(filters.limit ?? 50, 200));
}

/** Tickets an operator could still refund, with their price, for the refund form. */
export async function listRefundableTickets(orderId: string) {
  return db()
    .select({
      ticketId: tickets.id,
      publicReference: tickets.publicReference,
      status: tickets.status,
      attendeeName: attendees.name,
      ticketTypeName: orderItems.ticketNameSnapshot,
      priceMinor: orderItems.unitPriceMinorSnapshot,
      currency: orderItems.currency,
    })
    .from(tickets)
    .innerJoin(attendees, eq(attendees.id, tickets.attendeeId))
    .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .where(and(eq(tickets.orderId, orderId), eq(tickets.status, 'issued')))
    .orderBy(attendees.name);
}

/** Re-derives which tickets a refund covers, for display. */
export async function listRefundItems(refundId: string) {
  const rows = await db()
    .select({
      ticketId: refundItems.ticketId,
      orderItemId: refundItems.orderItemId,
      amountMinor: refundItems.amountMinor,
    })
    .from(refundItems)
    .where(eq(refundItems.refundId, refundId));

  const ticketIds = rows.map((row) => row.ticketId).filter((id): id is string => Boolean(id));
  if (ticketIds.length === 0) return [];

  const ticketRows = await db()
    .select({
      ticketId: tickets.id,
      publicReference: tickets.publicReference,
      attendeeName: attendees.name,
    })
    .from(tickets)
    .innerJoin(attendees, eq(attendees.id, tickets.attendeeId))
    .where(inArray(tickets.id, ticketIds));

  const byId = new Map(ticketRows.map((row) => [row.ticketId, row]));

  return ticketIds.map((id) => ({
    ticketId: id,
    publicReference: byId.get(id)?.publicReference ?? 'unknown',
    attendeeName: byId.get(id)?.attendeeName ?? 'unknown',
  }));
}

export { listTicketsForAttendees };
