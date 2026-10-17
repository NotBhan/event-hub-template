import type { APIContext } from 'astro';
import { isOrganizerRole, ORGANIZER_ROLES, type OrganizationRole } from './index';

/**
 * Page-level authorization.
 *
 * Pages cannot throw an HTTP error the way an endpoint can — doing so would
 * render a 500. Instead a page asks for a guard and redirects when it is denied.
 *
 * Endpoints keep using `requirePermission`, which throws. Both paths consult the
 * same role definitions, so a page and its endpoint can never disagree about who
 * is allowed in.
 */

export interface OrganizerGuardSuccess {
  ok: true;
  membership: { organizationId: string; role: OrganizationRole; memberId: string };
  userId: string;
}

export interface OrganizerGuardFailure {
  ok: false;
  /** Where to send the visitor, or null when a 403 response is more honest. */
  redirectTo: string | null;
  reason: 'signed-out' | 'not-a-member' | 'not-an-organizer';
}

export type OrganizerGuard = OrganizerGuardSuccess | OrganizerGuardFailure;

/** Requires a signed-in user holding one of the organizer roles. */
export function organizerGuard(context: Pick<APIContext, 'locals' | 'url'>): OrganizerGuard {
  const { user, membership } = context.locals;

  if (!user) {
    return {
      ok: false,
      redirectTo: `/login?next=${encodeURIComponent(context.url.pathname)}`,
      reason: 'signed-out',
    };
  }

  if (!membership) {
    return {
      ok: false,
      redirectTo: '/dashboard/no-access?reason=not-a-member',
      reason: 'not-a-member',
    };
  }

  if (!isOrganizerRole(membership.role)) {
    return {
      ok: false,
      redirectTo: '/dashboard/no-access?reason=not-an-organizer',
      reason: 'not-an-organizer',
    };
  }

  return { ok: true, membership, userId: user.id };
}

/** Renders the "you do not have access" page, which is honest and not a 404. */
export function accessDeniedMessage(reason: OrganizerGuardFailure['reason']): {
  title: string;
  body: string;
} {
  switch (reason) {
    case 'not-a-member':
      return {
        title: 'No organizer access',
        body: 'Your account is not part of an organization on this deployment. Ask an owner to invite you as staff.',
      };
    case 'not-an-organizer':
      return {
        title: 'No organizer access',
        body: 'Your account does not have permission to open the organizer dashboard.',
      };
    default:
      return {
        title: 'Please sign in',
        body: `Sign in with one of these roles to continue: ${ORGANIZER_ROLES.join(', ')}.`,
      };
  }
}
