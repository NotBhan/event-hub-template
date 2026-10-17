/**
 * Expires unpaid orders and releases their reserved inventory.
 *
 * Without this, an abandoned checkout would hold stock indefinitely and the event
 * would appear sold out while the seats sit empty.
 *
 * A single pass is the default so the script can be wired to any scheduler:
 *
 *   npx tsx workers/expire-orders.ts            # one pass
 *   npx tsx workers/expire-orders.ts --loop 60  # every 60 seconds
 */
import '../src/lib/security/load-env';
import { closeDatabase } from '../src/lib/db/client';
import { completePastEvents } from '../src/features/events/service';
import { expireAbandonedOrders } from '../src/features/orders/service';
import { runLoop } from './run-loop';

export async function runOnce(): Promise<void> {
  const expired = await expireAbandonedOrders({ limit: 200 });

  if (expired.expired > 0) {
    console.log(
      `[expire-orders] released ${expired.expired} abandoned reservation${expired.expired === 1 ? '' : 's'}`,
    );
  }

  // Also closes out events whose end time has passed, so the public listing and
  // the dashboard agree about what is still upcoming.
  const completed = await completePastEvents();
  if (completed > 0) {
    console.log(
      `[expire-orders] marked ${completed} finished event${completed === 1 ? '' : 's'} complete`,
    );
  }
}

runLoop('expire-orders', runOnce, closeDatabase);
