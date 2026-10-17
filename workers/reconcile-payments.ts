/**
 * Reconciles payments whose outcome is unknown.
 *
 * This is the safety net for the cases the spec calls out explicitly: provider
 * timeouts, an abandoned checkout that was actually paid, a delayed confirmation,
 * and a capture whose amount does not match the internal order.
 *
 * Each candidate is queried at the provider and resolved through the same
 * idempotent path a webhook would use, so a recovered payment issues tickets
 * exactly once.
 *
 *   npx tsx workers/reconcile-payments.ts
 *   npx tsx workers/reconcile-payments.ts --loop 300
 */
import '../src/lib/security/load-env';
import { closeDatabase } from '../src/lib/db/client';
import { reconcileUnresolvedPayments } from '@/features/payments/service';
import { runLoop } from './run-loop';

export async function runOnce(): Promise<void> {
  const report = await reconcileUnresolvedPayments({
    limit: 50,
    // Leave a payment alone for a few minutes: the webhook has probably not
    // arrived yet, and querying the provider early is just noise.
    olderThanMinutes: 10,
  });

  if (report.checked === 0) return;

  console.log(
    `[reconcile-payments] checked ${report.checked}: ${report.recovered} recovered, ` +
      `${report.mismatched} needing review, ${report.failed} failed, ${report.stillPending} still pending`,
  );

  if (report.mismatched > 0) {
    // A mismatch means a captured payment whose amount does not match the order.
    // It is never resolved automatically: a human has to decide.
    console.warn(
      `[reconcile-payments] ${report.mismatched} payment(s) captured for the wrong amount — review the dashboard`,
    );
  }
}

runLoop('reconcile-payments', runOnce, closeDatabase);
