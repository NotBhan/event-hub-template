import type { APIRoute } from 'astro';
import { getEventForOrganization } from '@/features/events/service';
import { listAttendees } from '@/features/orders/service';
import { roleHasPermission } from '@/lib/permissions/guards';
import { ORDER_STATUS_LABELS, TICKET_STATUS_LABELS } from '@/lib/format';
import { formatMoney } from '@/lib/money';

/**
 * Attendee export.
 *
 * Generated on the server behind the same permission check as the page — the
 * export is not a client-side convenience that bypasses authorization. Only the
 * columns needed for door lists and reconciliation are included, and the response
 * is marked `no-store` so attendee data does not linger in caches.
 */

const MAX_ROWS = 5000;

/** Escapes a value for CSV, guarding against spreadsheet formula injection. */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);

  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;

  return `"${guarded.replace(/"/g, '""')}"`;
}

export const GET: APIRoute = async (ctx) => {
  const { user, membership } = ctx.locals;

  if (!user) {
    return new Response('Sign in to export attendee data', { status: 401 });
  }

  if (!membership || !roleHasPermission(membership.role, { attendee: ['export'] })) {
    return new Response('You do not have permission to export attendee data', { status: 403 });
  }

  const eventId = ctx.params.id;
  if (!eventId) return new Response('Missing event', { status: 400 });

  let event;
  try {
    event = await getEventForOrganization(eventId, membership.organizationId);
  } catch {
    // Same response for "does not exist" and "belongs to someone else".
    return new Response('Event not found', { status: 404 });
  }

  const rows = await listAttendees({ eventId: event.id, limit: MAX_ROWS });

  const header = [
    'Attendee name',
    'Attendee email',
    'Phone',
    'Ticket type',
    'Ticket reference',
    'Ticket status',
    'Order reference',
    'Order status',
    'Order total',
    'Currency',
  ];

  const lines = [header.map(csvCell).join(',')];

  for (const row of rows) {
    lines.push(
      [
        row.name,
        row.email,
        row.phone ?? '',
        row.ticketTypeName,
        row.ticketReference ?? '',
        row.ticketStatus ? (TICKET_STATUS_LABELS[row.ticketStatus] ?? row.ticketStatus) : 'Not issued',
        row.orderReference,
        ORDER_STATUS_LABELS[row.orderStatus] ?? row.orderStatus,
        formatMoney(row.orderTotalMinor, row.orderCurrency),
        row.orderCurrency,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  const filename = `${event.slug}-attendees-${new Date().toISOString().slice(0, 10)}.csv`;

  // A UTF-8 BOM keeps accented names intact when opened in Excel.
  return new Response(`\uFEFF${lines.join('\r\n')}\r\n`, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
};
