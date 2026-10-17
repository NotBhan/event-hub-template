/**
 * Delivers queued transactional email.
 *
 * Messages are queued inside the transaction that confirmed an order, so a
 * confirmed order always has its notification recorded. This worker is what
 * actually sends them, with backoff and a retry ceiling.
 *
 *   npx tsx workers/process-outbox.ts
 *   npx tsx workers/process-outbox.ts --loop 30
 */
import '../src/lib/security/load-env';
import { closeDatabase } from '../src/lib/db/client';
import { processOutbox } from '@/features/notifications/outbox';
import { runLoop } from './run-loop';

export async function runOnce(): Promise<void> {
  const result = await processOutbox({
    limit: 25,
    log: (message) => console.log(`[process-outbox] ${message}`),
  });

  if (result.attempted > 0) {
    console.log(
      `[process-outbox] ${result.sent} sent, ${result.failed} retrying, ${result.abandoned} abandoned`,
    );
  }
}

runLoop('process-outbox', runOnce, closeDatabase);
