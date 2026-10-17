import { describe, expect, it } from 'vitest';
import { parseRegistrationForm } from '@/lib/validation/registration';
import { buildCoverImageKey } from '@/lib/storage/object-storage';
import {
  emailSchema,
  eventFormSchema,
  optionalString,
  parseCheckbox,
  personNameSchema,
  phoneSchema,
  ticketTypeFormSchema,
} from '@/lib/validation/schemas';

/**
 * Request validation.
 *
 * The emphasis is on the boundary: what happens when a field is absent, empty, or
 * hostile. A validation layer that only handles the happy path from a browser
 * will fail the first time a form is submitted without JavaScript, because a
 * missing field arrives as `null` rather than `undefined`.
 */
describe('field validation', () => {
  it('treats an absent optional field as absent', () => {
    // `FormData.get()` returns null for a field that was never rendered.
    expect(optionalString(50).parse(null)).toBeUndefined();
    expect(optionalString(50).parse(undefined)).toBeUndefined();
    expect(optionalString(50).parse('')).toBeUndefined();
    expect(optionalString(50).parse('  ')).toBeUndefined();
    expect(optionalString(50).parse('hello')).toBe('hello');
    expect(optionalString(5).safeParse('too long').success).toBe(false);
  });

  it('accepts an absent phone number but rejects a nonsense one', () => {
    expect(phoneSchema.parse(null)).toBeUndefined();
    expect(phoneSchema.parse('')).toBeUndefined();
    expect(phoneSchema.parse('+91 98765 43210')).toBe('+91 98765 43210');
    expect(phoneSchema.safeParse('call me maybe').success).toBe(false);
    expect(phoneSchema.safeParse('123').success).toBe(false);
  });

  it('reports a readable message for a missing required name', () => {
    expect(personNameSchema.safeParse(null).success).toBe(false);

    const result = personNameSchema.safeParse('  ');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/enter a name/i);
  });

  it('normalises email addresses and rejects malformed ones', () => {
    expect(emailSchema.parse('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
    expect(emailSchema.safeParse('').success).toBe(false);
    expect(emailSchema.safeParse(null).success).toBe(false);
  });

  it('reads checkboxes the way browsers actually send them', () => {
    expect(parseCheckbox('on')).toBe(true);
    expect(parseCheckbox('true')).toBe(true);
    expect(parseCheckbox('1')).toBe(true);
    expect(parseCheckbox('TRUE')).toBe(true);
    expect(parseCheckbox('off')).toBe(false);
    expect(parseCheckbox(null)).toBe(false);
    expect(parseCheckbox(undefined)).toBe(false);
  });

  it('coerces numeric strings from a form', () => {
    const parsed = ticketTypeFormSchema.safeParse({
      name: 'General',
      description: '',
      price: '499.50',
      quantityTotal: '100',
      minPerOrder: '1',
      maxPerOrder: '4',
      isActive: true,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.price).toBe(499.5);
      expect(parsed.data.quantityTotal).toBe(100);
      expect(parsed.data.description).toBeUndefined();
    }
  });

  it('refuses an order limit where the maximum is below the minimum', () => {
    const parsed = ticketTypeFormSchema.safeParse({
      name: 'General',
      price: 100,
      quantityTotal: 10,
      minPerOrder: 5,
      maxPerOrder: 2,
    });

    expect(parsed.success).toBe(false);
  });

  it('requires a venue for physical events and a platform for online ones', () => {
    const base = {
      title: 'Test Event',
      format: 'in_person' as const,
      visibility: 'public' as const,
      timezone: 'Asia/Kolkata',
      startsAt: '2026-05-01T10:00',
      endsAt: '2026-05-01T18:00',
      refundPolicy: 'no_refunds' as const,
    };

    const missingVenue = eventFormSchema.safeParse({ ...base, venueName: '' });
    expect(missingVenue.success).toBe(false);
    if (!missingVenue.success) {
      expect(missingVenue.error.issues.some((issue) => issue.path.includes('venueName'))).toBe(
        true,
      );
    }

    const onlineWithoutPlatform = eventFormSchema.safeParse({ ...base, format: 'online' });
    expect(onlineWithoutPlatform.success).toBe(false);
    if (!onlineWithoutPlatform.success) {
      expect(
        onlineWithoutPlatform.error.issues.some((issue) => issue.path.includes('accessPlatform')),
      ).toBe(true);
    }
  });

  it('refuses an event that ends before it starts', () => {
    const parsed = eventFormSchema.safeParse({
      title: 'Backwards Event',
      format: 'online',
      visibility: 'public',
      timezone: 'UTC',
      startsAt: '2026-05-01T18:00',
      endsAt: '2026-05-01T10:00',
      refundPolicy: 'no_refunds',
      accessPlatform: 'Zoom',
    });

    expect(parsed.success).toBe(false);
  });

  describe('cover image fields', () => {
    const base = {
      title: 'Test Event',
      format: 'in_person' as const,
      visibility: 'public' as const,
      timezone: 'Asia/Kolkata',
      startsAt: '2026-05-01T10:00',
      endsAt: '2026-05-01T18:00',
      refundPolicy: 'no_refunds' as const,
      venueName: 'Test Venue',
    };

    it('reads the removal checkbox the way browsers send it', () => {
      const checked = eventFormSchema.parse({ ...base, removeCoverImage: 'on' });
      expect(checked.removeCoverImage).toBe(true);

      // An unchecked box submits nothing at all.
      expect(eventFormSchema.parse({ ...base }).removeCoverImage).toBe(false);
      expect(eventFormSchema.parse({ ...base, removeCoverImage: '' }).removeCoverImage).toBe(false);
      expect(eventFormSchema.parse({ ...base, removeCoverImage: 'false' }).removeCoverImage).toBe(
        false,
      );
    });

    it('accepts a key the application could have issued', () => {
      const key = buildCoverImageKey('240bf3e6-d7c1-4cff-9648-9843963a55c0', 'image/webp');
      const parsed = eventFormSchema.safeParse({ ...base, coverImageKey: key });

      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.coverImageKey).toBe(key);
    });

    it('refuses a key it did not issue', () => {
      for (const key of [
        'events/240bf3e6-d7c1-4cff-9648-9843963a55c0/../../secrets.png',
        'events/00000000-0000-4000-8000-000000000000/not-a-random-name.png',
        'some-other-bucket-key',
      ]) {
        const parsed = eventFormSchema.safeParse({ ...base, coverImageKey: key });
        expect(parsed.success).toBe(false);
      }
    });

    it('treats an empty key as no key, so removing a cover is a plain submission', () => {
      const parsed = eventFormSchema.parse({ ...base, coverImageKey: '' });
      expect(parsed.coverImageKey).toBeUndefined();
    });
  });
});

describe('registration form parsing', () => {
  const ticketTypes = [
    { id: 'type-a', name: 'General', minPerOrder: 1, maxPerOrder: 4 },
    { id: 'type-b', name: 'Student', minPerOrder: 1, maxPerOrder: 2 },
  ];

  function buildForm(fields: Record<string, string>): FormData {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return form;
  }

  it('parses a complete submission', () => {
    const result = parseRegistrationForm(
      buildForm({
        buyerName: 'Ada Lovelace',
        buyerEmail: 'ada@example.com',
        'quantity__type-a': '2',
        'attendee_name__type-a__0': 'Ada Lovelace',
        'attendee_email__type-a__0': 'ada@example.com',
        'attendee_name__type-a__1': 'Charles Babbage',
        'attendee_email__type-a__1': 'charles@example.com',
      }),
      ticketTypes,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lines).toHaveLength(1);
      expect(result.value.lines[0]?.attendees).toHaveLength(2);
      expect(result.value.buyer.email).toBe('ada@example.com');
      // An absent phone field must not invalidate the submission.
      expect(result.value.lines[0]?.attendees[0]?.phone).toBeNull();
    }
  });

  it('parses multiple ticket types in one order', () => {
    const result = parseRegistrationForm(
      buildForm({
        buyerName: 'Ada Lovelace',
        buyerEmail: 'ada@example.com',
        'quantity__type-a': '1',
        'attendee_name__type-a__0': 'Ada Lovelace',
        'attendee_email__type-a__0': 'ada@example.com',
        'quantity__type-b': '2',
        'attendee_name__type-b__0': 'Student One',
        'attendee_email__type-b__0': 's1@example.com',
        'attendee_name__type-b__1': 'Student Two',
        'attendee_email__type-b__1': 's2@example.com',
      }),
      ticketTypes,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.lines).toHaveLength(2);
  });

  it('refuses a quantity that does not match the attendee blocks supplied', () => {
    // The obvious tamper: claim five tickets but name only one person.
    const result = parseRegistrationForm(
      buildForm({
        buyerName: 'Ada Lovelace',
        buyerEmail: 'ada@example.com',
        'quantity__type-a': '3',
        'attendee_name__type-a__0': 'Ada Lovelace',
        'attendee_email__type-a__0': 'ada@example.com',
      }),
      ticketTypes,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors['quantity__type-a']).toMatch(/provide details for all 3/i);
  });

  it('refuses an empty selection', () => {
    const result = parseRegistrationForm(
      buildForm({ buyerName: 'Ada Lovelace', buyerEmail: 'ada@example.com' }),
      ticketTypes,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors._form).toMatch(/select at least one ticket/i);
  });

  it('enforces the per-order maximum before the order is created', () => {
    const result = parseRegistrationForm(
      buildForm({
        buyerName: 'Ada Lovelace',
        buyerEmail: 'ada@example.com',
        'quantity__type-b': '3',
        'attendee_name__type-b__0': 'A',
        'attendee_email__type-b__0': 'a@example.com',
        'attendee_name__type-b__1': 'B',
        'attendee_email__type-b__1': 'b@example.com',
        'attendee_name__type-b__2': 'C',
        'attendee_email__type-b__2': 'c@example.com',
      }),
      ticketTypes,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors['quantity__type-b']).toMatch(/maximum of 2/i);
  });

  it('reports a bad attendee email against the field it came from', () => {
    const result = parseRegistrationForm(
      buildForm({
        buyerName: 'Ada Lovelace',
        buyerEmail: 'ada@example.com',
        'quantity__type-a': '1',
        'attendee_name__type-a__0': 'Ada Lovelace',
        'attendee_email__type-a__0': 'not-an-email',
      }),
      ticketTypes,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors['attendee_email__type-a__0']).toMatch(/valid email/i);
      // The buyer's own details were fine and must not be reported as broken.
      expect(result.errors.buyerEmail).toBeUndefined();
    }
  });

  it('ignores a ticket type with a quantity of zero', () => {
    const result = parseRegistrationForm(
      buildForm({
        buyerName: 'Ada Lovelace',
        buyerEmail: 'ada@example.com',
        'quantity__type-a': '0',
        'quantity__type-b': '1',
        'attendee_name__type-b__0': 'Student',
        'attendee_email__type-b__0': 'student@example.com',
      }),
      ticketTypes,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lines).toHaveLength(1);
      expect(result.value.lines[0]?.ticketTypeId).toBe('type-b');
    }
  });

  it('rejects a buyer with missing details', () => {
    const result = parseRegistrationForm(
      buildForm({
        'quantity__type-a': '1',
        'attendee_name__type-a__0': 'Ada Lovelace',
        'attendee_email__type-a__0': 'ada@example.com',
      }),
      ticketTypes,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.buyerName).toBeDefined();
      expect(result.errors.buyerEmail).toBeDefined();
    }
  });
});
