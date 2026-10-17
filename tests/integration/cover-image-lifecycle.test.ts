import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { events, objectCleanupQueue, ticketTypes } from '@/lib/db/schema';
import { deleteEvent, updateEvent } from '@/features/events/service';
import { processObjectCleanup } from '@/features/storage/service';
import { buildCoverImageKey } from '@/lib/storage/object-storage';
import { createOrder, confirmOrder } from '@/features/orders/service';
import {
  cleanupFixtures,
  closeFixtures,
  createTestEvent,
  createTestOrganization,
  oneAttendee,
  type TestEvent,
  type TestOrganization,
} from '../setup/fixtures';

/**
 * Cover image lifecycle.
 *
 * The bucket and the database are two systems, and the interesting failures all
 * live in the gap between them: an update that commits while the delete does not,
 * a deletion that fails, a retry ceiling that is reached. These tests hold the
 * storage client to a script so each of those gaps can be opened deliberately —
 * there is no way to make a real bucket fail on demand.
 *
 * `deleteObject` is replaced; everything else in the storage module (the key
 * builder in particular) stays real, so the keys under test are the keys the
 * application actually issues.
 */
const storage = vi.hoisted(() => ({
  deleteObject: vi.fn<(key: string) => Promise<void>>(),
  configured: vi.fn(() => true),
}));

vi.mock('@/lib/storage/object-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/object-storage')>();

  return {
    ...actual,
    deleteObject: storage.deleteObject,
    objectStorageConfigured: storage.configured,
  };
});

const coverKey = (eventId: string) => buildCoverImageKey(eventId, 'image/png');

async function readEvent(eventId: string) {
  const [row] = await db().select().from(events).where(eq(events.id, eventId)).limit(1);
  return row;
}

async function readQueue(key: string) {
  const [row] = await db()
    .select()
    .from(objectCleanupQueue)
    .where(eq(objectCleanupQueue.objectKey, key))
    .limit(1);
  return row;
}

describe('cover image lifecycle', () => {
  let org: TestOrganization;
  let event: TestEvent;

  beforeEach(async () => {
    storage.deleteObject.mockReset();
    storage.deleteObject.mockResolvedValue(undefined);
    storage.configured.mockReturnValue(true);

    org = await createTestOrganization('owner');
    event = await createTestEvent(org.organizationId, org.userId);
  });

  afterAll(async () => {
    await cleanupFixtures();
    await closeFixtures();
  });

  describe('replacing a cover', () => {
    it('deletes the object it replaced, and leaves nothing queued', async () => {
      const first = coverKey(event.eventId);
      const second = coverKey(event.eventId);

      await updateEvent(event.eventId, org.organizationId, { coverImageKey: first }, org.userId);
      expect(storage.deleteObject).not.toHaveBeenCalled();

      await updateEvent(event.eventId, org.organizationId, { coverImageKey: second }, org.userId);

      expect(storage.deleteObject).toHaveBeenCalledWith(first);
      expect(await readQueue(first)).toBeUndefined();
      expect((await readEvent(event.eventId))?.coverImageKey).toBe(second);
    });

    it('keeps the edit when the bucket refuses, and queues the object for retry', async () => {
      const first = coverKey(event.eventId);
      const second = coverKey(event.eventId);

      await updateEvent(event.eventId, org.organizationId, { coverImageKey: first }, org.userId);

      storage.deleteObject.mockRejectedValue(new Error('bucket unavailable'));

      await expect(
        updateEvent(event.eventId, org.organizationId, { coverImageKey: second }, org.userId),
      ).resolves.toBeDefined();

      // The organizer's change is saved; the object is what is outstanding.
      expect((await readEvent(event.eventId))?.coverImageKey).toBe(second);

      const queued = await readQueue(first);
      expect(queued?.status).toBe('pending');
      expect(queued?.retryCount).toBe(1);
      expect(queued?.reason).toBe('cover_replaced');
      expect(queued?.lastError).toMatch(/bucket unavailable/);
    });

    it('completes a queued deletion on a later sweep, once storage recovers', async () => {
      const first = coverKey(event.eventId);
      const second = coverKey(event.eventId);

      await updateEvent(event.eventId, org.organizationId, { coverImageKey: first }, org.userId);

      storage.deleteObject.mockRejectedValue(new Error('bucket unavailable'));
      await updateEvent(event.eventId, org.organizationId, { coverImageKey: second }, org.userId);
      expect(await readQueue(first)).toBeDefined();

      storage.deleteObject.mockResolvedValue(undefined);

      const result = await processObjectCleanup({
        keys: [first],
        // Past the exponential backoff the failure scheduled.
        now: new Date(Date.now() + 10 * 60_000),
      });

      expect(result.deleted).toBe(1);
      expect(await readQueue(first)).toBeUndefined();
      expect(storage.deleteObject).toHaveBeenLastCalledWith(first);
    });

    it('gives up visibly rather than dropping an object it cannot delete', async () => {
      const first = coverKey(event.eventId);

      storage.deleteObject.mockRejectedValue(new Error('access denied'));

      await updateEvent(event.eventId, org.organizationId, { coverImageKey: first }, org.userId);
      await updateEvent(
        event.eventId,
        org.organizationId,
        { coverImageKey: coverKey(event.eventId) },
        org.userId,
      );

      // Sweep until the retry ceiling is reached, each time past the backoff.
      let abandoned = 0;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const result = await processObjectCleanup({
          keys: [first],
          now: new Date(Date.now() + 60 * 60_000 * (attempt + 1)),
        });
        abandoned += result.abandoned;
      }

      const queued = await readQueue(first);
      expect(abandoned).toBe(1);
      expect(queued?.status).toBe('abandoned');
      expect(queued?.retryCount).toBeGreaterThanOrEqual(queued?.maxRetries ?? 0);
    });

    it('keeps the work queued while storage is unconfigured instead of discarding it', async () => {
      const first = coverKey(event.eventId);

      storage.configured.mockReturnValue(false);
      storage.deleteObject.mockRejectedValue(new Error('storage not configured'));

      await updateEvent(event.eventId, org.organizationId, { coverImageKey: first }, org.userId);
      await updateEvent(
        event.eventId,
        org.organizationId,
        { coverImageKey: coverKey(event.eventId) },
        org.userId,
      );

      const result = await processObjectCleanup({
        keys: [first],
        // Past the backoff the previous attempt scheduled.
        now: new Date(Date.now() + 10 * 60_000),
      });

      expect(result.failed).toBe(1);
      expect((await readQueue(first))?.status).toBe('pending');
      expect((await readQueue(first))?.lastError).toMatch(/not configured/i);
    });
  });

  describe('removing a cover', () => {
    it('clears the key and the URL, and deletes the uploaded object', async () => {
      const key = coverKey(event.eventId);

      await updateEvent(
        event.eventId,
        org.organizationId,
        { coverImageKey: key, coverImageUrl: 'https://example.test/old-cover.png' },
        org.userId,
      );

      // What the form submits when the organizer ticks "remove".
      await updateEvent(
        event.eventId,
        org.organizationId,
        { removeCoverImage: true, coverImageKey: key },
        org.userId,
      );

      const row = await readEvent(event.eventId);
      expect(row?.coverImageKey).toBeNull();
      expect(row?.coverImageUrl).toBeNull();
      expect(storage.deleteObject).toHaveBeenCalledWith(key);
      expect(await readQueue(key)).toBeUndefined();
    });

    it('cleans up an upload that arrived with the removal', async () => {
      const stored = coverKey(event.eventId);
      const discarded = coverKey(event.eventId);

      await updateEvent(event.eventId, org.organizationId, { coverImageKey: stored }, org.userId);

      // Removal wins, but the uploaded object must not be left in the bucket.
      await updateEvent(
        event.eventId,
        org.organizationId,
        { removeCoverImage: true, coverImageKey: discarded },
        org.userId,
      );

      expect((await readEvent(event.eventId))?.coverImageKey).toBeNull();
      expect(storage.deleteObject).toHaveBeenCalledWith(stored);
      expect(storage.deleteObject).toHaveBeenCalledWith(discarded);
      expect(await readQueue(stored)).toBeUndefined();
      expect(await readQueue(discarded)).toBeUndefined();
    });

    it('clears the database even when the object cannot be removed', async () => {
      const key = coverKey(event.eventId);

      await updateEvent(event.eventId, org.organizationId, { coverImageKey: key }, org.userId);

      storage.deleteObject.mockRejectedValue(new Error('bucket unavailable'));

      await updateEvent(
        event.eventId,
        org.organizationId,
        { removeCoverImage: true, coverImageKey: key },
        org.userId,
      );

      expect((await readEvent(event.eventId))?.coverImageKey).toBeNull();

      const queued = await readQueue(key);
      expect(queued?.status).toBe('pending');
      expect(queued?.reason).toBe('cover_removed');
    });

    it('does not touch storage for an event that never had a cover', async () => {
      await updateEvent(event.eventId, org.organizationId, { removeCoverImage: true }, org.userId);

      expect(storage.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('failed updates', () => {
    it('changes nothing when the event would end before it starts', async () => {
      const before = await readEvent(event.eventId);
      const key = coverKey(event.eventId);

      await updateEvent(event.eventId, org.organizationId, { coverImageKey: key }, org.userId);

      await expect(
        updateEvent(
          event.eventId,
          org.organizationId,
          {
            title: 'Renamed while invalid',
            startsAt: new Date('2030-01-02T10:00:00Z'),
            endsAt: new Date('2030-01-01T10:00:00Z'),
          },
          org.userId,
        ),
      ).rejects.toThrow(/end after it starts/i);

      const after = await readEvent(event.eventId);
      expect(after?.title).toBe(before?.title);
      expect(after?.endsAt).toEqual(before?.endsAt);
      // The rejected update must not have queued anything either.
      expect(await readQueue(key)).toBeUndefined();
    });
  });

  describe('deleting an event', () => {
    it('removes the event, its cascading rows and its cover object', async () => {
      const key = coverKey(event.eventId);
      await updateEvent(event.eventId, org.organizationId, { coverImageKey: key }, org.userId);

      await deleteEvent(event.eventId, org.organizationId, org.userId);

      expect(await readEvent(event.eventId)).toBeUndefined();
      expect(
        await db().select().from(ticketTypes).where(eq(ticketTypes.eventId, event.eventId)),
      ).toHaveLength(0);

      expect(storage.deleteObject).toHaveBeenCalledWith(key);
      expect(await readQueue(key)).toBeUndefined();
    });

    it('keeps the object queued when the deletion of the event succeeds but storage fails', async () => {
      const key = coverKey(event.eventId);
      await updateEvent(event.eventId, org.organizationId, { coverImageKey: key }, org.userId);

      storage.deleteObject.mockRejectedValue(new Error('bucket unavailable'));

      await deleteEvent(event.eventId, org.organizationId, org.userId);

      expect(await readEvent(event.eventId)).toBeUndefined();

      const queued = await readQueue(key);
      expect(queued?.status).toBe('pending');
      expect(queued?.reason).toBe('event_deleted');
    });

    it('refuses to delete an event that has registrations, and deletes nothing', async () => {
      const order = await createOrder({
        eventId: event.eventId,
        lines: [{ ticketTypeId: event.ticketTypes[0]!.id, attendees: oneAttendee() }],
        buyer: { name: 'Ada Lovelace', email: 'ada@example.test' },
      });
      await confirmOrder({ orderId: order.order.id });

      const key = coverKey(event.eventId);
      await updateEvent(event.eventId, org.organizationId, { coverImageKey: key }, org.userId);

      await expect(deleteEvent(event.eventId, org.organizationId, org.userId)).rejects.toThrow(
        /cannot be deleted/i,
      );

      // Nothing irreversible happened: the event, its object and the audit trail
      // are all where they were.
      expect(await readEvent(event.eventId)).toBeDefined();
      expect((await readEvent(event.eventId))?.coverImageKey).toBe(key);
      expect(await readQueue(key)).toBeUndefined();
    });

    it('refuses an event from another organization before doing anything irreversible', async () => {
      const other = await createTestOrganization('owner');
      const key = coverKey(event.eventId);
      await updateEvent(event.eventId, org.organizationId, { coverImageKey: key }, org.userId);

      await expect(deleteEvent(event.eventId, other.organizationId, other.userId)).rejects.toThrow(
        /another organization/i,
      );

      expect(await readEvent(event.eventId)).toBeDefined();
      expect(await readQueue(key)).toBeUndefined();
    });

    it('refuses an event that does not exist', async () => {
      await expect(
        deleteEvent('00000000-0000-4000-8000-000000000000', org.organizationId, org.userId),
      ).rejects.toThrow(/not found/i);
    });
  });
});
