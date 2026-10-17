import type { APIContext } from 'astro';
import {
  ForbiddenError,
  UnauthorizedError,
} from '@/lib/security/errors';
import { roles, isOrganizerRole, type OrganizationRole, type PermissionResource } from './index';

/**
 * Server-side authorization helpers.
 *
 * Every protected page and endpoint calls one of these before touching data.
 * Permission checks are deny-by-default: an unknown role, a missing membership or
 * a resource the role does not list all resolve to "not allowed".
 */

/** Request for a set of permissions, e.g. `{ event: ['create', 'publish'] }`. */
export type PermissionRequest = {
  [resource in PermissionResource]?: readonly string[];
};

export function roleHasPermission(role: string, request: PermissionRequest): boolean {
  if (typeof role !== 'string' || !Object.hasOwn(roles, role)) return false;

  const definition = roles[role as OrganizationRole];
  const result = definition.authorize(request as Parameters<typeof definition.authorize>[0]);
  return result.success;
}

/** The authenticated user, or a 401. */
export function requireUser(context: Pick<APIContext, 'locals'>) {
  const { user } = context.locals;
  if (!user) throw new UnauthorizedError();
  return user;
}

/** The authenticated user's organization membership, or a 403. */
export function requireMembership(context: Pick<APIContext, 'locals'>) {
  requireUser(context);

  const { membership } = context.locals;
  if (!membership) {
    throw new ForbiddenError('Your account does not have access to an organization');
  }

  return membership;
}

/** A membership with one of the organizer roles, or a 403. */
export function requireOrganizer(context: Pick<APIContext, 'locals'>) {
  const membership = requireMembership(context);

  if (!isOrganizerRole(membership.role)) {
    throw new ForbiddenError('Your account does not have organizer access');
  }

  return membership;
}

/**
 * A membership holding every requested permission, or a 403.
 *
 * Resource-level access (does this event belong to this organization?) is a
 * separate check performed by the service that loads the record — see
 * `assertEventAccess`.
 */
export function requirePermission(
  context: Pick<APIContext, 'locals'>,
  request: PermissionRequest,
) {
  const membership = requireOrganizer(context);

  if (!roleHasPermission(membership.role, request)) {
    throw new ForbiddenError();
  }

  return membership;
}

/** Non-throwing check, for deciding what navigation and actions to render. */
export function can(context: Pick<APIContext, 'locals'>, request: PermissionRequest): boolean {
  const { membership } = context.locals;
  if (!membership) return false;
  if (!isOrganizerRole(membership.role)) return false;
  return roleHasPermission(membership.role, request);
}
