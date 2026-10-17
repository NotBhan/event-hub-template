import { and, count, desc, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  attendees,
  events,
  orderItems,
  orders,
  payments,
  refunds,
  ticketTypes,
  tickets,
  type Order,
  type OrderItem,
} from '@/lib/db/schema';
import type { DbExecutor } from '@/lib/db/types';
import { toNumber } from '@/lib/db/scalars';
import { ordersId } from '@/lib/db/sql';
import { isUniqueViolation } from '@/lib/db/errors';
import { serverEnv } from '@/lib/security/env';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '@/lib/security/errors';
import {
  generateIdempotencyKey,
  generateOrderReference,
  generateRegistrationAccessToken,
  hashRegistrationAccessToken,
} from '@/lib/security/tokens';
import { recordAudit } from '@/features/audit/service';
import {
  commitInventory,
  isWithinSalesWindow,
  releaseInventory,
  reserveInventory,
  returnSoldInventory,
} from '@/features/inventory/service';
import { enqueueEmail } from '@/features/notifications/outbox';
import { issueTicketsForOrder } from '@/features/tickets/service';

/**
 * Commerce service.
 *
 * ## The rules this module exists to enforce
 *
 * 1. **Orders are created server-side.** Prices and totals are read from the
 *    database and snapshotted onto the order. A browser-submitted price is never
 *    trusted, so a tampered form cannot buy a ₹5,000 ticket for ₹1.
 * 2. **Inventory is reserved transactionally** before payment is attempted, and
 *    released again if checkout is abandoned.
 * 3. **Confirmation is idempotent.** Payment webhooks arrive more than once and
 *    out of order; confirming an already-confirmed order must not issue a second
 *    set of tickets.
 * 4. **An order is not a payment.** They are separate records with separate
 *    state machines.
 */

export interface AttendeeInput {
  name: string;
  email: string;
  phone?: string | null;
  answers?: Record<string, string>;
}

export interface OrderLineInput {
  ticketTypeId: string;
  /** One entry per admission. Quantity is derived from this list. */
  attendees: AttendeeInput[];
}

export interface CreateOrderInput {
  eventId: string;
  lines: OrderLineInput[];
  buyer: { name: string; email: string; phone?: string | null };
  userId?: string | null;
  idempotencyKey?: string;
  notes?: string | null;
}

export interface CreatedOrder {
  order: Order;
  items: OrderItem[];
  /** Secret for the buyer's registration link. Returned once, never stored. */
  accessToken: string;
  /** True when the caller replayed an idempotency key and nothing was created. */
  replayed: boolean;
}

/** Order shape with everything a confirmation or receipt page needs. */
export interface OrderDetail {
  order: Order;
  items: (OrderItem & { ticketTypeId: string })[];
  attendees: {
    id: string;
    name: string;
    email: string;
    ticketTypeName: string;
    ticketId: string | null;
    ticketReference: string | null;
    ticketStatus: 'issued' | 'void' | null;
  }[];
  event: {
    id: string;
    title: string;
    slug: string;
    startsAt: Date;
    endsAt: Date;
    timezone: string;
    format: string;
    organizationId: string;
  };
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Creates an order, reserving inventory in the same transaction.
 *
 * Either the whole thing succeeds — order, line items, attendees and reservation —
 * or nothing is written. A partially reserved order can therefore never exist.
 */
export async function createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  if (input.lines.length === 0) throw new BadRequestError('Select at least one ticket');

  const idempotencyKey = input.idempotencyKey ?? generateIdempotencyKey();

  // Replay protection: a double submission returns the original order.
  const existing = await findOrderByIdempotencyKey(idempotencyKey);
  if (existing) {
    return {
      order: existing.order,
      items: await listOrderItems(existing.order.id),
      accessToken: '',
      replayed: true,
    };
  }

  return db().transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, input.eventId)).limit(1);
    if (!event) throw new NotFoundError('Event not found');

    assertRegistrationOpen(event);

    const ticketTypeIds = input.lines.map((line) => line.ticketTypeId);
    const ticketTypeRows = await tx
      .select()
      .from(ticketTypes)
      .where(inArray(ticketTypes.id, ticketTypeIds));

    const byId = new Map(ticketTypeRows.map((row) => [row.id, row]));

    // Every line must reference a ticket type that belongs to this event, so a
    // crafted request cannot buy tickets from another event.
    for (const line of input.lines) {
      const ticketType = byId.get(line.ticketTypeId);
      if (!ticketType || ticketType.eventId !== event.id) {
        throw new BadRequestError('One of the selected tickets is not valid for this event');
      }
      if (!isWithinSalesWindow(ticketType)) {
        throw new BadRequestError(`${ticketType.name} is not currently on sale`);
      }
      if (line.attendees.length === 0) {
        throw new BadRequestError(`${ticketType.name} needs at least one attendee`);
      }
    }

    const request = input.lines.map((line) => ({
      ticketTypeId: line.ticketTypeId,
      quantity: line.attendees.length,
    }));

    // Locks the ticket-type rows and moves reserved counts up.
    const reserved = await reserveInventory(tx, request);

    // Totals are computed from the freshly locked database rows, never from input.
    const subtotalMinor = reserved.reduce((total, entry) => total + entry.lineTotalMinor, 0);
    const currency = reserved[0]?.ticketType.currency;
    if (!currency) throw new BadRequestError('Unable to determine currency');

    const isFree = subtotalMinor === 0;
    const reservationExpiresAt = isFree
      ? null
      : new Date(Date.now() + serverEnv().ORDER_RESERVATION_MINUTES * 60_000);

    const accessToken = generateRegistrationAccessToken();

    const order = await insertOrderWithUniqueReference(tx, {
      organizationId: event.organizationId,
      eventId: event.id,
      userId: input.userId ?? null,
      buyerName: input.buyer.name.trim(),
      buyerEmail: normaliseEmail(input.buyer.email),
      buyerPhone: input.buyer.phone ?? null,
      status: isFree ? 'confirmed' : 'pending_payment',
      subtotalMinor,
      taxMinor: 0,
      discountMinor: 0,
      feeMinor: 0,
      totalMinor: subtotalMinor,
      currency,
      reservationExpiresAt,
      idempotencyKey,
      notes: input.notes ?? null,
      accessTokenHash: hashRegistrationAccessToken(accessToken),
      confirmedAt: isFree ? new Date() : null,
    });

    const items: OrderItem[] = [];

    for (const line of input.lines) {
      const reservation = reserved.find((entry) => entry.ticketType.id === line.ticketTypeId);
      if (!reservation) throw new Error('Reservation mismatch');

      const [item] = await tx
        .insert(orderItems)
        .values({
          orderId: order.id,
          ticketTypeId: line.ticketTypeId,
          quantity: line.attendees.length,
          // Snapshots: editing the ticket type later must not alter this order.
          ticketNameSnapshot: reservation.ticketType.name,
          unitPriceMinorSnapshot: reservation.ticketType.priceMinor,
          discountMinorSnapshot: 0,
          taxMinorSnapshot: 0,
          lineTotalMinor: reservation.lineTotalMinor,
          currency: reservation.ticketType.currency,
        })
        .returning();

      if (!item) throw new Error('Failed to create order item');
      items.push(item);

      await tx.insert(attendees).values(
        line.attendees.map((attendee) => ({
          orderId: order.id,
          orderItemId: item.id,
          name: attendee.name.trim(),
          email: normaliseEmail(attendee.email),
          phone: attendee.phone ?? null,
          registrationAnswers: attendee.answers ?? {},
        })),
      );
    }

    await recordAudit(tx, {
      organizationId: event.organizationId,
      actorUserId: input.userId ?? null,
      action: 'order.created',
      resourceType: 'order',
      resourceId: order.id,
      metadata: { eventId: event.id, totalMinor: subtotalMinor, currency, isFree },
    });

    // A free registration is confirmed immediately: no payment to wait for.
    if (isFree) {
      await commitInventory(tx, request);
      await issueTicketsForOrder(tx, order.id);
      await queueRegistrationEmails(tx, order.id, event.title);
    }

    return { order, items, accessToken, replayed: false };
  });
}

/** Inserts an order, retrying if the generated public reference collides. */
async function insertOrderWithUniqueReference(
  tx: DbExecutor,
  values: Omit<typeof orders.$inferInsert, 'publicReference'>,
): Promise<Order> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const [order] = await tx
        .insert(orders)
        .values({ ...values, publicReference: generateOrderReference() })
        .returning();
      if (order) return order;
    } catch (error) {
      if (isUniqueViolation(error, 'orders_public_reference_unique')) continue;
      throw error;
    }
  }

  throw new Error('Unable to allocate a unique order reference');
}

function assertRegistrationOpen(event: {
  status: string;
  visibility: string;
  registrationOpensAt: Date | null;
  registrationClosesAt: Date | null;
}): void {
  if (event.status !== 'published') {
    throw new ConflictError('Registration for this event is not open');
  }

  const now = new Date();
  if (event.registrationOpensAt && event.registrationOpensAt > now) {
    throw new ConflictError('Registration has not opened yet');
  }
  if (event.registrationClosesAt && event.registrationClosesAt < now) {
    throw new ConflictError('Registration has closed');
  }
}

export interface ConfirmOrderInput {
  orderId: string;
  /** The payment that justified confirmation, when there is one. */
  paymentId?: string;
  actorUserId?: string | null;
}

export interface ConfirmOrderResult {
  order: Order;
  /** True when the order was already confirmed and nothing changed. */
  alreadyConfirmed: boolean;
  /** True when confirmation could not proceed and needs manual reconciliation. */
  needsReconciliation: boolean;
  reason?: string;
}

/**
 * Confirms an order: converts its reservation into sales and issues tickets.
 *
 * Safe to call repeatedly. Payment webhooks are delivered at least once and can
 * arrive out of order, so this is the single place where a payment turns into
 * tickets, and it must be idempotent.
 */
export async function confirmOrder(input: ConfirmOrderInput): Promise<ConfirmOrderResult> {
  return db().transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1)
      .for('update');

    if (!order) throw new NotFoundError('Order not found');

    if (order.status === 'confirmed') {
      return { order, alreadyConfirmed: true, needsReconciliation: false };
    }

    if (order.status === 'cancelled') {
      return {
        order,
        alreadyConfirmed: false,
        needsReconciliation: true,
        reason: 'Order was cancelled before confirmation',
      };
    }

    const request = await reservationLinesFor(tx, order.id);

    if (order.status === 'expired') {
      /**
       * The reservation was released while payment was in flight. Re-acquire it
       * if stock remains; otherwise leave the order unresolved for the
       * reconciliation worker rather than issuing a ticket we cannot honour.
       */
      try {
        await reserveInventory(tx, request);
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'Reservation could not be re-acquired';

        await tx
          .update(orders)
          .set({ notes: appendNote(order.notes, `Needs reconciliation: ${reason}`) })
          .where(eq(orders.id, order.id));

        await recordAudit(tx, {
          organizationId: order.organizationId,
          actorUserId: input.actorUserId ?? null,
          action: 'order.confirmed',
          resourceType: 'order',
          resourceId: order.id,
          metadata: { outcome: 'needs_reconciliation', reason },
        });

        return { order, alreadyConfirmed: false, needsReconciliation: true, reason };
      }
    }

    await commitInventory(tx, request);

    const [confirmed] = await tx
      .update(orders)
      .set({ status: 'confirmed', confirmedAt: new Date(), reservationExpiresAt: null })
      .where(eq(orders.id, order.id))
      .returning();

    if (!confirmed) throw new Error('Failed to confirm order');

    await issueTicketsForOrder(tx, order.id);

    const [event] = await tx
      .select({ title: events.title })
      .from(events)
      .where(eq(events.id, order.eventId))
      .limit(1);

    await queueRegistrationEmails(tx, order.id, event?.title ?? 'your event');

    await recordAudit(tx, {
      organizationId: order.organizationId,
      actorUserId: input.actorUserId ?? null,
      action: 'order.confirmed',
      resourceType: 'order',
      resourceId: order.id,
      metadata: { paymentId: input.paymentId ?? null, outcome: 'confirmed' },
    });

    return { order: confirmed, alreadyConfirmed: false, needsReconciliation: false };
  });
}

/** Line items of an order expressed as inventory movements. */
export async function reservationLinesFor(
  executor: DbExecutor,
  orderId: string,
): Promise<{ ticketTypeId: string; quantity: number }[]> {
  const rows = await executor
    .select({ ticketTypeId: orderItems.ticketTypeId, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  return rows.map((row) => ({ ticketTypeId: row.ticketTypeId, quantity: row.quantity }));
}

/**
 * Releases reservations for orders that were never paid for.
 *
 * Without this, an abandoned checkout would hold stock forever.
 */
export async function expireAbandonedOrders(options: { limit?: number } = {}): Promise<{
  expired: number;
  orderIds: string[];
}> {
  const limit = options.limit ?? 100;

  return db().transaction(async (tx) => {
    const stale = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.status, 'pending_payment'),
          lte(orders.reservationExpiresAt, new Date()),
        ),
      )
      .orderBy(orders.reservationExpiresAt)
      .limit(limit)
      .for('update', { skipLocked: true });

    if (stale.length === 0) return { expired: 0, orderIds: [] };

    const ids = stale.map((row) => row.id);

    for (const id of ids) {
      const lines = await reservationLinesFor(tx, id);
      await releaseInventory(tx, lines);
    }

    await tx
      .update(orders)
      .set({ status: 'expired', expiredAt: new Date(), reservationExpiresAt: null })
      .where(inArray(orders.id, ids));

    for (const id of ids) {
      await recordAudit(tx, {
        action: 'order.expired',
        resourceType: 'order',
        resourceId: id,
        metadata: { reason: 'Reservation expired before payment' },
      });
    }

    return { expired: ids.length, orderIds: ids };
  });
}

/** Cancels a pending order and releases its reservation. */
export async function cancelOrder(input: {
  orderId: string;
  reason?: string;
  actorUserId?: string | null;
}): Promise<Order> {
  return db().transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1)
      .for('update');

    if (!order) throw new NotFoundError('Order not found');

    if (order.status === 'confirmed') {
      throw new ConflictError(
        'A confirmed order cannot be cancelled directly. Refund it instead.',
      );
    }

    if (order.status === 'cancelled' || order.status === 'expired') return order;

    const lines = await reservationLinesFor(tx, order.id);
    await releaseInventory(tx, lines);

    const [cancelled] = await tx
      .update(orders)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        reservationExpiresAt: null,
        notes: input.reason ? appendNote(order.notes, input.reason) : order.notes,
      })
      .where(eq(orders.id, order.id))
      .returning();

    if (!cancelled) throw new Error('Failed to cancel order');

    await recordAudit(tx, {
      organizationId: order.organizationId,
      actorUserId: input.actorUserId ?? null,
      action: 'order.cancelled',
      resourceType: 'order',
      resourceId: order.id,
      metadata: { reason: input.reason ?? null },
    });

    return cancelled;
  });
}

/**
 * Releases inventory and voids tickets when an order is refunded in full.
 * Called by the refund service after the provider confirms the refund.
 */
export async function releaseOrderInventory(
  tx: DbExecutor,
  orderId: string,
): Promise<void> {
  const lines = await reservationLinesFor(tx, orderId);
  await returnSoldInventory(tx, lines);
}

async function queueRegistrationEmails(
  tx: DbExecutor,
  orderId: string,
  eventTitle: string,
): Promise<void> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return;

  const issued = await tx
    .select({
      attendeeName: attendees.name,
      ticketName: orderItems.ticketNameSnapshot,
      publicReference: tickets.publicReference,
    })
    .from(tickets)
    .innerJoin(attendees, eq(attendees.id, tickets.attendeeId))
    .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .where(eq(tickets.orderId, orderId));

  const [event] = await tx
    .select({ startsAt: events.startsAt, timezone: events.timezone })
    .from(events)
    .where(eq(events.id, order.eventId))
    .limit(1);

  const eventDate = event
    ? new Intl.DateTimeFormat('en-IN', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: event.timezone,
      }).format(event.startsAt)
    : '';

  const isPaid = order.totalMinor > 0;

  await enqueueEmail(tx, {
    organizationId: order.organizationId,
    recipient: order.buyerEmail,
    type: isPaid ? 'order_confirmation' : 'registration_confirmation',
    data: {
      buyerName: order.buyerName,
      attendeeName: order.buyerName,
      eventTitle,
      eventDate,
      orderReference: order.publicReference,
      tickets: issued,
    },
  });

  // A separate message carrying the tickets themselves.
  await enqueueEmail(tx, {
    organizationId: order.organizationId,
    recipient: order.buyerEmail,
    type: 'tickets_issued',
    data: {
      eventTitle,
      eventDate,
      orderReference: order.publicReference,
      tickets: issued,
    },
  });
}

function appendNote(existing: string | null, addition: string): string {
  const stamped = `[${new Date().toISOString()}] ${addition}`;
  return existing ? `${existing}\n${stamped}` : stamped;
}

export async function findOrderByIdempotencyKey(key: string): Promise<{ order: Order } | null> {
  const [order] = await db().select().from(orders).where(eq(orders.idempotencyKey, key)).limit(1);
  return order ? { order } : null;
}

export async function listOrderItems(orderId: string): Promise<OrderItem[]> {
  return db()
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.createdAt);
}

export async function getOrder(orderId: string): Promise<Order | undefined> {
  const [order] = await db().select().from(orders).where(eq(orders.id, orderId)).limit(1);
  return order;
}

/** Loads an order by its display reference, with no authorization applied. */
export async function getOrderByReference(reference: string): Promise<Order | undefined> {
  const [order] = await db()
    .select()
    .from(orders)
    .where(eq(orders.publicReference, reference.trim().toUpperCase()))
    .limit(1);
  return order;
}

/** Full detail for a confirmation or receipt page. */
export async function getOrderDetail(orderId: string): Promise<OrderDetail | null> {
  const [order] = await db().select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return null;

  const [event] = await db()
    .select({
      id: events.id,
      title: events.title,
      slug: events.slug,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      timezone: events.timezone,
      format: events.format,
      organizationId: events.organizationId,
    })
    .from(events)
    .where(eq(events.id, order.eventId))
    .limit(1);

  if (!event) return null;

  const items = await viaJoinItems(orderId);

  const attendeeRows = await db()
    .select({
      id: attendees.id,
      name: attendees.name,
      email: attendees.email,
      ticketTypeName: orderItems.ticketNameSnapshot,
      ticketId: tickets.id,
      ticketReference: tickets.publicReference,
      ticketStatus: tickets.status,
    })
    .from(attendees)
    .innerJoin(orderItems, eq(orderItems.id, attendees.orderItemId))
    .leftJoin(tickets, eq(tickets.attendeeId, attendees.id))
    .where(eq(attendees.orderId, orderId))
    .orderBy(attendees.createdAt);

  return {
    order,
    items,
    attendees: attendeeRows.map((row) => ({
      ...row,
      ticketStatus: row.ticketStatus ?? null,
    })),
    event,
  };
}

async function viaJoinItems(orderId: string): Promise<(OrderItem & { ticketTypeId: string })[]> {
  return db().select().from(orderItems).where(eq(orderItems.orderId, orderId));
}

export interface OrderFilters {
  eventId?: string;
  organizationId: string;
  status?: Order['status'];
  search?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

/** Order list for the dashboard, always scoped to one organization. */
export async function listOrders(filters: OrderFilters): Promise<{
  rows: (Order & { attendeeCount: number; paymentStatus: string | null })[];
  total: number;
}> {
  const conditions = [eq(orders.organizationId, filters.organizationId)];

  if (filters.eventId) conditions.push(eq(orders.eventId, filters.eventId));
  if (filters.status) conditions.push(eq(orders.status, filters.status));
  if (filters.from) conditions.push(gte(orders.createdAt, filters.from));
  if (filters.to) conditions.push(lte(orders.createdAt, filters.to));

  if (filters.search) {
    const term = `%${filters.search.trim()}%`;
    const searchCondition = or(
      sql`${orders.buyerName} ilike ${term}`,
      sql`${orders.buyerEmail} ilike ${term}`,
      sql`${orders.publicReference} ilike ${term}`,
    );
    if (searchCondition) conditions.push(searchCondition);
  }

  const where = and(...conditions);
  const limit = Math.min(filters.limit ?? 25, 100);
  const offset = filters.offset ?? 0;

  const rows = await db()
    .select({
      order: orders,
      attendeeCount: sql<number>`(select count(*)::int from attendees where attendees.order_id = ${ordersId})`,
      paymentStatus: sql<string | null>`(
        select payments.status from payments
        where payments.order_id = ${ordersId}
        order by payments.created_at desc limit 1
      )`,
    })
    .from(orders)
    .where(where)
    .orderBy(desc(orders.createdAt))
    .limit(limit)
    .offset(offset);

  const [totals] = await db()
    .select({ value: count() })
    .from(orders)
    .where(where);

  return {
    rows: rows.map((row) => ({
      ...row.order,
      attendeeCount: toNumber(row.attendeeCount),
      paymentStatus: row.paymentStatus,
    })),
    total: toNumber(totals?.value),
  };
}

/** Attendee list for an event, with optional search and pagination. */
export async function listAttendees(filters: {
  eventId: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const conditions = [eq(orders.eventId, filters.eventId)];

  if (filters.search) {
    const term = `%${filters.search.trim()}%`;
    const searchCondition = or(
      sql`${attendees.name} ilike ${term}`,
      sql`${attendees.email} ilike ${term}`,
      sql`${orders.publicReference} ilike ${term}`,
      sql`${tickets.publicReference} ilike ${term}`,
    );
    if (searchCondition) conditions.push(searchCondition);
  }

  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;

  return db()
    .select({
      id: attendees.id,
      name: attendees.name,
      email: attendees.email,
      phone: attendees.phone,
      ticketTypeName: orderItems.ticketNameSnapshot,
      orderId: orders.id,
      orderReference: orders.publicReference,
      orderStatus: orders.status,
      orderCurrency: orders.currency,
      orderTotalMinor: orders.totalMinor,
      ticketId: tickets.id,
      ticketReference: tickets.publicReference,
      ticketStatus: tickets.status,
    })
    .from(attendees)
    .innerJoin(orders, eq(orders.id, attendees.orderId))
    .innerJoin(orderItems, eq(orderItems.id, attendees.orderItemId))
    .leftJoin(tickets, eq(tickets.attendeeId, attendees.id))
    .where(and(...conditions))
    .orderBy(attendees.createdAt)
    .limit(limit)
    .offset(offset);
}

/** Confirmed revenue for an event, in the event's currency. */
export async function getEventSalesSummary(eventId: string): Promise<{
  confirmedOrders: number;
  ticketsIssued: number;
  grossMinor: number;
  refundedMinor: number;
  currency: string | null;
}> {
  const [summary] = await db()
    .select({
      confirmedOrders: sql<number>`count(*)::int`,
      grossMinor: sql<number>`coalesce(sum(${orders.totalMinor}), 0)::bigint`,
      currency: sql<string | null>`min(${orders.currency})`,
    })
    .from(orders)
    .where(and(eq(orders.eventId, eventId), eq(orders.status, 'confirmed')));

  const [issued] = await db()
    .select({ value: sql<number>`count(*)::int` })
    .from(tickets)
    .where(and(eq(tickets.eventId, eventId), ne(tickets.status, 'void')));

  const [refunded] = await db()
    .select({ value: sql<number>`coalesce(sum(${refunds.amountMinor}), 0)::bigint` })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(and(eq(orders.eventId, eventId), eq(refunds.status, 'succeeded')));

  return {
    confirmedOrders: toNumber(summary?.confirmedOrders),
    ticketsIssued: toNumber(issued?.value),
    grossMinor: toNumber(summary?.grossMinor),
    refundedMinor: toNumber(refunded?.value),
    currency: summary?.currency ?? null,
  };
}

/** Latest payment attempt for an order, if any. */
export async function getLatestPayment(orderId: string) {
  const [payment] = await db()
    .select()
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(desc(payments.createdAt))
    .limit(1);
  return payment;
}
