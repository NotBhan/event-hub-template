import { attendeeSchema, emailSchema, personNameSchema, phoneSchema } from './schemas';
import { z } from 'zod';

/**
 * Registration form parsing.
 *
 * ## Why this is parsed by hand
 *
 * The form is dynamic: quantities vary per ticket type and the number of attendee
 * blocks follows from those quantities. Field names are therefore generated from
 * ticket type ids:
 *
 *   quantity__<ticketTypeId>             = 2
 *   attendee_name__<ticketTypeId>__0     = "Ada Lovelace"
 *   attendee_email__<ticketTypeId>__0    = "ada@example.com"
 *   attendee_name__<ticketTypeId>__1     = "..."
 *
 * Parsing keyed names directly keeps the server authoritative: the number of
 * tickets is derived from the attendee blocks that were actually submitted and
 * checked against the declared quantity, so a tampered form cannot buy five
 * tickets while filling in one attendee.
 */

export interface TicketTypeRule {
  id: string;
  name: string;
  minPerOrder: number;
  maxPerOrder: number;
}

export interface ParsedAttendee {
  name: string;
  email: string;
  phone?: string | null;
}

export interface ParsedLine {
  ticketTypeId: string;
  attendees: ParsedAttendee[];
}

export interface ParsedRegistration {
  lines: ParsedLine[];
  buyer: { name: string; email: string; phone?: string | null };
}

export type ParseResult =
  { ok: true; value: ParsedRegistration } | { ok: false; errors: Record<string, string> };

const QUANTITY_PREFIX = 'quantity__';
const ATTENDEE_PREFIX = 'attendee_';

export function parseRegistrationForm(form: FormData, ticketTypes: TicketTypeRule[]): ParseResult {
  const errors: Record<string, string> = {};

  const buyerName = personNameSchema.safeParse(form.get('buyerName'));
  if (!buyerName.success)
    errors.buyerName = buyerName.error.issues[0]?.message ?? 'Enter your name';

  const buyerEmail = emailSchema.safeParse(form.get('buyerEmail'));
  if (!buyerEmail.success)
    errors.buyerEmail = buyerEmail.error.issues[0]?.message ?? 'Enter your email';

  const buyerPhoneRaw = phoneSchema.safeParse(form.get('buyerPhone'));
  if (!buyerPhoneRaw.success)
    errors.buyerPhone = buyerPhoneRaw.error.issues[0]?.message ?? 'Enter a valid phone number';

  const lines: ParsedLine[] = [];
  let totalRequested = 0;

  for (const ticketType of ticketTypes) {
    const quantityRaw = form.get(`${QUANTITY_PREFIX}${ticketType.id}`);
    const quantity = Number(typeof quantityRaw === 'string' ? quantityRaw : 0) || 0;

    if (quantity <= 0) continue;

    if (!Number.isInteger(quantity)) {
      errors[`quantity__${ticketType.id}`] = `Choose a whole number of ${ticketType.name} tickets`;
      continue;
    }

    if (quantity < ticketType.minPerOrder) {
      errors[`quantity__${ticketType.id}`] =
        `${ticketType.name} has a minimum of ${ticketType.minPerOrder} per order`;
      continue;
    }

    if (quantity > ticketType.maxPerOrder) {
      errors[`quantity__${ticketType.id}`] =
        `${ticketType.name} has a maximum of ${ticketType.maxPerOrder} per order`;
      continue;
    }

    const attendees: ParsedAttendee[] = [];

    for (let index = 0; index < quantity; index += 1) {
      const suffix = `${ticketType.id}__${index}`;
      const attendee = attendeeSchema.safeParse({
        name: form.get(`${ATTENDEE_PREFIX}name__${suffix}`),
        email: form.get(`${ATTENDEE_PREFIX}email__${suffix}`),
        phone: form.get(`${ATTENDEE_PREFIX}phone__${suffix}`),
      });

      if (!attendee.success) {
        const first = attendee.error.issues[0];
        const field = String(first?.path[0] ?? 'name');
        errors[`${ATTENDEE_PREFIX}${field}__${suffix}`] =
          first?.message ?? `Complete the details for ticket ${index + 1}`;
        continue;
      }

      attendees.push({
        name: attendee.data.name,
        email: attendee.data.email,
        phone: attendee.data.phone ?? null,
      });
    }

    // The attendee blocks must match the declared quantity exactly.
    if (attendees.length !== quantity) {
      errors[`quantity__${ticketType.id}`] =
        `Provide details for all ${quantity} ${ticketType.name} tickets`;
      continue;
    }

    totalRequested += quantity;
    lines.push({ ticketTypeId: ticketType.id, attendees });
  }

  if (lines.length === 0 && Object.keys(errors).length === 0) {
    errors._form = 'Select at least one ticket';
  }

  if (totalRequested > 25) {
    errors._form =
      'That is more than 25 tickets. Please contact the organizer for a group booking.';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      lines,
      buyer: {
        name: buyerName.success ? buyerName.data : '',
        email: buyerEmail.success ? buyerEmail.data : '',
        phone: buyerPhoneRaw.success ? (buyerPhoneRaw.data ?? null) : null,
      },
    },
  };
}

/** Validates a JSON body against a schema and returns flattened field errors. */
export function parseJson<T extends z.ZodType>(
  schema: T,
  value: unknown,
): { ok: true; value: z.infer<T> } | { ok: false; errors: Record<string, string> } {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '_';
      if (!errors[path]) errors[path] = issue.message;
    }
    return { ok: false, errors };
  }

  return { ok: true, value: parsed.data };
}
