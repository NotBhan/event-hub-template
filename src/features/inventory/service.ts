import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { ticketTypes, type TicketType } from '@/lib/db/schema';
import type { DbExecutor } from '@/lib/db/types';
import { BadRequestError, ConflictError, NotFoundError, SoldOutError } from '@/lib/security/errors';

/**
 * Inventory service.
 *
 * This is the module that makes overselling impossible. Two mechanisms work
 * together:
 *
 *  1. Reservations lock the ticket-type row (`SELECT ... FOR UPDATE`) so
 *     concurrent checkouts are serialized rather than racing.
 *  2. The database itself carries a check constraint asserting
 *     `sold + reserved <= total`, so even a bug in this file cannot corrupt
 *     capacity.
 *
 * Counters move through an explicit lifecycle:
 *
 *     reserve()  → available decreases (reserved increases)
 *     release()  → available increases again (abandoned checkout, expiry)
 *     commit()   → reserved becomes sold (payment confirmed)
 */

export function availableQuantity(
  ticketType: Pick<TicketType, 'quantityTotal' | 'quantitySold' | 'quantityReserved'>,
): number {
  return ticketType.quantityTotal - ticketType.quantitySold - ticketType.quantityReserved;
}

/** Whether a ticket type can currently be sold, ignoring stock levels. */
export function isWithinSalesWindow(
  ticketType: Pick<TicketType, 'isActive' | 'salesStartAt' | 'salesEndAt'>,
  now = new Date(),
): boolean {
  if (!ticketType.isActive) return false;
  if (ticketType.salesStartAt && ticketType.salesStartAt > now) return false;
  if (ticketType.salesEndAt && ticketType.salesEndAt < now) return false;
  return true;
}

/**
 * Locks ticket-type rows for update and returns them.
 *
 * Rows are locked in a deterministic order (by id) because two concurrent orders
 * that both touch ticket types A and B would otherwise deadlock when they lock
 * them in opposite orders.
 */
async function lockTicketTypes(
  tx: DbExecutor,
  ticketTypeIds: string[],
): Promise<Map<string, TicketType>> {
  const ordered = [...ticketTypeIds].sort();
  if (ordered.length === 0) return new Map();

  const rows = await tx
    .select()
    .from(ticketTypes)
    .where(inArray(ticketTypes.id, ordered))
    .orderBy(ticketTypes.id)
    .for('update');

  return new Map(rows.map((row) => [row.id, row]));
}

export interface ReservationLine {
  ticketTypeId: string;
  quantity: number;
}

/**
 * Reserves inventory for a pending order.
 *
 * Must be called inside a transaction. Throws `SoldOutError` when any line cannot
 * be satisfied — the caller's transaction then rolls back, so a partially
 * reserved order never exists.
 */
export async function reserveInventory(
  tx: DbExecutor,
  lines: readonly ReservationLine[],
): Promise<{ ticketType: TicketType; quantity: number; lineTotalMinor: number }[]> {
  const locked = await lockTicketTypes(
    tx,
    lines.map((line) => line.ticketTypeId),
  );

  const resolved: { ticketType: TicketType; quantity: number; lineTotalMinor: number }[] = [];

  for (const line of lines) {
    const ticketType = locked.get(line.ticketTypeId);

    if (!ticketType) throw new NotFoundError(`Ticket type ${line.ticketTypeId} does not exist`);

    if (line.quantity < ticketType.minPerOrder || line.quantity > ticketType.maxPerOrder) {
      throw new BadRequestError(
        `${ticketType.name} allows between ${ticketType.minPerOrder} and ${ticketType.maxPerOrder} tickets per order`,
      );
    }

    const available = availableQuantity(ticketType);
    if (available < line.quantity) {
      throw new SoldOutError(
        available === 0
          ? `${ticketType.name} is sold out`
          : `Only ${available} ${ticketType.name} ticket${available === 1 ? '' : 's'} left`,
      );
    }

    resolved.push({
      ticketType,
      quantity: line.quantity,
      lineTotalMinor: ticketType.priceMinor * line.quantity,
    });
  }

  // Apply the increments only after every line has been validated, so validation
  // failures never leave partial reservations behind.
  for (const entry of resolved) {
    await tx
      .update(ticketTypes)
      .set({ quantityReserved: sql`${ticketTypes.quantityReserved} + ${entry.quantity}` })
      .where(eq(ticketTypes.id, entry.ticketType.id));
  }

  return resolved;
}

/** Returns reserved stock to availability. Used by expiry and cancellation. */
export async function releaseInventory(
  tx: DbExecutor,
  lines: readonly ReservationLine[],
): Promise<void> {
  for (const line of lines) {
    await tx
      .update(ticketTypes)
      .set({
        // `greatest` guards against ever driving a counter negative.
        quantityReserved: sql`greatest(${ticketTypes.quantityReserved} - ${line.quantity}, 0)`,
      })
      .where(eq(ticketTypes.id, line.ticketTypeId));
  }
}

/**
 * Converts a reservation into a sale. Called only after payment is confirmed.
 *
 * Reserved decreases and sold increases in the same statement, so the capacity
 * constraint holds throughout.
 */
export async function commitInventory(
  tx: DbExecutor,
  lines: readonly ReservationLine[],
): Promise<void> {
  for (const line of lines) {
    await tx
      .update(ticketTypes)
      .set({
        quantityReserved: sql`greatest(${ticketTypes.quantityReserved} - ${line.quantity}, 0)`,
        quantitySold: sql`${ticketTypes.quantitySold} + ${line.quantity}`,
      })
      .where(eq(ticketTypes.id, line.ticketTypeId));
  }
}

/**
 * Returns tickets to availability after a refund or void.
 *
 * Deliberately does not resurrect a reservation: a refunded ticket becomes
 * purchasable stock again, which is the behaviour the spec asks for.
 */
export async function returnSoldInventory(
  tx: DbExecutor,
  lines: readonly ReservationLine[],
): Promise<void> {
  for (const line of lines) {
    await tx
      .update(ticketTypes)
      .set({ quantitySold: sql`greatest(${ticketTypes.quantitySold} - ${line.quantity}, 0)` })
      .where(eq(ticketTypes.id, line.ticketTypeId));
  }
}

/** Inventory position for one ticket type, re-read inside a transaction. */
export async function getTicketType(
  executor: DbExecutor,
  ticketTypeId: string,
  options: { forUpdate?: boolean } = {},
): Promise<TicketType | undefined> {
  const query = executor
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.id, ticketTypeId))
    .limit(1);
  const rows = options.forUpdate ? await query.for('update') : await query;
  return rows[0];
}

/** All ticket types for an event, in display order. */
export async function listTicketTypes(eventId: string): Promise<TicketType[]> {
  return db()
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId))
    .orderBy(ticketTypes.sortOrder, ticketTypes.createdAt);
}

/** Ticket types that are currently purchasable, for the public event page. */
export async function listSellableTicketTypes(
  eventId: string,
): Promise<(TicketType & { available: number })[]> {
  const rows = await listTicketTypes(eventId);
  const now = new Date();

  return rows
    .filter((row) => isWithinSalesWindow(row, now) && availableQuantity(row) > 0)
    .map((row) => ({ ...row, available: availableQuantity(row) }));
}

export interface TicketTypeInput {
  name: string;
  description?: string | null;
  priceMinor: number;
  currency: string;
  quantityTotal: number;
  minPerOrder?: number;
  maxPerOrder?: number;
  salesStartAt?: Date | null;
  salesEndAt?: Date | null;
  isActive?: boolean;
  sortOrder?: number;
}

export async function createTicketType(
  executor: DbExecutor,
  eventId: string,
  input: TicketTypeInput,
): Promise<TicketType> {
  if (input.quantityTotal < 0) throw new BadRequestError('Capacity cannot be negative');
  if (input.priceMinor < 0) throw new BadRequestError('Price cannot be negative');

  const min = input.minPerOrder ?? 1;
  const max = input.maxPerOrder ?? 10;
  if (min < 1) throw new BadRequestError('The minimum per order must be at least 1');
  if (max < min)
    throw new BadRequestError('The maximum per order cannot be lower than the minimum');

  const [row] = await executor
    .insert(ticketTypes)
    .values({
      eventId,
      name: input.name,
      description: input.description ?? null,
      priceMinor: input.priceMinor,
      currency: input.currency,
      quantityTotal: input.quantityTotal,
      minPerOrder: min,
      maxPerOrder: max,
      salesStartAt: input.salesStartAt ?? null,
      salesEndAt: input.salesEndAt ?? null,
      isActive: input.isActive ?? true,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();

  if (!row) throw new Error('Failed to create ticket type');
  return row;
}

/**
 * Updates a ticket type.
 *
 * Capacity may not be reduced below what is already sold or reserved: doing so
 * would break the invariant for orders that already exist.
 */
export async function updateTicketType(
  executor: DbExecutor,
  ticketTypeId: string,
  input: Partial<TicketTypeInput>,
): Promise<TicketType> {
  const existing = await getTicketType(executor, ticketTypeId, { forUpdate: true });
  if (!existing) throw new NotFoundError('Ticket type not found');

  if (input.quantityTotal !== undefined) {
    const committed = existing.quantitySold + existing.quantityReserved;
    if (input.quantityTotal < committed) {
      throw new ConflictError(
        `Capacity cannot be reduced below the ${committed} tickets already sold or reserved`,
      );
    }
  }

  if (input.priceMinor !== undefined && input.priceMinor < 0) {
    throw new BadRequestError('Price cannot be negative');
  }

  const min = input.minPerOrder ?? existing.minPerOrder;
  const max = input.maxPerOrder ?? existing.maxPerOrder;
  if (max < min)
    throw new BadRequestError('The maximum per order cannot be lower than the minimum');

  const [row] = await executor
    .update(ticketTypes)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priceMinor !== undefined ? { priceMinor: input.priceMinor } : {}),
      ...(input.quantityTotal !== undefined ? { quantityTotal: input.quantityTotal } : {}),
      minPerOrder: min,
      maxPerOrder: max,
      ...(input.salesStartAt !== undefined ? { salesStartAt: input.salesStartAt } : {}),
      ...(input.salesEndAt !== undefined ? { salesEndAt: input.salesEndAt } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    })
    .where(eq(ticketTypes.id, ticketTypeId))
    .returning();

  if (!row) throw new Error('Failed to update ticket type');
  return row;
}

/** Removes a ticket type only if nothing has ever been sold against it. */
export async function deleteTicketType(executor: DbExecutor, ticketTypeId: string): Promise<void> {
  const existing = await getTicketType(executor, ticketTypeId, { forUpdate: true });
  if (!existing) throw new NotFoundError('Ticket type not found');

  if (existing.quantitySold > 0 || existing.quantityReserved > 0) {
    throw new ConflictError(
      'This ticket type has sales against it and cannot be deleted. Deactivate it instead.',
    );
  }

  await executor.delete(ticketTypes).where(eq(ticketTypes.id, ticketTypeId));
}

/** Aggregate availability across an event, for badges and sold-out messaging. */
export async function getEventAvailability(eventId: string): Promise<{
  totalRemaining: number;
  hasSellableTickets: boolean;
  cheapestPriceMinor: number | null;
  currency: string | null;
}> {
  const rows = await listTicketTypes(eventId);
  const now = new Date();

  let totalRemaining = 0;
  let cheapestPriceMinor: number | null = null;
  let currency: string | null = null;

  for (const row of rows) {
    if (!isWithinSalesWindow(row, now)) continue;
    const available = availableQuantity(row);
    if (available <= 0) continue;

    totalRemaining += available;
    if (cheapestPriceMinor === null || row.priceMinor < cheapestPriceMinor) {
      cheapestPriceMinor = row.priceMinor;
      currency = row.currency;
    }
  }

  return {
    totalRemaining,
    hasSellableTickets: totalRemaining > 0,
    cheapestPriceMinor,
    currency,
  };
}

/** True when at least one ticket type exists that is free. */
export async function hasFreeTicketType(eventId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: ticketTypes.id })
    .from(ticketTypes)
    .where(and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.priceMinor, 0)))
    .limit(1);

  return Boolean(row);
}
