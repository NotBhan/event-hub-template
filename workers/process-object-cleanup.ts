/**
 * Removes objects that stopped being referenced.
 *
 * Replacing, removing or deleting an event's cover queues the object for deletion
 * inside the transaction that unreferenced it, and the application attempts that
 * deletion immediately. This worker is what happens when that attempt fails: a
 * bucket outage, an expired credential, a network that drops the request. Without
 * it, those objects would sit in the bucket forever with nothing pointing at them.
 *
 *   npx tsx workers/process-object-cleanup.ts            # one pass
 *   npx tsx workers/process-object-cleanup.ts --loop 60  # every 60 seconds
 */
import '../src/lib/security/load-env';
import { closeDatabase } from '../src/lib/db/client';
import { processObjectCleanup } from '@/features/storage/service';
import { runLoop } from './run-loop';

export async function runOnce(): Promise<void> {
  const result = await processObjectCleanup({
    limit: 50,
    log: (message) => console.log(`[process-object-cleanup] ${message}`),
  });

  if (result.attempted === 0) return;

  console.log(
    `[process-object-cleanup] ${result.deleted} deleted, ${result.failed} retrying, ${result.abandoned} abandoned`,
  );
}

runLoop('process-object-cleanup', runOnce, closeDatabase);
