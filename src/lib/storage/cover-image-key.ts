/**
 * Rules for object keys that identify an uploaded event cover.
 *
 * Kept apart from the storage client so request validation can check a key
 * without pulling the S3 SDK (and its credential resolution) into a module that
 * a page or an action may import.
 */

/**
 * `events/<event id>/<random>.<ext>`.
 *
 * The event id is in the key so an object stays attributable, and the random
 * suffix means replacing a cover never overwrites the file it replaces.
 *
 * The pattern is enforced on keys arriving from a form as well. Without it an
 * organizer could name any key in the bucket — reading, or overwriting, another
 * event's object.
 */
export const COVER_IMAGE_KEY_PATTERN =
  /^events\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9]{32}\.(png|jpg|webp)$/;

/** True when the value could be a key this application issued. */
export function isCoverImageKey(value: string): boolean {
  return COVER_IMAGE_KEY_PATTERN.test(value);
}
