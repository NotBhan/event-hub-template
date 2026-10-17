import { sql, type SQL } from 'drizzle-orm';

/**
 * A fully qualified column reference for correlated subqueries.
 *
 * Drizzle renders an interpolated column as a *bare* identifier unless a join in
 * the query would make it ambiguous. That is fine at the top level, but inside a
 * correlated subquery it is a trap:
 *
 *     select "events".*, (
 *       select sum(quantity_sold) from ticket_types
 *       where ticket_types.event_id = "id"        -- binds to ticket_types.id!
 *     ) from "events"
 *
 * The subquery's own table is nearer in scope, so `"id"` resolves to
 * `ticket_types.id`. The correlation matches nothing, `coalesce` supplies zero,
 * and every aggregate silently reads as 0 — with no error to notice.
 *
 * Referencing the column through this helper renders `"events"."id"`, which
 * resolves the way the query intends regardless of what else is in scope.
 */
export function qualifiedColumn(table: string, column: string): SQL {
  return sql.raw(`"${table}"."${column}"`);
}

/** Qualified event id, for subqueries that correlate back to `events`. */
export const eventsId = qualifiedColumn('events', 'id');

/** Qualified order id, for subqueries that correlate back to `orders`. */
export const ordersId = qualifiedColumn('orders', 'id');
