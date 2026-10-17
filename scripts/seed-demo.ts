/**
 * Demo data.
 *
 * Everything here goes through the same services the application uses — events
 * are published through `publishEvent`, orders through `createOrder`, tickets
 * through `confirmOrder`. Nothing is written with raw inserts behind the
 * business rules, so seeding doubles as an end-to-end check that capacity,
 * reservation and ticket issuance all work.
 *
 * Usage:
 *   npm run seed          # add demo data if it is not already present
 *   npm run seed -- --reset   # remove existing demo events first
 */
import '../src/lib/security/load-env';
import { eq } from 'drizzle-orm';
import { closeDatabase, db } from '../src/lib/db/client';
import { events, organization, user } from '../src/lib/db/schema';
import { createEvent, publishEvent } from '../src/features/events/service';
import { createTicketType } from '../src/features/inventory/service';
import { createOrder, confirmOrder } from '../src/features/orders/service';
import { serverEnv } from '../src/lib/security/env';
import { site } from '../src/config/site';

/** Small, readable progress log. */
function step(message: string): void {
  console.log(`  ${message}`);
}

function daysFromNow(days: number, hour = 9, minute = 0): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, minute, 0, 0);
  return date;
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');

  console.log('\nSeeding demo data\n');

  const [org] = await db().select().from(organization).limit(1);

  if (!org) {
    throw new Error('No organization found. Run `npm run provision` first to create one.');
  }

  step(`Organization: ${org.name} (${org.id})`);

  const [owner] = await db().select().from(user).limit(1);
  const actorUserId = owner?.id ?? null;
  const timezone = site.defaultTimezone;
  const currency = site.defaultCurrency;

  const demoSlugs = ['frontier-2026', 'design-systems-online', 'community-night'];

  if (reset) {
    for (const slug of demoSlugs) {
      await db().delete(events).where(eq(events.slug, slug));
    }
    step('Removed previous demo events');
  }

  const [existingDemo] = await db()
    .select({ id: events.id })
    .from(events)
    .where(eq(events.slug, demoSlugs[0]!))
    .limit(1);

  if (existingDemo) {
    step('Demo events already exist — nothing to do (use --reset to replace them)');
    await closeDatabase();
    return;
  }

  // ---------------------------------------------------------------------------
  // 1. A physical conference
  // ---------------------------------------------------------------------------
  const conference = await createEvent(
    org.id,
    {
      title: 'Frontier 2026',
      slug: 'frontier-2026',
      summary: 'A two-day conference on building resilient products at scale.',
      description: [
        'Frontier brings together engineers, designers and product leaders for two days of talks and workshops.',
        '',
        'Expect deep dives into distributed systems, payment infrastructure and the unglamorous work of keeping software trustworthy.',
        '',
        'Lunch, coffee and the evening social are included in every ticket.',
      ].join('\n'),
      category: 'Conference',
      format: 'in_person',
      visibility: 'public',
      timezone,
      startsAt: daysFromNow(45, 4, 30),
      endsAt: daysFromNow(46, 12, 30),
      registrationOpensAt: daysFromNow(-10),
      registrationClosesAt: daysFromNow(44),
      refundPolicy: 'refundable_until_start',
      refundPolicyNotes: 'Full refunds up to 48 hours before the event.',
      location: {
        venueName: 'The Grand Pavilion',
        streetAddress: '12 Nehru Road',
        city: 'Bengaluru',
        region: 'Karnataka',
        postalCode: '560001',
        country: 'India',
        directions: 'Two minutes from MG Road metro. Paid parking available on site.',
      },
    },
    actorUserId,
  );

  step(`Event: ${conference.title}`);

  const earlyBird = await createTicketType(db(), conference.id, {
    name: 'Early bird',
    description: 'Limited release for the first 50 registrations.',
    priceMinor: 499_00,
    currency,
    quantityTotal: 50,
    minPerOrder: 1,
    maxPerOrder: 4,
    sortOrder: 1,
  });

  const standard = await createTicketType(db(), conference.id, {
    name: 'Standard',
    priceMinor: 799_00,
    currency,
    quantityTotal: 200,
    minPerOrder: 1,
    maxPerOrder: 6,
    sortOrder: 2,
  });

  await createTicketType(db(), conference.id, {
    name: 'Student',
    description: 'Valid student ID required at the door.',
    priceMinor: 249_00,
    currency,
    quantityTotal: 40,
    minPerOrder: 1,
    maxPerOrder: 2,
    sortOrder: 3,
  });

  await publishEvent(conference.id, org.id, actorUserId);
  step('Published with 3 ticket types');

  // ---------------------------------------------------------------------------
  // 2. An online workshop (free)
  // ---------------------------------------------------------------------------
  const workshop = await createEvent(
    org.id,
    {
      title: 'Design Systems, Online',
      slug: 'design-systems-online',
      summary: 'A free live workshop on scaling a design system across teams.',
      description:
        'A practical, two-hour session covering tokens, component APIs and how to keep documentation honest. Bring questions.',
      category: 'Workshop',
      format: 'online',
      visibility: 'public',
      timezone,
      startsAt: daysFromNow(14, 12, 0),
      endsAt: daysFromNow(14, 14, 0),
      registrationClosesAt: daysFromNow(14, 6, 0),
      access: {
        platform: 'Live video call',
        joinUrl: 'https://meet.example.com/design-systems-demo',
        accessInstructions:
          'Join five minutes early. The recording link is shared with attendees afterwards.',
        publicNote: 'The joining link is sent to registered attendees before the session.',
      },
    },
    actorUserId,
  );

  await createTicketType(db(), workshop.id, {
    name: 'Free seat',
    priceMinor: 0,
    currency,
    quantityTotal: 120,
    minPerOrder: 1,
    maxPerOrder: 3,
    sortOrder: 1,
  });

  await publishEvent(workshop.id, org.id, actorUserId);
  step(`Event: ${workshop.title} (free, online)`);

  // ---------------------------------------------------------------------------
  // 3. A hybrid community evening
  // ---------------------------------------------------------------------------
  const meetup = await createEvent(
    org.id,
    {
      title: 'Community Night',
      slug: 'community-night',
      summary: 'Lightning talks, followed by food. Attend in person or online.',
      description:
        'Five-minute talks from anyone who wants the microphone, then dinner. Half the room joins remotely.',
      category: 'Meetup',
      format: 'hybrid',
      visibility: 'public',
      timezone,
      startsAt: daysFromNow(28, 13, 30),
      endsAt: daysFromNow(28, 17, 0),
      refundPolicy: 'no_refunds',
      location: {
        venueName: 'The Workshop',
        streetAddress: '88 Residency Road',
        city: 'Bengaluru',
        region: 'Karnataka',
        postalCode: '560025',
        country: 'India',
      },
      access: {
        platform: 'Live stream',
        joinUrl: 'https://stream.example.com/community-night-demo',
        accessInstructions: 'The stream opens 15 minutes before the first talk.',
        publicNote: 'Online attendees receive the stream link before the event.',
      },
    },
    actorUserId,
  );

  await createTicketType(db(), meetup.id, {
    name: 'In person',
    description: 'Includes dinner.',
    priceMinor: 150_00,
    currency,
    quantityTotal: 80,
    minPerOrder: 1,
    maxPerOrder: 4,
    sortOrder: 1,
  });

  await createTicketType(db(), meetup.id, {
    name: 'Online',
    priceMinor: 0,
    currency,
    quantityTotal: 300,
    minPerOrder: 1,
    maxPerOrder: 2,
    sortOrder: 2,
  });

  await publishEvent(meetup.id, org.id, actorUserId);
  step(`Event: ${meetup.title} (hybrid)`);

  // ---------------------------------------------------------------------------
  // Realistic registrations, created through the ordinary order flow
  // ---------------------------------------------------------------------------
  const registrations = [
    {
      eventId: conference.id,
      ticketTypeId: earlyBird.id,
      buyer: { name: 'Ananya Sharma', email: 'ananya.sharma@example.com' },
      attendees: [
        { name: 'Ananya Sharma', email: 'ananya.sharma@example.com' },
        { name: 'Rohit Verma', email: 'rohit.verma@example.com' },
      ],
      confirm: true,
    },
    {
      eventId: conference.id,
      ticketTypeId: standard.id,
      buyer: { name: 'Meera Iyer', email: 'meera.iyer@example.com' },
      attendees: [{ name: 'Meera Iyer', email: 'meera.iyer@example.com' }],
      confirm: true,
    },
    {
      eventId: conference.id,
      ticketTypeId: standard.id,
      buyer: { name: 'Daniel Okafor', email: 'daniel.okafor@example.com' },
      attendees: [
        { name: 'Daniel Okafor', email: 'daniel.okafor@example.com' },
        { name: 'Priya Nair', email: 'priya.nair@example.com' },
        { name: 'Sam Whitfield', email: 'sam.whitfield@example.com' },
      ],
      confirm: false,
    },
    {
      eventId: workshop.id,
      ticketTypeId: null,
      buyer: { name: 'Priya Nair', email: 'priya.nair@example.com' },
      attendees: [{ name: 'Priya Nair', email: 'priya.nair@example.com' }],
      confirm: true,
    },
    {
      eventId: meetup.id,
      ticketTypeId: null,
      buyer: { name: 'Sam Whitfield', email: 'sam.whitfield@example.com' },
      attendees: [{ name: 'Sam Whitfield', email: 'sam.whitfield@example.com' }],
      confirm: true,
    },
  ];

  for (const registration of registrations) {
    const detail = await createEventOrderInput(
      registration.eventId,
      registration.ticketTypeId,
      registration.attendees,
    );

    const created = await createOrder({
      eventId: registration.eventId,
      lines: detail.lines,
      buyer: registration.buyer,
      userId: null,
    });

    if (registration.confirm && created.order.status !== 'confirmed') {
      await confirmOrder({ orderId: created.order.id });
    }

    step(
      `Order ${created.order.publicReference} — ${registration.buyer.name} (${registration.attendees.length} ticket${registration.attendees.length === 1 ? '' : 's'})`,
    );
  }

  console.log(`
Done.

  ${conference.title}        3 ticket types, paid checkouts
  ${workshop.title}   free registration
  ${meetup.title}        hybrid, free and paid

Sign in at ${serverEnv().PUBLIC_SITE_URL}/login to see them in the dashboard.
`);

  await closeDatabase();
}

/** Picks a ticket type for the demo order, defaulting to the first available. */
async function createEventOrderInput(
  eventId: string,
  preferredTicketTypeId: string | null,
  attendees: { name: string; email: string }[],
) {
  const { listTicketTypes } = await import('../src/features/inventory/service');
  const types = await listTicketTypes(eventId);

  const chosen = preferredTicketTypeId
    ? types.find((type) => type.id === preferredTicketTypeId)
    : (types.find((type) => type.priceMinor === 0) ?? types[0]);

  if (!chosen) throw new Error(`No ticket types for event ${eventId}`);

  return {
    lines: [{ ticketTypeId: chosen.id, attendees }],
  };
}

main().catch(async (error) => {
  console.error('\nSeeding failed:', error);
  await closeDatabase();
  process.exit(1);
});
