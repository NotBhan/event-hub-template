import { describe, expect, it } from 'vitest';
import { isObjectMissing } from '@/lib/storage/object-storage';
import { errorChainMessage, postgresErrorCode } from '@/lib/db/errors';

/**
 * Storage error interpretation.
 *
 * Deleting an object is idempotent in principle and not in practice: providers
 * disagree about what to say when the key was never there, and an object removed
 * by hand from a console is a normal event. Reading those answers correctly is
 * what stops a cleanup that has already succeeded from being retried forever.
 */
describe('object storage errors', () => {
  it('reads the shapes a missing object arrives in', () => {
    expect(isObjectMissing(Object.assign(new Error('no such key'), { name: 'NoSuchKey' }))).toBe(
      true,
    );
    expect(isObjectMissing(Object.assign(new Error('not found'), { name: 'NotFound' }))).toBe(true);
    expect(isObjectMissing(Object.assign(new Error('gone'), { code: 'NoSuchKey' }))).toBe(true);
    expect(
      isObjectMissing(Object.assign(new Error('gone'), { $metadata: { httpStatusCode: 404 } })),
    ).toBe(true);
  });

  it('does not treat a real failure as an absence', () => {
    expect(isObjectMissing(Object.assign(new Error('denied'), { name: 'AccessDenied' }))).toBe(
      false,
    );
    expect(
      isObjectMissing(
        Object.assign(new Error('slow down'), { $metadata: { httpStatusCode: 503 } }),
      ),
    ).toBe(false);
    expect(isObjectMissing(new Error('socket hang up'))).toBe(false);
    expect(isObjectMissing(null)).toBe(false);
    expect(isObjectMissing('nope')).toBe(false);
  });

  it('still reads Drizzle-wrapped database errors, which is a different question', () => {
    const wrapped = Object.assign(new Error('Failed query: insert into events'), {
      cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
    });

    expect(postgresErrorCode(wrapped)).toBe('23505');
    expect(errorChainMessage(wrapped)).toMatch(/Failed query.*duplicate key/);
  });
});
