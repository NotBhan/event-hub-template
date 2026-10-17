/**
 * DEVELOPMENT TOOL — prints admission codes so the scanner can be tested without
 * a camera or a printer.
 *
 * This deliberately exposes a credential that normally only exists inside a QR
 * code, so it refuses to run outside development. Never wire this into a
 * deployment, a cron job or an admin screen.
 *
 * Usage: npx tsx scripts/dev-ticket-code.ts <event-slug> [count]
 */
import '../src/lib/security/load-env';
import { eq } from 'drizzle-orm';
import { closeDatabase, db } from '../src/lib/db/client';
import { attendees, events, orderItems, tickets } from '../src/lib/db/schema';
import { tokenForTicket } from '../src/features/tickets/service';
import { serverEnv } from '../src/lib/security/env';

async function main() {
  const env = serverEnv();

  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to print ticket credentials in a production environment.');
  }

  const slug = process.argv[2] ?? 'frontier-2026';
  const count = Math.min(Number(process.argv[3] ?? 3) || 3, 20);

  const [event] = await db().select().from(events).where(eq(events.slug, slug)).limit(1);
  if (!event) throw new Error(`No event with slug "${slug}"`);

  const rows = await db()
    .select({
      id: tickets.id,
      reference: tickets.publicReference,
      status: tickets.status,
      attendee: attendees.name,
      ticketType: orderItems.ticketNameSnapshot,
    })
    .from(tickets)
    .innerJoin(attendees, eq(attendees.id, tickets.attendeeId))
    .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .where(eq(tickets.eventId, event.id))
    .limit(count);

  console.log(`\n${event.title}  (${event.id})\n`);

  for (const row of rows) {
    console.log(`${row.attendee} — ${row.ticketType} [${row.status}]`);
    console.log(`  reference: ${row.reference}`);
    console.log(`  code:      ${tokenForTicket(row.id)}\n`);
  }

  console.log("Paste a code into the scanner's manual entry field, or render it as a QR.\n");

  await closeDatabase();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await closeDatabase();
  process.exit(1);
});
