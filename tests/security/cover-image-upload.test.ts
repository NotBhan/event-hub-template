import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIContext } from 'astro';
import { POST } from '@/pages/api/events/[id]/cover-image';
import { isCoverImageKey } from '@/lib/storage/cover-image-key';
import type { OrganizationRole } from '@/lib/permissions';
import {
  cleanupFixtures,
  closeFixtures,
  createTestEvent,
  createTestOrganization,
  type TestEvent,
  type TestOrganization,
} from '../setup/fixtures';

/**
 * Cover image upload authorization.
 *
 * The endpoint is reachable directly, so nothing about it may depend on the form
 * that usually calls it. These tests drive the handler itself, with the storage
 * client scripted, and ask the questions that matter: who is allowed to write an
 * object, and what is refused before anything is written.
 */
const storage = vi.hoisted(() => ({
  put: vi.fn<(key: string, body: Uint8Array, contentType: string) => Promise<void>>(),
  signedUrl: vi.fn<(key: string) => Promise<string | null>>(),
  configured: vi.fn(() => true),
}));

vi.mock('@/lib/storage/object-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/object-storage')>();

  return {
    ...actual,
    putCoverImage: storage.put,
    signedCoverImageUrl: storage.signedUrl,
    objectStorageConfigured: storage.configured,
    // The upload endpoint never deletes; the real one would talk to a bucket.
    deleteObject: vi.fn(async () => {}),
  };
});

const PNG_PREFIX = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  bytes.set(PNG_PREFIX);
  return bytes;
}

interface ContextOptions {
  role?: OrganizationRole | null;
  eventId?: string;
  organizationId?: string;
  file?: File | null;
  userId?: string | null;
}

function context(options: ContextOptions = {}) {
  const form = new FormData();
  if (options.file) form.set('file', options.file);

  const membership =
    options.role === null
      ? null
      : {
          organizationId: options.organizationId ?? '',
          role: options.role ?? 'owner',
          memberId: 'member-under-test',
        };

  return {
    locals: {
      user: options.userId === null ? null : { id: options.userId ?? 'user-under-test' },
      membership,
      session: null,
    },
    params: { id: options.eventId ?? '' },
    request: new Request('http://localhost/api/events/cover-image', { method: 'POST', body: form }),
  } as unknown as APIContext;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('cover image upload endpoint', () => {
  let org: TestOrganization;
  let event: TestEvent;

  beforeEach(async () => {
    storage.put.mockReset();
    storage.put.mockResolvedValue(undefined);
    storage.signedUrl.mockReset();
    storage.signedUrl.mockResolvedValue('https://storage.test/signed');
    storage.configured.mockReturnValue(true);

    org = await createTestOrganization('owner');
    event = await createTestEvent(org.organizationId, org.userId);
  });

  afterAll(async () => {
    await cleanupFixtures();
    await closeFixtures();
  });

  describe('authorization', () => {
    it('refuses a request with no session', async () => {
      const response = await POST(context({ userId: null, eventId: event.eventId }));

      expect(response.status).toBe(401);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('refuses a signed-in user with no organization membership', async () => {
      const response = await POST(context({ role: null, eventId: event.eventId }));

      expect(response.status).toBe(403);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('refuses a role that cannot change event artwork', async () => {
      const finance = await createTestOrganization('finance');

      const response = await POST(
        context({
          role: 'finance',
          userId: finance.userId,
          organizationId: finance.organizationId,
          eventId: event.eventId,
          file: new File([pngBytes()], 'cover.png', { type: 'image/png' }),
        }),
      );

      expect(response.status).toBe(403);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it("refuses to write an object for another organization's event", async () => {
      const other = await createTestOrganization('owner');

      const response = await POST(
        context({
          role: 'owner',
          userId: other.userId,
          organizationId: other.organizationId,
          eventId: event.eventId,
          file: new File([pngBytes()], 'cover.png', { type: 'image/png' }),
        }),
      );

      // Forbidden rather than not-found: the event exists, and this caller is not
      // entitled to it. Either way no object is written.
      expect(response.status).toBe(403);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('refuses an event that does not exist', async () => {
      const response = await POST(
        context({
          eventId: '00000000-0000-4000-8000-000000000000',
          organizationId: org.organizationId,
          userId: org.userId,
          file: new File([pngBytes()], 'cover.png', { type: 'image/png' }),
        }),
      );

      expect(response.status).toBe(404);
      expect(storage.put).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('reports a deployment without object storage rather than failing obscurely', async () => {
      storage.configured.mockReturnValue(false);

      const response = await POST(
        context({
          eventId: event.eventId,
          organizationId: org.organizationId,
          userId: org.userId,
          file: new File([pngBytes()], 'cover.png', { type: 'image/png' }),
        }),
      );

      expect(response.status).toBe(503);
      expect(await readJson(response)).toMatchObject({
        error: expect.stringMatching(/not configured/i),
      });
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('rejects a file whose bytes are not an image, whatever it claims to be', async () => {
      const response = await POST(
        context({
          eventId: event.eventId,
          organizationId: org.organizationId,
          userId: org.userId,
          // A script renamed to .png: the declared type is a claim, not evidence.
          file: new File(['<script>alert(1)</script>'], 'cover.png', { type: 'image/png' }),
        }),
      );

      expect(response.status).toBe(415);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('rejects an unsupported content type', async () => {
      const response = await POST(
        context({
          eventId: event.eventId,
          organizationId: org.organizationId,
          userId: org.userId,
          file: new File([pngBytes()], 'cover.gif', { type: 'image/gif' }),
        }),
      );

      expect(response.status).toBe(415);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('rejects a file larger than the limit', async () => {
      const oversized = new File([new Uint8Array(6 * 1024 * 1024)], 'cover.png', {
        type: 'image/png',
      });

      const response = await POST(
        context({
          eventId: event.eventId,
          organizationId: org.organizationId,
          userId: org.userId,
          file: oversized,
        }),
      );

      expect(response.status).toBe(413);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('rejects a request that carries no file', async () => {
      const response = await POST(
        context({
          eventId: event.eventId,
          organizationId: org.organizationId,
          userId: org.userId,
        }),
      );

      expect(response.status).toBe(400);
      expect(storage.put).not.toHaveBeenCalled();
    });
  });

  describe('storage failures', () => {
    it('answers with a 500 and a plain message when the bucket refuses the write', async () => {
      storage.put.mockRejectedValue(new Error('AccessDenied: secrets in the provider message'));

      const response = await POST(
        context({
          eventId: event.eventId,
          organizationId: org.organizationId,
          userId: org.userId,
          file: new File([pngBytes()], 'cover.png', { type: 'image/png' }),
        }),
      );

      expect(response.status).toBe(500);

      const body = await readJson(response);
      // The provider's message may name buckets, hosts or credentials.
      expect(body.error).not.toMatch(/AccessDenied|secret/i);
    });
  });

  describe('success', () => {
    it('stores the object under a key namespaced to the event and returns it', async () => {
      const response = await POST(
        context({
          eventId: event.eventId,
          organizationId: org.organizationId,
          userId: org.userId,
          file: new File([pngBytes(128)], 'cover.png', { type: 'image/png' }),
        }),
      );

      expect(response.status).toBe(200);

      const body = await readJson(response);
      expect(isCoverImageKey(String(body.key))).toBe(true);
      expect(String(body.key).startsWith(`events/${event.eventId}/`)).toBe(true);
      expect(body.url).toBe('https://storage.test/signed');
      expect(body.bytes).toBe(128);

      expect(storage.put).toHaveBeenCalledTimes(1);
      const [key, bytes, contentType] = storage.put.mock.calls[0]!;
      expect(key).toBe(body.key);
      expect(bytes.byteLength).toBe(128);
      expect(contentType).toBe('image/png');
      expect(storage.signedUrl).toHaveBeenCalledWith(body.key);
    });
  });
});
