import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { objectCleanupQueue, type ObjectCleanupEntry } from '@/lib/db/schema';
import type { DbExecutor } from '@/lib/db/types';
import { deleteObject, objectStorageConfigured } from '@/lib/storage/object-storage';

/**
 * Object cleanup.
 *
 * Uploaded covers become unreferenced when they are replaced, removed or when
 * their event is deleted. The row that stopped referring to the object is written
 * in a transaction; the bucket is a different system entirely, so removing the
 * object happens afterwards and can fail.
 *
 * The rule this module exists to enforce is that a committed change never loses
 * the cleanup it implies:
 *
 *  1. `queueObjectDeletion` runs *inside* the transaction that unreferences the
 *     key, so an object can never be orphaned by a crash between the two.
 *  2. The caller then attempts the deletion immediately, which is what makes the
 *     common case invisible to the operator.
 *  3. If that attempt fails, the row stays and is retried with backoff. After the
 *     retry ceiling it is marked `abandoned` rather than dropped — storage that
 *     will not cooperate is a fact someone needs to see.
 *
 * Nothing here deletes an object that a row still points at: every entry is
 * created after the database has stopped referencing the key.
 */

export type ObjectCleanupReason = ObjectCleanupEntry['reason'];

export interface QueueObjectDeletionInput {
  key: string;
  reason: ObjectCleanupReason;
}

/**
 * Records the intent to delete an object. Safe to call inside a transaction:
 * pass the transaction as `executor`.
 *
 * Re-queuing a key resets the row's retries: a fresh decision that an object
 * should go deserves a fresh set of attempts, and the alternative — inheriting an
 * exhausted counter — would leave a user-initiated deletion waiting on a sweep
 * that has already given up.
 */
export async function queueObjectDeletion(
  executor: DbExecutor,
  input: QueueObjectDeletionInput,
): Promise<void> {
  await executor
    .insert(objectCleanupQueue)
    .values({ objectKey: input.key, reason: input.reason, scheduledAt: new Date() })
    .onConflictDoUpdate({
      target: objectCleanupQueue.objectKey,
      set: {
        reason: input.reason,
        status: 'pending',
        retryCount: 0,
        lastError: null,
        scheduledAt: new Date(),
      },
    });
}

export interface ProcessObjectCleanupOptions {
  /** Maximum objects to attempt in one pass. */
  limit?: number;
  /** Restrict the pass to particular keys, for a cleanup the caller wants now. */
  keys?: string[];
  /** Reference timestamp, injectable for tests. */
  now?: Date;
  log?: (message: string) => void;
}

export interface ProcessObjectCleanupResult {
  attempted: number;
  deleted: number;
  failed: number;
  abandoned: number;
}

/**
 * Attempts due deletions.
 *
 * Rows are claimed with `FOR UPDATE SKIP LOCKED`, so several workers can run at
 * once without deleting the same object twice. Each is then processed on its own,
 * so one object the provider refuses to remove cannot block the rest.
 */
export async function processObjectCleanup(
  options: ProcessObjectCleanupOptions = {},
): Promise<ProcessObjectCleanupResult> {
  const limit = options.limit ?? 25;
  const now = options.now ?? new Date();
  const log = options.log ?? (() => {});

  const result: ProcessObjectCleanupResult = { attempted: 0, deleted: 0, failed: 0, abandoned: 0 };

  const claimed = await claimDueCleanups({ limit, now, keys: options.keys });
  if (claimed.length === 0) return result;

  /**
   * Storage that is not configured cannot have stored anything, but it also
   * cannot prove absence — so the work stays queued instead of being thrown away.
   * Retrying costs nothing and the alternative would silently declare victory
   * during a credential rotation.
   */
  if (!objectStorageConfigured()) {
    for (const entry of claimed) {
      await recordFailure(entry, 'Object storage is not configured', now);
      result.attempted += 1;
      result.failed += 1;
    }

    log(`${claimed.length} object(s) waiting: object storage is not configured`);
    return result;
  }

  for (const entry of claimed) {
    result.attempted += 1;

    try {
      await deleteObject(entry.objectKey);
      await db().delete(objectCleanupQueue).where(eq(objectCleanupQueue.id, entry.id));

      result.deleted += 1;
      log(`deleted ${entry.objectKey} (${entry.reason})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { exhausted } = await recordFailure(entry, message, now);

      if (exhausted) result.abandoned += 1;
      else result.failed += 1;

      log(`failed to delete ${entry.objectKey}: ${message}`);
    }
  }

  return result;
}

/**
 * Attempts one key's deletion and returns whether the object is gone.
 *
 * The eager path used right after a transaction commits. It reuses the queue so
 * that a failure here lands in exactly the state a failure in the worker would.
 */
export async function attemptObjectCleanup(key: string, log?: (message: string) => void) {
  const result = await processObjectCleanup({ keys: [key], limit: 1, log });
  return { deleted: result.deleted === 1, result };
}

interface ClaimOptions {
  limit: number;
  now: Date;
  keys?: string[];
}

/** Marks the given rows as in-flight so concurrent passes skip them. */
async function claimDueCleanups(options: ClaimOptions): Promise<ObjectCleanupEntry[]> {
  // Due-ness is compared against the application clock on both sides, so the
  // eager attempt that follows a commit never depends on the database's clock
  // agreeing with this process's.
  const conditions = [
    eq(objectCleanupQueue.status, 'pending'),
    lte(objectCleanupQueue.scheduledAt, options.now),
  ];

  if (options.keys) conditions.push(inArray(objectCleanupQueue.objectKey, options.keys));

  return db().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(objectCleanupQueue)
      .where(and(...conditions))
      .orderBy(asc(objectCleanupQueue.scheduledAt))
      .limit(options.limit)
      .for('update', { skipLocked: true });

    if (rows.length === 0) return [];

    // Push the claimed rows a little into the future: a second worker starting
    // now will not pick them up, and a crash does not strand them beyond the
    // backoff window.
    await tx
      .update(objectCleanupQueue)
      .set({ scheduledAt: new Date(options.now.getTime() + CLAIM_WINDOW_MS) })
      .where(sql`${objectCleanupQueue.id} in ${rows.map((row) => row.id)}`);

    return rows;
  });
}

/**
 * Five minutes, comfortably longer than deleting an object takes, so only a real
 * crash leaves a row waiting for its next turn.
 */
const CLAIM_WINDOW_MS = 5 * 60 * 1000;

/**
 * Records a failed attempt, backing off exponentially and giving up at the
 * ceiling.
 *
 * A row that exhausts its retries is marked `abandoned`, not deleted: it means an
 * object is still in the bucket and someone should know.
 */
async function recordFailure(
  entry: ObjectCleanupEntry,
  message: string,
  now: Date,
): Promise<{ exhausted: boolean }> {
  const retryCount = entry.retryCount + 1;
  const exhausted = retryCount >= entry.maxRetries;

  await db()
    .update(objectCleanupQueue)
    .set({
      status: exhausted ? 'abandoned' : 'pending',
      retryCount,
      lastError: message,
      // Exponential backoff: 1, 2, 4, 8 ... minutes, matching the email outbox.
      scheduledAt: exhausted
        ? entry.scheduledAt
        : new Date(now.getTime() + 60_000 * 2 ** (retryCount - 1)),
    })
    .where(eq(objectCleanupQueue.id, entry.id));

  return { exhausted };
}
