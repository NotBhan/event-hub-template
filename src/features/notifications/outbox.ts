import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { emailOutbox } from '@/lib/db/schema';
import type { DbExecutor } from '@/lib/db/types';
import { serverEnv } from '@/lib/security/env';
import { renderEmail, defaultTemplateContext } from './templates';
import { emailTransport } from './transports';
import type { NotificationType } from './types';

/**
 * Transactional email outbox.
 *
 * Messages are queued inside the same transaction that confirms an order, so a
 * committed order always has its notification recorded. Delivery happens later:
 * a mail provider outage can never roll back a payment, and failed sends are
 * retried explicitly rather than silently lost.
 */

export interface EnqueueEmailInput {
  organizationId?: string | null;
  recipient: string;
  type: NotificationType;
  /** Template data. Escaped during rendering. */
  data: Record<string, unknown>;
  renderContext?: { siteUrl?: string; brandName?: string };
  /** Defer delivery, e.g. for an event reminder. Defaults to now. */
  scheduledAt?: Date;
  subjectOverride?: string;
}

/**
 * Renders and queues a message. Safe to call inside a transaction: pass the
 * transaction as `executor`.
 */
export async function enqueueEmail(
  executor: DbExecutor,
  input: EnqueueEmailInput,
): Promise<string> {
  const base = defaultTemplateContext();
  const rendered = renderEmail(input.type, input.data, {
    siteUrl: input.renderContext?.siteUrl ?? base.siteUrl,
    brandName: input.renderContext?.brandName ?? base.brandName,
  });

  const [row] = await executor
    .insert(emailOutbox)
    .values({
      organizationId: input.organizationId ?? null,
      recipient: input.recipient,
      notificationType: input.type,
      subject: input.subjectOverride ?? rendered.subject,
      template: input.type,
      // The rendered body is stored too: the outbox keeps an exact record of
      // what was sent, independent of later template edits.
      payload: { data: input.data, rendered: { html: rendered.html, text: rendered.text } },
      scheduledAt: input.scheduledAt ?? new Date(),
    })
    .returning({ id: emailOutbox.id });

  if (!row) throw new Error('Failed to enqueue email');
  return row.id;
}

export interface ProcessOutboxOptions {
  /** Maximum messages to attempt in one pass. */
  limit?: number;
  /** Reference timestamp, injectable for tests. */
  now?: Date;
  log?: (message: string) => void;
}

export interface ProcessOutboxResult {
  attempted: number;
  sent: number;
  failed: number;
  abandoned: number;
}

/**
 * Delivers due messages.
 *
 * Rows are claimed with `FOR UPDATE SKIP LOCKED`, so several workers can run
 * concurrently without sending the same message twice.
 */
export async function processOutbox(
  options: ProcessOutboxOptions = {},
): Promise<ProcessOutboxResult> {
  const limit = options.limit ?? 25;
  const now = options.now ?? new Date();
  const log = options.log ?? (() => {});
  const transport = emailTransport();
  const from = serverEnv().EMAIL_FROM;

  const result: ProcessOutboxResult = { attempted: 0, sent: 0, failed: 0, abandoned: 0 };

  // Claim distinct rows first, then process each in its own transaction so one
  // bad message cannot block the rest of the batch.
  const claimed = await db().transaction(async (tx) => {
    const rows = await tx
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.status, 'pending'), lte(emailOutbox.scheduledAt, now)))
      .orderBy(asc(emailOutbox.scheduledAt))
      .limit(limit)
      .for('update', { skipLocked: true });

    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);
    await tx
      .update(emailOutbox)
      .set({ status: 'failed', lastError: 'claimed for delivery' })
      .where(sql`${emailOutbox.id} in ${ids}`);

    return ids;
  });

  for (const id of claimed) {
    result.attempted += 1;

    const [entry] = await db().select().from(emailOutbox).where(eq(emailOutbox.id, id)).limit(1);

    if (!entry) continue;

    const payload = (entry.payload ?? {}) as {
      rendered?: { html?: string; text?: string };
    };

    try {
      await transport.send({
        to: entry.recipient,
        from,
        subject: entry.subject,
        html: payload.rendered?.html ?? '',
        text: payload.rendered?.text ?? '',
      });

      await db()
        .update(emailOutbox)
        .set({ status: 'sent', sentAt: new Date(), lastError: null })
        .where(eq(emailOutbox.id, id));

      result.sent += 1;
      log(`sent ${entry.notificationType} to ${entry.recipient}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryCount = entry.retryCount + 1;
      const exhausted = retryCount >= entry.maxRetries;

      await db()
        .update(emailOutbox)
        .set({
          status: exhausted ? 'abandoned' : 'pending',
          retryCount,
          lastError: message,
          // Exponential backoff: 1, 2, 4, 8 ... minutes.
          scheduledAt: exhausted
            ? entry.scheduledAt
            : new Date(now.getTime() + 60_000 * 2 ** (retryCount - 1)),
        })
        .where(eq(emailOutbox.id, id));

      if (exhausted) result.abandoned += 1;
      else result.failed += 1;

      log(`failed ${entry.notificationType} to ${entry.recipient}: ${message}`);
    }
  }

  return result;
}
