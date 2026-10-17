import type { APIRoute } from 'astro';
import { assertEventAccess } from '@/features/events/service';
import { HttpError } from '@/lib/security/errors';
import { roleHasPermission } from '@/lib/permissions/guards';
import {
  MAX_COVER_IMAGE_BYTES,
  buildCoverImageKey,
  objectStorageConfigured,
  putCoverImage,
  signedCoverImageUrl,
  type CoverImageContentType,
} from '@/lib/storage/object-storage';

/**
 * Cover image upload.
 *
 * The image goes straight to object storage and what the event form then carries
 * is a *key*, not a URL: signed read URLs expire, so one stored in the database
 * would rot within the hour. The response includes a freshly signed URL purely so
 * the form can show the upload immediately.
 *
 * Authorization mirrors the event update it feeds: the caller needs the event
 * update permission, and the event must belong to their organization. The event
 * id also namespaces the key, so an organizer cannot write outside their own
 * event's prefix.
 */
export const POST: APIRoute = async (ctx) => {
  const { user, membership } = ctx.locals;

  if (!user) return json({ error: 'Sign in to upload an image' }, 401);
  if (!membership) return json({ error: 'Your account has no organizer access' }, 403);

  if (!roleHasPermission(membership.role, { event: ['update'] })) {
    return json({ error: 'Your role cannot change event artwork' }, 403);
  }

  if (!objectStorageConfigured()) {
    return json({ error: 'Object storage is not configured on this deployment' }, 503);
  }

  const eventId = ctx.params.id;
  if (!eventId) return json({ error: 'Missing event id' }, 400);

  try {
    // Same ownership check as every other dashboard operation on an event.
    await assertEventAccess(eventId, membership.organizationId);

    let form: FormData;
    try {
      form = await ctx.request.formData();
    } catch {
      return json({ error: 'Send the image as multipart form data' }, 400);
    }

    const file = form.get('file');

    if (!(file instanceof File)) return json({ error: 'No image was included' }, 400);

    const contentType = file.type as CoverImageContentType;
    if (!ALLOWED_TYPES.includes(contentType)) {
      return json({ error: 'Upload a PNG, JPEG or WebP image' }, 415);
    }

    if (file.size === 0) return json({ error: 'That file is empty' }, 400);
    if (file.size > MAX_COVER_IMAGE_BYTES) {
      return json(
        {
          error: `Images must be ${Math.round(MAX_COVER_IMAGE_BYTES / (1024 * 1024))}MB or smaller`,
        },
        413,
      );
    }

    // The declared type is checked above, but a mislabelled file would otherwise
    // be stored and later served back under that type. The magic bytes decide.
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!looksLikeImage(bytes, contentType)) {
      return json({ error: 'That file is not a valid image' }, 415);
    }

    const key = buildCoverImageKey(eventId, contentType);
    await putCoverImage(key, bytes, contentType);

    return json({ key, url: await signedCoverImageUrl(key), bytes: file.size });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);

    console.error('Cover image upload failed', error);
    return json({ error: 'The upload could not be stored. Try again.' }, 500);
  }
};

const ALLOWED_TYPES: readonly CoverImageContentType[] = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * Signature check for the formats we accept.
 *
 * A browser-supplied content type is a claim, not evidence: renaming a script to
 * `.png` would otherwise be stored and served from the bucket as an image.
 */
function looksLikeImage(bytes: Uint8Array, contentType: CoverImageContentType): boolean {
  if (contentType === 'image/png') {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }

  if (contentType === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  // WebP is "RIFF....WEBP": the format marker sits at offset 8.
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
