import { defineAction } from 'astro:actions';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { member, organizationSettings } from '@/lib/db/schema';
import {
  cancelEvent as cancelEventService,
  completeEvent as completeEventService,
  createEvent as createEventService,
  getEventForOrganization,
  getPublicEventBySlug,
  publishEvent as publishEventService,
  replaceEventSessions,
  unpublishEvent as unpublishEventService,
  updateEvent as updateEventService,
} from '@/features/events/service';
import { createTicketType, deleteTicketType, updateTicketType } from '@/features/inventory/service';
import { createOrder } from '@/features/orders/service';
import { requestRefund as requestRefundService } from '@/features/refunds/service';
import { getAuth } from '@/lib/auth';
import { roleHasPermission, type PermissionRequest } from '@/lib/permissions/guards';
import { isOrganizationRole } from '@/lib/permissions';
import { recordAudit } from '@/features/audit/service';
import { formatMoney, toMinorUnits } from '@/lib/money';
import { wallClockToUtc } from '@/lib/timezone';
import {
  eventFormSchema,
  parseCheckbox,
  refundRequestSchema,
  ticketTypeFormSchema,
} from '@/lib/validation/schemas';
import { parseRegistrationForm } from '@/lib/validation/registration';
import { grantRegistrationAccess } from '@/lib/security/registration-access';
import { ConflictError, ForbiddenError, HttpError, SoldOutError } from '@/lib/security/errors';

/**
 * Dashboard actions.
 *
 * Every action re-derives the actor's permission from the session and re-checks
 * that the record belongs to their organization. Nothing about authorization is
 * taken from the submitted form — an action is reachable directly, so a hidden
 * field would be a suggestion, not a control.
 */

/** Roles an organizer may hand out. Ownership is granted separately. */
const assignableRoles = ['admin', 'event_manager', 'finance', 'checkin_staff'] as const;

export type ActionResult =
  | { ok: true; message: string; id?: string }
  | { ok: false; fieldErrors: Record<string, string>; values?: Record<string, string> };

function requirePermission(context: App.Locals, permission: PermissionRequest) {
  const { user, membership } = context;

  if (!user) throw new ForbiddenError('Sign in to continue');

  if (!membership || !roleHasPermission(membership.role, permission)) {
    throw new ForbiddenError();
  }

  return { user, membership };
}

function formValues(form: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string' && values[key] === undefined) values[key] = value;
  }
  return values;
}

function toResult(error: unknown, values?: Record<string, string>): ActionResult {
  if (error instanceof ConflictError || error instanceof HttpError) {
    return { ok: false, fieldErrors: { _form: error.message }, values };
  }

  console.error('Dashboard action failed', error);
  return {
    ok: false,
    fieldErrors: { _form: 'Something went wrong. Please try again.' },
    values,
  };
}

/** Reads an event form, converting wall-clock times using the event's timezone. */
function readEventForm(form: FormData, timezone: string) {
  const raw = Object.fromEntries(
    [...form.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : '']),
  );

  const parsed = eventFormSchema.safeParse(raw);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '_form';
      if (!fieldErrors[path]) fieldErrors[path] = issue.message;
    }
    return { ok: false as const, fieldErrors, values: raw };
  }

  const data = parsed.data;

  return {
    ok: true as const,
    data,
    startsAt: wallClockToUtc(data.startsAt, timezone),
    endsAt: wallClockToUtc(data.endsAt, timezone),
    registrationOpensAt: data.registrationOpensAt
      ? wallClockToUtc(data.registrationOpensAt, timezone)
      : null,
    registrationClosesAt: data.registrationClosesAt
      ? wallClockToUtc(data.registrationClosesAt, timezone)
      : null,
    refundableUntil: data.refundableUntil ? wallClockToUtc(data.refundableUntil, timezone) : null,
  };
}

export const server = {
  // ---------------------------------------------------------------------------
  // Registration (public)
  // ---------------------------------------------------------------------------

  createRegistration: defineAction({
    accept: 'form',
    input: z.object({ slug: z.string().min(1).max(120) }),
    handler: async (input, context) => {
      const detail = await getPublicEventBySlug(input.slug);

      if (!detail) {
        return {
          ok: false,
          fieldErrors: { _form: 'This event is not open for registration.' },
          values: {},
        };
      }

      const form = await context.request.formData();
      const values = formValues(form);

      const parsed = parseRegistrationForm(
        form,
        detail.ticketTypes
          .filter((type) => type.onSale)
          .map((type) => ({
            id: type.id,
            name: type.name,
            minPerOrder: type.minPerOrder,
            maxPerOrder: type.maxPerOrder,
          })),
      );

      if (!parsed.ok) return { ok: false, fieldErrors: parsed.errors, values };

      try {
        const created = await createOrder({
          eventId: detail.event.id,
          lines: parsed.value.lines,
          buyer: parsed.value.buyer,
          userId: context.locals.user?.id ?? null,
        });

        if (created.accessToken) {
          grantRegistrationAccess(context.cookies, created.order.id, created.accessToken);
        }

        return { ok: true, id: created.order.id, message: 'Registration created' };
      } catch (error) {
        if (
          error instanceof SoldOutError ||
          error instanceof ConflictError ||
          error instanceof HttpError
        ) {
          return { ok: false, fieldErrors: { _form: error.message }, values };
        }

        console.error('Registration failed', error);
        return {
          ok: false,
          fieldErrors: { _form: 'We could not complete your registration. Please try again.' },
          values,
        };
      }
    },
  }),

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  createEvent: defineAction({
    accept: 'form',
    handler: async (_input, context): Promise<ActionResult> => {
      const form = await context.request.formData();
      const values = formValues(form);

      try {
        const { membership } = requirePermission(context.locals, { event: ['create'] });

        const timezone = String(form.get('timezone') ?? '').trim() || 'UTC';
        const parsed = readEventForm(form, timezone);

        if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

        const event = await createEventService(
          membership.organizationId,
          {
            title: parsed.data.title,
            summary: parsed.data.summary ?? null,
            description: parsed.data.description ?? null,
            category: parsed.data.category ?? null,
            coverImageUrl: parsed.data.coverImageUrl ?? null,
            coverImageKey: parsed.data.coverImageKey ?? null,
            format: parsed.data.format,
            visibility: parsed.data.visibility,
            timezone,
            startsAt: parsed.startsAt,
            endsAt: parsed.endsAt,
            registrationOpensAt: parsed.registrationOpensAt,
            registrationClosesAt: parsed.registrationClosesAt,
            refundPolicy: parsed.data.refundPolicy,
            refundableUntil: parsed.refundableUntil,
            refundPolicyNotes: parsed.data.refundPolicyNotes ?? null,
            location: parsed.data.venueName
              ? {
                  venueName: parsed.data.venueName,
                  streetAddress: parsed.data.streetAddress ?? null,
                  city: parsed.data.city ?? null,
                  region: parsed.data.region ?? null,
                  postalCode: parsed.data.postalCode ?? null,
                  country: parsed.data.country ?? null,
                  directions: parsed.data.directions ?? null,
                }
              : null,
            access: parsed.data.accessPlatform
              ? {
                  platform: parsed.data.accessPlatform,
                  joinUrl: parsed.data.joinUrl ?? null,
                  accessInstructions: parsed.data.accessInstructions ?? null,
                  publicNote: parsed.data.publicNote ?? null,
                }
              : null,
          },
          context.locals.user?.id ?? null,
        );

        return { ok: true, id: event.id, message: 'Draft event created' };
      } catch (error) {
        return toResult(error, values);
      }
    },
  }),

  updateEvent: defineAction({
    accept: 'form',
    handler: async (_input, context): Promise<ActionResult> => {
      const form = await context.request.formData();
      const values = formValues(form);

      try {
        const { membership } = requirePermission(context.locals, { event: ['update'] });
        const eventId = String(form.get('eventId') ?? '');

        if (!eventId) return { ok: false, fieldErrors: { _form: 'Missing event id' }, values };

        // Ownership is verified before anything is read from the form.
        await getEventForOrganization(eventId, membership.organizationId);

        const timezone = String(form.get('timezone') ?? '').trim() || 'UTC';
        const parsed = readEventForm(form, timezone);

        if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

        await updateEventService(
          eventId,
          membership.organizationId,
          {
            title: parsed.data.title,
            summary: parsed.data.summary ?? null,
            description: parsed.data.description ?? null,
            category: parsed.data.category ?? null,
            coverImageUrl: parsed.data.coverImageUrl ?? null,
            coverImageKey: parsed.data.coverImageKey ?? null,
            // The service decides what removal means — it also owns deleting the
            // objects that stop being referenced.
            removeCoverImage: parsed.data.removeCoverImage,
            format: parsed.data.format,
            visibility: parsed.data.visibility,
            timezone,
            startsAt: parsed.startsAt,
            endsAt: parsed.endsAt,
            registrationOpensAt: parsed.registrationOpensAt,
            registrationClosesAt: parsed.registrationClosesAt,
            refundPolicy: parsed.data.refundPolicy,
            refundableUntil: parsed.refundableUntil,
            refundPolicyNotes: parsed.data.refundPolicyNotes ?? null,
            location: parsed.data.venueName
              ? {
                  venueName: parsed.data.venueName,
                  streetAddress: parsed.data.streetAddress ?? null,
                  city: parsed.data.city ?? null,
                  region: parsed.data.region ?? null,
                  postalCode: parsed.data.postalCode ?? null,
                  country: parsed.data.country ?? null,
                  directions: parsed.data.directions ?? null,
                }
              : null,
            access: parsed.data.accessPlatform
              ? {
                  platform: parsed.data.accessPlatform,
                  joinUrl: parsed.data.joinUrl ?? null,
                  accessInstructions: parsed.data.accessInstructions ?? null,
                  publicNote: parsed.data.publicNote ?? null,
                }
              : null,
          },
          context.locals.user?.id ?? null,
        );

        return { ok: true, id: eventId, message: 'Event saved' };
      } catch (error) {
        return toResult(error, values);
      }
    },
  }),

  setEventStatus: defineAction({
    accept: 'form',
    input: z.object({
      eventId: z.uuid(),
      status: z.enum(['publish', 'unpublish', 'cancel', 'complete']),
      reason: z.string().trim().max(500).optional(),
    }),
    handler: async (input, context): Promise<ActionResult> => {
      try {
        const permission: PermissionRequest =
          input.status === 'publish' || input.status === 'unpublish'
            ? { event: ['publish'] }
            : { event: ['cancel'] };

        const { membership } = requirePermission(context.locals, permission);

        const actor = context.locals.user?.id ?? null;

        if (input.status === 'publish') {
          await publishEventService(input.eventId, membership.organizationId, actor);
          return { ok: true, id: input.eventId, message: 'Event published' };
        }

        if (input.status === 'unpublish') {
          await unpublishEventService(input.eventId, membership.organizationId, actor);
          return { ok: true, id: input.eventId, message: 'Event moved back to draft' };
        }

        if (input.status === 'cancel') {
          await cancelEventService(input.eventId, membership.organizationId, {
            reason: input.reason ?? 'Cancelled by the organizer',
            actorUserId: actor,
          });
          return { ok: true, id: input.eventId, message: 'Event cancelled' };
        }

        await completeEventService(input.eventId, membership.organizationId, actor);
        return { ok: true, id: input.eventId, message: 'Event marked complete' };
      } catch (error) {
        return toResult(error);
      }
    },
  }),

  // ---------------------------------------------------------------------------
  // Ticket types
  // ---------------------------------------------------------------------------

  saveTicketType: defineAction({
    accept: 'form',
    handler: async (_input, context): Promise<ActionResult> => {
      const form = await context.request.formData();
      const values = formValues(form);

      try {
        const { membership } = requirePermission(context.locals, {
          ticket_type: ['create', 'update'],
        });

        const eventId = String(form.get('eventId') ?? '');
        const ticketTypeId = String(form.get('ticketTypeId') ?? '').trim();

        const event = await getEventForOrganization(eventId, membership.organizationId);

        /**
         * Currency belongs to the installation, not to the event, so it is read
         * from the organization's settings.
         */
        const [settings] = await db()
          .select({ defaultCurrency: organizationSettings.defaultCurrency })
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, membership.organizationId))
          .limit(1);

        const currency = settings?.defaultCurrency ?? 'INR';

        /** Prices are entered in major units and stored in minor units. */
        const parsed = ticketTypeFormSchema.safeParse({
          name: form.get('name'),
          description: form.get('description'),
          price: form.get('price'),
          quantityTotal: form.get('quantityTotal'),
          minPerOrder: form.get('minPerOrder') || 1,
          maxPerOrder: form.get('maxPerOrder') || 10,
          salesStartAt: form.get('salesStartAt'),
          salesEndAt: form.get('salesEndAt'),
          isActive: parseCheckbox(form.get('isActive')),
          sortOrder: form.get('sortOrder') || 0,
        });

        if (!parsed.success) {
          const fieldErrors: Record<string, string> = {};
          for (const issue of parsed.error.issues) {
            const path = issue.path.join('.') || '_form';
            if (!fieldErrors[path]) fieldErrors[path] = issue.message;
          }
          return { ok: false, fieldErrors, values };
        }

        const data = parsed.data;

        const payload = {
          name: data.name,
          description: data.description ?? null,
          priceMinor: toMinorUnits(data.price, currency),
          currency,
          quantityTotal: data.quantityTotal,
          minPerOrder: data.minPerOrder,
          maxPerOrder: data.maxPerOrder,
          salesStartAt: data.salesStartAt
            ? wallClockToUtc(data.salesStartAt, event.timezone)
            : null,
          salesEndAt: data.salesEndAt ? wallClockToUtc(data.salesEndAt, event.timezone) : null,
          isActive: data.isActive,
          sortOrder: data.sortOrder,
        };

        if (ticketTypeId) {
          const updated = await updateTicketType(db(), ticketTypeId, payload);
          return { ok: true, id: updated.id, message: `${updated.name} updated` };
        }

        const created = await createTicketType(db(), eventId, payload);
        return { ok: true, id: created.id, message: `${created.name} added` };
      } catch (error) {
        return toResult(error, values);
      }
    },
  }),

  deleteTicketType: defineAction({
    accept: 'form',
    input: z.object({ ticketTypeId: z.uuid(), eventId: z.uuid() }),
    handler: async (input, context): Promise<ActionResult> => {
      try {
        const { membership } = requirePermission(context.locals, { ticket_type: ['delete'] });
        await getEventForOrganization(input.eventId, membership.organizationId);

        await deleteTicketType(db(), input.ticketTypeId);
        return { ok: true, message: 'Ticket type deleted' };
      } catch (error) {
        return toResult(error);
      }
    },
  }),

  // ---------------------------------------------------------------------------
  // Refunds
  // ---------------------------------------------------------------------------

  requestRefund: defineAction({
    accept: 'form',
    handler: async (_input, context): Promise<ActionResult> => {
      const form = await context.request.formData();
      const values = formValues(form);

      try {
        const { membership, user: actor } = requirePermission(context.locals, {
          refund: ['create'],
        });

        const rawAmount = String(form.get('amount') ?? '').trim();
        const ticketIds = form
          .getAll('ticketIds')
          .filter((v): v is string => typeof v === 'string');

        const parsed = refundRequestSchema.safeParse({
          orderId: form.get('orderId'),
          amount: rawAmount === '' ? undefined : rawAmount,
          reason: form.get('reason'),
          notes: form.get('notes'),
        });

        if (!parsed.success) {
          const fieldErrors: Record<string, string> = {};
          for (const issue of parsed.error.issues) {
            const path = issue.path.join('.') || '_form';
            if (!fieldErrors[path]) fieldErrors[path] = issue.message;
          }
          return { ok: false, fieldErrors, values };
        }

        const result = await requestRefundService({
          orderId: parsed.data.orderId,
          // The amount is entered in major units and converted for storage.
          amountMinor:
            parsed.data.amount === undefined ? undefined : toMinorUnits(parsed.data.amount, 'INR'),
          ticketIds: ticketIds.length > 0 ? ticketIds : undefined,
          reason: parsed.data.reason,
          notes: parsed.data.notes ?? null,
          actorUserId: actor.id,
          organizationId: membership.organizationId,
        });

        return {
          ok: true,
          id: result.refund.id,
          message: result.settled
            ? `Refund of ${formatMoney(result.refund.amountMinor, result.refund.currency)} completed`
            : `Refund of ${formatMoney(result.refund.amountMinor, result.refund.currency)} submitted and awaiting confirmation`,
        };
      } catch (error) {
        return toResult(error, values);
      }
    },
  }),

  // ---------------------------------------------------------------------------
  // Staff
  // ---------------------------------------------------------------------------

  inviteStaff: defineAction({
    accept: 'form',
    input: z.object({
      email: z.email('Enter a valid email address'),
      role: z.enum(assignableRoles),
    }),
    handler: async (input, context): Promise<ActionResult> => {
      try {
        const { membership } = requirePermission(context.locals, { invitation: ['create'] });

        // `assignableRoles` already excludes ownership and the plain attendee
        // role, so nothing further to narrow here.

        await getAuth().api.createInvitation({
          headers: context.request.headers,
          body: {
            email: input.email.toLowerCase(),
            role: input.role,
            organizationId: membership.organizationId,
          },
        });

        await recordAudit(db(), {
          organizationId: membership.organizationId,
          actorUserId: context.locals.user?.id ?? null,
          action: 'member.role_changed',
          resourceType: 'invitation',
          metadata: { email: input.email, role: input.role },
        });

        return { ok: true, message: `Invitation sent to ${input.email}` };
      } catch (error) {
        return toResult(error);
      }
    },
  }),

  updateMemberRole: defineAction({
    accept: 'form',
    input: z.object({
      memberId: z.string().min(1),
      role: z.enum(['owner', 'admin', 'event_manager', 'finance', 'checkin_staff', 'attendee']),
    }),
    handler: async (input, context): Promise<ActionResult> => {
      try {
        const { membership } = requirePermission(context.locals, { member: ['update'] });

        if (!isOrganizationRole(input.role)) throw new ForbiddenError('Unknown role');

        // Only an owner may create another owner or change one: allowing an admin
        // to promote themselves would defeat the role model entirely.
        if (input.role === 'owner' && membership.role !== 'owner') {
          throw new ForbiddenError('Only an owner can grant owner access');
        }

        const [target] = await db()
          .select({ id: member.id, role: member.role, userId: member.userId })
          .from(member)
          .where(eq(member.id, input.memberId))
          .limit(1);

        if (!target) throw new ForbiddenError('That member does not exist');

        const [targetMember] = await db()
          .select({ organizationId: member.organizationId })
          .from(member)
          .where(eq(member.id, input.memberId))
          .limit(1);

        if (targetMember?.organizationId !== membership.organizationId) {
          throw new ForbiddenError('That member belongs to another organization');
        }

        if (target.role === 'owner' && membership.role !== 'owner') {
          throw new ForbiddenError('Only an owner can change another owner');
        }

        await db().update(member).set({ role: input.role }).where(eq(member.id, input.memberId));

        await recordAudit(db(), {
          organizationId: membership.organizationId,
          actorUserId: context.locals.user?.id ?? null,
          action: 'member.role_changed',
          resourceType: 'member',
          resourceId: input.memberId,
          metadata: { from: target.role, to: input.role },
        });

        return { ok: true, message: 'Role updated' };
      } catch (error) {
        return toResult(error);
      }
    },
  }),

  removeMember: defineAction({
    accept: 'form',
    input: z.object({ memberId: z.string().min(1) }),
    handler: async (input, context): Promise<ActionResult> => {
      try {
        const { membership, user: actor } = requirePermission(context.locals, {
          member: ['delete'],
        });

        const [target] = await db()
          .select({
            id: member.id,
            role: member.role,
            userId: member.userId,
            organizationId: member.organizationId,
          })
          .from(member)
          .where(eq(member.id, input.memberId))
          .limit(1);

        if (!target || target.organizationId !== membership.organizationId) {
          throw new ForbiddenError('That member does not exist in this organization');
        }

        if (target.role === 'owner') {
          throw new ForbiddenError('An owner cannot be removed. Change their role first.');
        }

        if (target.userId === actor.id) {
          throw new ForbiddenError('You cannot remove your own access');
        }

        await db().delete(member).where(eq(member.id, input.memberId));

        await recordAudit(db(), {
          organizationId: membership.organizationId,
          actorUserId: actor.id,
          action: 'member.removed',
          resourceType: 'member',
          resourceId: input.memberId,
          metadata: { role: target.role },
        });

        return { ok: true, message: 'Access removed' };
      } catch (error) {
        return toResult(error);
      }
    },
  }),

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  updateSettings: defineAction({
    accept: 'form',
    input: z.object({
      brandName: z.string().trim().min(1, 'Enter a name').max(120),
      logoUrl: z.union([z.url('Enter a full URL'), z.literal('')]).optional(),
      primaryColor: z
        .string()
        .trim()
        .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Enter a hex colour such as #4f46e5')
        .optional()
        .or(z.literal('').transform(() => undefined)),
      supportEmail: z.union([z.email('Enter a valid email address'), z.literal('')]).optional(),
      supportPhone: z.string().trim().max(32).optional(),
      defaultCurrency: z
        .string()
        .trim()
        .length(3, 'Use a three-letter currency code')
        .toUpperCase(),
      defaultTimezone: z.string().trim().min(1, 'Choose a timezone').max(64),
    }),
    handler: async (input, context): Promise<ActionResult> => {
      try {
        const { membership } = requirePermission(context.locals, { settings: ['update'] });

        await db()
          .update(organizationSettings)
          .set({
            brandName: input.brandName,
            logoUrl: input.logoUrl || null,
            primaryColor: input.primaryColor || null,
            supportEmail: input.supportEmail || null,
            supportPhone: input.supportPhone || null,
            defaultCurrency: input.defaultCurrency,
            defaultTimezone: input.defaultTimezone,
          })
          .where(eq(organizationSettings.organizationId, membership.organizationId));

        await recordAudit(db(), {
          organizationId: membership.organizationId,
          actorUserId: context.locals.user?.id ?? null,
          action: 'settings.updated',
          resourceType: 'organization_settings',
          resourceId: membership.organizationId,
        });

        return { ok: true, message: 'Settings saved' };
      } catch (error) {
        return toResult(error);
      }
    },
  }),

  // ---------------------------------------------------------------------------
  // Sessions (event programme)
  // ---------------------------------------------------------------------------

  saveSessions: defineAction({
    accept: 'form',
    input: z.object({ eventId: z.uuid() }),
    handler: async (input, context): Promise<ActionResult> => {
      const form = await context.request.formData();

      try {
        const { membership } = requirePermission(context.locals, { event: ['update'] });
        const event = await getEventForOrganization(input.eventId, membership.organizationId);

        const titles = form
          .getAll('sessionTitle')
          .filter((v): v is string => typeof v === 'string');
        const starts = form
          .getAll('sessionStartsAt')
          .filter((v): v is string => typeof v === 'string');
        const ends = form.getAll('sessionEndsAt').filter((v): v is string => typeof v === 'string');
        const speakers = form
          .getAll('sessionSpeaker')
          .filter((v): v is string => typeof v === 'string');
        const rooms = form.getAll('sessionRoom').filter((v): v is string => typeof v === 'string');

        const sessions = [];

        for (let index = 0; index < titles.length; index += 1) {
          const title = titles[index]?.trim();
          const startsAt = starts[index];
          const endsAt = ends[index];

          if (!title || !startsAt || !endsAt) continue;

          sessions.push({
            title,
            speakerName: speakers[index]?.trim() || null,
            room: rooms[index]?.trim() || null,
            startsAt: wallClockToUtc(startsAt, event.timezone),
            endsAt: wallClockToUtc(endsAt, event.timezone),
          });
        }

        await replaceEventSessions(input.eventId, membership.organizationId, sessions);

        return {
          ok: true,
          message: `${sessions.length} session${sessions.length === 1 ? '' : 's'} saved`,
        };
      } catch (error) {
        return toResult(error);
      }
    },
  }),
};
