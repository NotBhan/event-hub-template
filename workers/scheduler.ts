/**
 * Scheduler.
 *
 * Runs every maintenance task in one container. The deployment baseline asks for
 * a dedicated worker process, and a single process with an interval is the
 * simplest thing that satisfies it — no Redis, no broker, no cron daemon inside
 * the image.
 *
 * Every pass is wrapped so one failing task never stops the others.
 */
import '../src/lib/security/load-env';
import { closeDatabase } from '../src/lib/db/client';
import { runOnce as expireOrders } from './expire-orders';
import { runOnce as processObjectCleanup } from './process-object-cleanup';
import { runOnce as processOutbox } from './process-outbox';
import { runOnce as reconcilePayments } from './reconcile-payments';

interface Task {
  name: string;
  run: () => Promise<void>;
  everySeconds: number;
  lastRun: number;
}

const tasks: Task[] = [
  // Reservation expiry and email delivery are time-sensitive.
  { name: 'expire-orders', run: expireOrders, everySeconds: 60, lastRun: 0 },
  { name: 'process-outbox', run: processOutbox, everySeconds: 30, lastRun: 0 },
  // Object removal only ever runs after a failed attempt in a request, so it is
  // not urgent — but an object left behind stays behind until this runs.
  { name: 'process-object-cleanup', run: processObjectCleanup, everySeconds: 300, lastRun: 0 },
  // Reconciliation talks to the payment provider, so it runs far less often.
  { name: 'reconcile-payments', run: reconcilePayments, everySeconds: 300, lastRun: 0 },
];

// Deliberately small: the tick only decides which tasks are due, and each task
// does its own bounded amount of work.
const TICK_SECONDS = Number(process.env.SCHEDULER_TICK_SECONDS ?? 15);

let stopping = false;

async function tick(): Promise<void> {
  if (stopping) return;

  const now = Date.now();

  for (const task of tasks) {
    if (now - task.lastRun < task.everySeconds * 1000) continue;

    task.lastRun = now;

    try {
      await task.run();
    } catch (error) {
      // Keep the schedule running; the next tick will try again.
      console.error(`[scheduler] ${task.name} failed:`, error);
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;

  console.log(`[scheduler] received ${signal}, shutting down`);
  await closeDatabase().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

console.log(`[scheduler] started; tick every ${TICK_SECONDS}s`);

const timer = setInterval(() => void tick(), TICK_SECONDS * 1000);
timer.unref?.();

// First pass immediately, so a restart does not wait a full interval.
void tick();
