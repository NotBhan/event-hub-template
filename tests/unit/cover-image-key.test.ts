import { describe, expect, it } from 'vitest';
import { isCoverImageKey } from '@/lib/storage/cover-image-key';
import { buildCoverImageKey } from '@/lib/storage/object-storage';

/**
 * The key pattern is what stops a crafted form submission from naming an object
 * that belongs to another event, so it is worth pinning: both that it refuses
 * anything the application did not issue, and that it accepts what it does issue.
 */
describe('cover image keys', () => {
  const eventId = '240bf3e6-d7c1-4cff-9648-9843963a55c0';

  it('accepts a key the application built', () => {
    for (const contentType of ['image/png', 'image/jpeg', 'image/webp'] as const) {
      const key = buildCoverImageKey(eventId, contentType);
      expect(isCoverImageKey(key)).toBe(true);
    }
  });

  it('namespaces the key by event, so one event cannot write over another', () => {
    const key = buildCoverImageKey(eventId, 'image/png');
    return expect(key.startsWith(`events/${eventId}/`)).toBe(true);
  });

  it('issues a fresh key every time, so replacing a cover keeps the old object', () => {
    const first = buildCoverImageKey(eventId, 'image/png');
    const second = buildCoverImageKey(eventId, 'image/png');
    expect(first).not.toBe(second);
  });

  it('refuses keys that were not issued by the application', () => {
    const rejected = [
      '',
      'events/240bf3e6-d7c1-4cff-9648-9843963a55c0/short.png',
      'events/240bf3e6-d7c1-4cff-9648-9843963a55c0/../../secrets.png',
      'events/240bf3e6-d7c1-4cff-9648-9843963a55c0/abcdef0123456789abcdef0123456789.svg',
      'other-prefix/240bf3e6-d7c1-4cff-9648-9843963a55c0/abcdef0123456789abcdef0123456789.png',
      'events/not-a-uuid/abcdef0123456789abcdef0123456789.png',
    ];

    for (const value of rejected) {
      expect(isCoverImageKey(value)).toBe(false);
    }
  });
});
