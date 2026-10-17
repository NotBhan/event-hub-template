import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { member } from '@/lib/db/schema';
import { isOrganizationRole, type OrganizationRole } from '@/lib/permissions';

/**
 * Resolves which organization a user is acting within, and with what role.
 *
 * A client deployment hosts a single organization, but the lookup still prefers
 * the session's active organization so the model stays correct if a future
 * deployment hosts more than one.
 */
export async function resolveMembership(
  userId: string,
  activeOrganizationId?: string | null,
): Promise<{ organizationId: string; role: OrganizationRole; memberId: string } | null> {
  const rows = await db()
    .select({
      id: member.id,
      organizationId: member.organizationId,
      role: member.role,
    })
    .from(member)
    .where(
      activeOrganizationId
        ? and(eq(member.userId, userId), eq(member.organizationId, activeOrganizationId))
        : eq(member.userId, userId),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // An unknown role must never be treated as a privileged one.
  if (!isOrganizationRole(row.role)) return null;

  return { organizationId: row.organizationId, role: row.role, memberId: row.id };
}
