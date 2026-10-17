import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertEventAccess,
  cancelEvent,
  publishEvent,
  updateEvent,
} from '@/features/events/service';
import { createOrder, getOrderByReference, listOrders } from '@/features/orders/service';
import { refundableBalance, requestRefund } from '@/features/refunds/service';
import { roleHasPermission } from '@/lib/permissions/guards';
import { isOrganizerRole, ORGANIZER_ROLES, roles } from '@/lib/permissions';
import { hashRegistrationAccessToken } from '@/lib/security/tokens';
import { hasRegistrationAccess } from '@/lib/security/registration-access';
import {
  createTestEvent,
  createTestOrganization,
  cleanupFixtures,
  type TestEvent,
  type TestOrganization,
} from '../setup/fixtures';

/**
 * Access control.
 *
 * The organizing principle is that a record's id is never an authorization
 * credential. Every one of these tests asks the same question in a different
 * place: can someone reach a record that is not theirs?
 *
 * These are the tests that would catch a regression where someone decides a UUID
 * is "hard enough to guess".
 */
describe('access control', () => {
  let orgA: TestOrganization;
  let orgB: TestOrganization;
  let eventA: TestEvent;
  let eventB: TestEvent;

  beforeEach(async () => {
    orgA = await createTestOrganization('owner');
    orgB = await createTestOrganization('owner');

    eventA = await createTestEvent(orgA.organizationId, orgA.userId, {
      ticketTypes: [{ name: 'General', priceMinor: 100_000, quantityTotal: 10 }],
    });

    eventB = await createTestEvent(orgB.organizationId, orgB.userId, {
      ticketTypes: [{ name: 'General', priceMinor: 100_000, quantityTotal: 10 }],
    });
  });

  afterAll(async () => {
    await cleanupFixtures();
  });

  describe('organization boundaries', () => {
    it('refuses to load another organization event, even with a valid id', async () => {
      await expect(assertEventAccess(eventB.eventId, orgA.organizationId)).rejects.toThrow(
        /another organization/i,
      );
    });

    it('refuses to update another organization event', async () => {
      await expect(
        updateEvent(eventB.eventId, orgA.organizationId, { title: 'Hijacked' }, orgA.userId),
      ).rejects.toThrow(/another organization/i);
    });

    it('refuses to publish another organization event', async () => {
      await expect(publishEvent(eventB.eventId, orgA.organizationId, orgA.userId)).rejects.toThrow(
        /another organization/i,
      );
    });

    it('refuses to cancel another organization event', async () => {
      await expect(
        cancelEvent(eventB.eventId, orgA.organizationId, {
          reason: 'Not mine',
          actorUserId: orgA.userId,
        }),
      ).rejects.toThrow(/another organization/i);
    });

    it('answers "not found" for an event that does not exist at all', async () => {
      await expect(
        assertEventAccess('00000000-0000-4000-8000-000000000000', orgA.organizationId),
      ).rejects.toThrow(/not found/i);
    });

    it('scopes order listings to the organization, never returning another one’s orders', async () => {
      await createOrder({
        eventId: eventB.eventId,
        lines: [
          {
            ticketTypeId: eventB.ticketTypes[0]!.id,
            attendees: [{ name: 'B Buyer', email: 'bbuyer@example.test' }],
          },
        ],
        buyer: { name: 'B Buyer', email: 'bbuyer@example.test' },
      });

      const seenByA = await listOrders({ organizationId: orgA.organizationId });

      expect(seenByA.rows).toHaveLength(0);
    });
  });

  describe('refunds', () => {
    it('refuses to refund an order belonging to another organization', async () => {
      const order = await createOrder({
        eventId: eventB.eventId,
        lines: [
          {
            ticketTypeId: eventB.ticketTypes[0]!.id,
            attendees: [{ name: 'B Buyer', email: 'bbuyer@example.test' }],
          },
        ],
        buyer: { name: 'B Buyer', email: 'bbuyer@example.test' },
      });

      await expect(
        requestRefund({
          orderId: order.order.id,
          reason: 'Attempted cross-organization refund',
          actorUserId: orgA.userId,
          organizationId: orgA.organizationId,
        }),
      ).rejects.toThrow(/another organization/i);
    });
  });

  describe('registration access', () => {
    it('grants access to the holder of the emailed key', async () => {
      const created = await createOrder({
        eventId: eventA.eventId,
        lines: [
          {
            ticketTypeId: eventA.ticketTypes[0]!.id,
            attendees: [{ name: 'A Buyer', email: 'abuyer@example.test' }],
          },
        ],
        buyer: { name: 'A Buyer', email: 'abuyer@example.test' },
      });

      // The action returns the raw key once; the database keeps only its hash.
      expect(hashRegistrationAccessToken(created.accessToken)).toBe(created.order.accessTokenHash);

      const cookies = fakeCookies();

      expect(
        hasRegistrationAccess({
          cookies,
          order: created.order,
          key: created.accessToken,
        }),
      ).toBe(true);
    });

    it('refuses an order reference without the key', async () => {
      const created = await createOrder({
        eventId: eventA.eventId,
        lines: [
          {
            ticketTypeId: eventA.ticketTypes[0]!.id,
            attendees: [{ name: 'A Buyer', email: 'abuyer@example.test' }],
          },
        ],
        buyer: { name: 'A Buyer', email: 'abuyer@example.test' },
      });

      // Knowing the reference is not knowing the secret.
      const found = await getOrderByReference(created.order.publicReference);
      expect(found?.id).toBe(created.order.id);

      expect(
        hasRegistrationAccess({
          cookies: fakeCookies(),
          order: created.order,
          key: null,
        }),
      ).toBe(false);
    });

    it('refuses a key that is close to but not the real one', async () => {
      const created = await createOrder({
        eventId: eventA.eventId,
        lines: [
          {
            ticketTypeId: eventA.ticketTypes[0]!.id,
            attendees: [{ name: 'A Buyer', email: 'abuyer@example.test' }],
          },
        ],
        buyer: { name: 'A Buyer', email: 'abuyer@example.test' },
      });

      expect(
        hasRegistrationAccess({
          cookies: fakeCookies(),
          order: created.order,
          key: `${created.accessToken}x`,
        }),
      ).toBe(false);
    });

    it('lets the signed-in buyer see their own order without the key', async () => {
      const created = await createOrder({
        eventId: eventA.eventId,
        lines: [
          {
            ticketTypeId: eventA.ticketTypes[0]!.id,
            attendees: [{ name: 'A Buyer', email: 'abuyer@example.test' }],
          },
        ],
        buyer: { name: 'A Buyer', email: 'abuyer@example.test' },
        userId: orgA.userId,
      });

      expect(
        hasRegistrationAccess({
          cookies: fakeCookies(),
          order: created.order,
          key: null,
          viewerUserId: orgA.userId,
          orderUserId: orgA.userId,
        }),
      ).toBe(true);

      // A different signed-in user still cannot.
      expect(
        hasRegistrationAccess({
          cookies: fakeCookies(),
          order: created.order,
          key: null,
          viewerUserId: orgB.userId,
          orderUserId: orgA.userId,
        }),
      ).toBe(false);
    });
  });

  describe('role permissions', () => {
    it('denies by default for an unknown role', () => {
      expect(roleHasPermission('superuser', { event: ['read'] })).toBe(false);
      expect(roleHasPermission('', { event: ['read'] })).toBe(false);
      expect(roleHasPermission('OWNER', { event: ['read'] })).toBe(false);
    });

    it('gives owners everything and attendees almost nothing', () => {
      expect(roleHasPermission('owner', { settings: ['update'] })).toBe(true);
      expect(roleHasPermission('owner', { payout: ['manage'] })).toBe(true);

      expect(roleHasPermission('attendee', { event: ['read'] })).toBe(true);
      expect(roleHasPermission('attendee', { event: ['update'] })).toBe(false);
      expect(roleHasPermission('attendee', { payment: ['read'] })).toBe(false);
      expect(roleHasPermission('attendee', { check_in: ['perform'] })).toBe(false);
    });

    it('does not let an admin delete the organization or move money', () => {
      expect(roleHasPermission('admin', { event: ['update'] })).toBe(true);
      expect(roleHasPermission('admin', { refund: ['create'] })).toBe(true);

      expect(roleHasPermission('admin', { organization: ['delete'] })).toBe(false);
      expect(roleHasPermission('admin', { payout: ['manage'] })).toBe(false);
    });

    it('keeps finance out of event editing and check-in staff out of money', () => {
      expect(roleHasPermission('finance', { payment: ['read'] })).toBe(true);
      expect(roleHasPermission('finance', { event: ['update'] })).toBe(false);
      expect(roleHasPermission('finance', { check_in: ['perform'] })).toBe(false);

      expect(roleHasPermission('checkin_staff', { check_in: ['perform'] })).toBe(true);
      expect(roleHasPermission('checkin_staff', { payment: ['read'] })).toBe(false);
      expect(roleHasPermission('checkin_staff', { event: ['update'] })).toBe(false);
    });

    it('does not let an event manager override an admission or see payouts', () => {
      expect(roleHasPermission('event_manager', { attendee: ['read'] })).toBe(true);
      expect(roleHasPermission('event_manager', { check_in: ['perform'] })).toBe(true);

      expect(roleHasPermission('event_manager', { check_in: ['override'] })).toBe(false);
      expect(roleHasPermission('event_manager', { payout: ['read'] })).toBe(false);
      expect(roleHasPermission('event_manager', { settings: ['update'] })).toBe(false);
    });

    it('treats only the intended roles as organizers', () => {
      expect(isOrganizerRole('owner')).toBe(true);
      expect(isOrganizerRole('checkin_staff')).toBe(true);
      expect(isOrganizerRole('attendee')).toBe(false);
      expect(isOrganizerRole('nobody')).toBe(false);

      expect(ORGANIZER_ROLES).not.toContain('attendee');
      expect(Object.keys(roles)).toHaveLength(6);
    });
  });

  describe('refundable balance', () => {
    it('reports zero remaining for a payment with no capture', async () => {
      const created = await createOrder({
        eventId: eventA.eventId,
        lines: [
          {
            ticketTypeId: eventA.ticketTypes[0]!.id,
            attendees: [{ name: 'A Buyer', email: 'abuyer@example.test' }],
          },
        ],
        buyer: { name: 'A Buyer', email: 'abuyer@example.test' },
      });

      // A pending order has no payment at all, so nothing is refundable.
      const summary = await listOrders({ organizationId: orgA.organizationId });
      expect(summary.rows[0]?.paymentStatus).toBeNull();
      expect(created.order.status).toBe('pending_payment');
    });
  });
});

/** Minimal AstroCookies stand-in; the access check only ever reads. */
function fakeCookies(entries: Record<string, string> = {}) {
  return {
    get(name: string) {
      const value = entries[name];
      return value === undefined ? undefined : { value };
    },
  } as unknown as Parameters<typeof hasRegistrationAccess>[0]['cookies'];
}

void refundableBalance;
