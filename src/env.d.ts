/// <reference types="astro/client" />

/**
 * Request-scoped context populated by `src/middleware.ts`.
 *
 * Anything that is not set here is not trusted: pages and endpoints must read
 * identity from `Astro.locals`, never from the request body or query string.
 */
declare namespace App {
  interface Locals {
    user: import('better-auth').User | null;
    session: import('better-auth').Session | null;

    /**
     * Organization membership for the authenticated user, when they belong to
     * the organizer team. Null for guests, plain attendees and signed-out users.
     */
    membership: {
      organizationId: string;
      role: import('./lib/permissions').OrganizationRole;
      memberId: string;
    } | null;
  }
}
