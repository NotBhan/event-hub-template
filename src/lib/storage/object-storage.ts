import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { serverEnv } from '../security/env';

/**
 * Object storage for organizer-uploaded event artwork.
 *
 * Neon Object Storage speaks the S3 API, so this is the AWS SDK configured for
 * path-style addressing (Neon requires it) and pointed at the branch endpoint.
 * The credentials, endpoint and region arrive under AWS-standard names, which
 * means the SDK picks them up from the environment on its own — the only thing
 * this module adds is what the environment cannot express: which bucket, which
 * keys, and how long a read URL stays valid.
 *
 * The bucket is private, so nothing here returns a durable public URL. Objects
 * are addressed by their key, and a read URL is signed at render time. Storing a
 * signed URL in the database instead would look correct for an hour and then
 * serve broken images.
 */

export type CoverImageContentType = 'image/png' | 'image/jpeg' | 'image/webp';

/** Largest artwork we accept. Covers are page furniture, not photo archives. */
export const MAX_COVER_IMAGE_BYTES = 5 * 1024 * 1024;

const EXTENSIONS: Record<CoverImageContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** How long a signed read URL stays valid. Long enough for a page to be read. */
const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

let client: S3Client | undefined;

/** The S3 endpoint is present only where object storage has been provisioned. */
export function objectStorageConfigured(): boolean {
  return Boolean(process.env.AWS_ENDPOINT_URL_S3 && process.env.AWS_ACCESS_KEY_ID);
}

function s3(): S3Client {
  if (client) return client;

  if (!objectStorageConfigured()) {
    throw new Error(
      'Object storage is not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ' +
        'AWS_ENDPOINT_URL_S3 and AWS_REGION (run `neon deploy` to pull them).',
    );
  }

  client = new S3Client({ forcePathStyle: true });
  return client;
}

/**
 * Builds a storage key for a new upload.
 *
 * The random part is 32 hex characters, which is what the key pattern in
 * `cover-image-key.ts` accepts — the two must agree, or a key this module writes
 * is one the form validator rejects on the next save.
 */
export function buildCoverImageKey(eventId: string, contentType: CoverImageContentType): string {
  const random = randomUUID().replace(/-/g, '');
  return `events/${eventId}/${random}.${EXTENSIONS[contentType]}`;
}

function bucket(): string {
  return serverEnv().S3_BUCKET;
}

export async function putCoverImage(
  key: string,
  body: Uint8Array,
  contentType: CoverImageContentType,
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      // Artwork is immutable: the key changes whenever the image does.
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
}

/** Signs a read URL for an object, or returns null when storage is absent. */
export async function signedCoverImageUrl(key: string): Promise<string | null> {
  if (!objectStorageConfigured()) return null;

  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: SIGNED_URL_TTL_SECONDS,
  });
}

/**
 * Removes an object. A missing object is not an error: the goal is its absence.
 *
 * Throws when storage is not configured rather than returning quietly. "There is
 * no bucket" and "the object is gone" are different facts, and only the second
 * one means the cleanup is finished — a caller that treats them the same would
 * discard real cleanup work the moment credentials were rotated.
 */
export async function deleteObject(key: string): Promise<void> {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (error) {
    if (isObjectMissing(error)) return;
    throw error;
  }
}

/**
 * True when the provider says the object was not there.
 *
 * S3's DELETE is idempotent and answers 204 for a key that does not exist, but
 * S3-compatible providers are not obliged to, and a key deleted by hand from a
 * console is a normal event rather than a failure.
 */
export function isObjectMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as {
    name?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };

  if (candidate.name === 'NoSuchKey' || candidate.name === 'NotFound') return true;
  if (candidate.code === 'NoSuchKey' || candidate.code === 'NotFound') return true;

  return candidate.$metadata?.httpStatusCode === 404;
}

/**
 * The URL a page should render for an event cover.
 *
 * An uploaded object wins over an externally hosted URL, because uploading one is
 * the deliberate act. Signing happens per request, so a key whose object has gone
 * missing degrades to the external URL rather than to a broken image.
 */
export async function resolveCoverImageUrl(
  key: string | null | undefined,
  externalUrl: string | null | undefined,
): Promise<string | null> {
  if (key) {
    const signed = await signedCoverImageUrl(key);
    if (signed) return signed;
  }

  return externalUrl ?? null;
}
