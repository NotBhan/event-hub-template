import { z } from 'zod';

/**
 * Request validation.
 *
 * Every value that crosses the trust boundary is validated here: form posts,
 * query parameters and JSON bodies. Validation is intentionally strict and
 * explicit so a malformed request produces a readable message instead of an
 * unhandled error halfway through a transaction.
 */

/** Normalises any missing form value into an empty string for validation. */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

export const emailSchema = z
  .unknown()
  .transform((value) => asText(value).trim().toLowerCase())
  .pipe(z.email('Enter a valid email address').max(254, 'That email address is too long'));

/**
 * An optional field.
 *
 * A missing form field arrives as `null` from `FormData.get()`, not `undefined`,
 * and `z.string().optional()` rejects `null`. Without this, every optional input
 * would be invalid for anyone submitting the form without JavaScript — or any
 * time a field is simply left out.
 */
export const optionalString = (max = 2000) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((value) => (value === null || value === '' ? undefined : value));

export const phoneSchema = z
  .unknown()
  .transform((value) => asText(value).trim())
  .refine(
    (value) => value === '' || /^[0-9+()\-.\s]{4,32}$/.test(value),
    'Enter a valid phone number',
  )
  .transform((value) => (value === '' ? undefined : value));

export const personNameSchema = z
  .unknown()
  .transform((value) => asText(value).trim())
  .pipe(z.string().min(2, 'Enter a name').max(120, 'That name is too long'));

/** An optional URL field, where an empty input means "not provided". */
const optionalUrl = (message: string, max = 500) =>
  z
    .union([z.url(message).max(max), z.literal(''), z.null()])
    .optional()
    .transform((value) => (value === null || value === '' ? undefined : value));

export const ticketTypeFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the ticket type a name').max(120),
    description: optionalString(1000),
    price: z.coerce
      .number({ message: 'Enter a price' })
      .min(0, 'Price cannot be negative')
      .max(100_000_000, 'That price is too large'),
    quantityTotal: z.coerce
      .number({ message: 'Enter a capacity' })
      .int('Capacity must be a whole number')
      .min(0, 'Capacity cannot be negative')
      .max(1_000_000, 'That capacity is too large'),
    minPerOrder: z.coerce.number().int().min(1).max(100).default(1),
    maxPerOrder: z.coerce.number().int().min(1).max(100).default(10),
    salesStartAt: optionalString(40),
    salesEndAt: optionalString(40),
    isActive: z.coerce.boolean().default(false),
    sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  })
  .refine((value) => value.maxPerOrder >= value.minPerOrder, {
    message: 'The maximum per order cannot be lower than the minimum',
    path: ['maxPerOrder'],
  });

export const eventFormSchema = z
  .object({
    title: z.string().trim().min(3, 'Give the event a title').max(200),
    summary: optionalString(300),
    description: optionalString(20000),
    category: optionalString(60),
    coverImageUrl: optionalUrl('Enter a full image URL'),
    format: z.enum(['in_person', 'online', 'hybrid']),
    visibility: z.enum(['public', 'private']),
    timezone: z.string().trim().min(1, 'Choose a timezone').max(64),
    startsAt: z.string().trim().min(10, 'Choose a start date and time'),
    endsAt: z.string().trim().min(10, 'Choose an end date and time'),
    registrationOpensAt: optionalString(40),
    registrationClosesAt: optionalString(40),
    refundPolicy: z.enum([
      'no_refunds',
      'refundable_until_start',
      'refundable_until_date',
      'custom',
    ]),
    refundableUntil: optionalString(40),
    refundPolicyNotes: optionalString(1000),

    venueName: optionalString(200),
    streetAddress: optionalString(300),
    city: optionalString(120),
    region: optionalString(120),
    postalCode: optionalString(20),
    country: optionalString(120),
    directions: optionalString(2000),

    accessPlatform: optionalString(120),
    joinUrl: optionalUrl('Enter a full URL'),
    accessInstructions: optionalString(4000),
    publicNote: optionalString(300),
  })
  .superRefine((value, ctx) => {
    if (value.endsAt <= value.startsAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'The event must end after it starts',
      });
    }

    if (
      value.registrationOpensAt &&
      value.registrationClosesAt &&
      value.registrationClosesAt <= value.registrationOpensAt
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['registrationClosesAt'],
        message: 'Registration must close after it opens',
      });
    }

    if ((value.format === 'in_person' || value.format === 'hybrid') && !value.venueName) {
      ctx.addIssue({ code: 'custom', path: ['venueName'], message: 'Add the venue name' });
    }

    if ((value.format === 'online' || value.format === 'hybrid') && !value.accessPlatform) {
      ctx.addIssue({
        code: 'custom',
        path: ['accessPlatform'],
        message: 'Name the platform hosting the online event',
      });
    }

    if (
      (value.refundPolicy === 'refundable_until_date' || value.refundPolicy === 'custom') &&
      !value.refundableUntil
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['refundableUntil'],
        message: 'Choose the date refunds stop being available',
      });
    }
  });

export const refundRequestSchema = z.object({
  orderId: z.uuid('Unknown order'),
  amount: z.coerce.number().min(0).optional(),
  reason: z.string().trim().min(3, 'Give a reason for the refund').max(500),
  notes: optionalString(2000),
});

/**
 * One attendee block. Kept separate from the aggregate so a single bad attendee
 * produces a field-level message rather than a generic failure.
 */
export const attendeeSchema = z.object({
  name: personNameSchema,
  email: emailSchema,
  phone: phoneSchema,
});

export function flattenIssues(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};

  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_';
    if (!result[path]) result[path] = issue.message;
  }

  return result;
}

/** Reads a checkbox or select value as a boolean, tolerating several spellings. */
export function parseCheckbox(value: FormDataEntryValue | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const normalised = value.trim().toLowerCase();
  return normalised === 'on' || normalised === 'true' || normalised === '1' || normalised === 'yes';
}
