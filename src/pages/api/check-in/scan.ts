import type { APIRoute } from 'astro';
import { z } from 'zod';
import { roleHasPermission } from '@/lib/permissions/guards';
import { getEventForOrganization } from '@/features/events/service';
import { recordUnauthorizedScan, scanTicket } from '@/features/check-in/service';
import { generateDeviceReference } from '@/lib/security/tokens';
import { HttpError } from '@/lib/security/errors';

/**
 * Ticket scanning.
 *
 * Authorization is checked per event, not just per organization: door staff are
 * restricted to the events they are assigned to, and a scanner cannot admit for an
 * event it has not been authorized for.
 *
 * The response is deliberately minimal — a name, a ticket type and an outcome —
 * because a scanner screen is often visible to whoever is standing in front of it.
 */
export const POST: APIRoute = async (ctx) => {
  const { user, membership } = ctx.locals;

  if (!user) return json({ error: 'Sign in to scan tickets' }, 401);
  if (!membership) return json({ error: 'Your account has no organizer access' }, 403);

  let body: unknown;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: 'Expected a JSON body' }, 400);
  }

  const parsed = z
    .object({
      eventId: z.uuid('Unknown event'),
      token: z.string().min(8, 'Unrecognised code').max(500),
    })
    .safeParse(body);

  if (!parsed.success) {
    return json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400);
  }

  try {
    // Verifies the event belongs to the scanner's organization before anything else.
    await getEventForOrganization(parsed.data.eventId, membership.organizationId);
  } catch {
    await recordUnauthorizedScan({
      eventId: parsed.data.eventId,
      scannerUserId: user.id,
    });

    return json({ error: 'You are not authorized to scan for that event' }, 403);
  }

  if (!roleHasPermission(membership.role, { check_in: ['perform'] })) {
    await recordUnauthorizedScan({
      eventId: parsed.data.eventId,
      scannerUserId: user.id,
    });

    return json({ error: 'Your role cannot scan tickets' }, 403);
  }

  try {
    const result = await scanTicket({
      eventId: parsed.data.eventId,
      token: parsed.data.token,
      scannerUserId: user.id,
      deviceReference: ctx.request.headers.get('x-device-reference') ?? generateDeviceReference(),
    });

    return json({
      outcome: result.outcome,
      accepted: result.accepted,
      message: result.message,
      attendee: result.attendee ?? null,
    });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);

    console.error('Scan failed', error);
    return json({ error: 'The scan could not be processed. Try again.' }, 500);
  }
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
