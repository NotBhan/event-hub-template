import { auditLogs } from '@/lib/db/schema';
import type { DbExecutor } from '@/lib/db/types';

/**
 * Audit trail.
 *
 * Records the operations an investigation would need: publication and
 * cancellation, role changes, refund requests, ticket voiding and check-in
 * overrides. Metadata is deliberately minimal — no credentials, tokens or full
 * payment payloads.
 *
 * Failures here never break the operation being audited: an unwritable audit row
 * is a problem to alert on, not a reason to reject a legitimate payment.
 */

export type AuditAction =
  | 'event.created'
  | 'event.updated'
  | 'event.published'
  | 'event.cancelled'
  | 'ticket_type.created'
  | 'ticket_type.updated'
  | 'order.created'
  | 'order.confirmed'
  | 'order.expired'
  | 'order.cancelled'
  | 'payment.captured'
  | 'payment.failed'
  | 'payment.reconciled'
  | 'refund.requested'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'ticket.issued'
  | 'ticket.voided'
  | 'check_in.accepted'
  | 'check_in.rejected'
  | 'check_in.overridden'
  | 'member.role_changed'
  | 'member.removed'
  | 'settings.updated'
  | 'webhook.rejected';

export interface AuditInput {
  organizationId?: string | null;
  actorUserId?: string | null;
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(executor: DbExecutor, input: AuditInput): Promise<void> {
  try {
    await executor.insert(auditLogs).values({
      organizationId: input.organizationId ?? null,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      metadata: input.metadata ?? {},
    });
  } catch (error) {
    console.error('Failed to write audit log', { action: input.action, error });
  }
}
