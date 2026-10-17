import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { site } from '@/config/site';
import { features } from '@/config/features';
import { db, schema } from '@/lib/db/client';
import { ac, roles } from '@/lib/permissions';
import { serverEnv } from '@/lib/security/env';
import { enqueueEmail } from '@/features/notifications/outbox';

/**
 * Better Auth server instance.
 *
 * Sessions are stored in PostgreSQL and delivered as HTTP-only, same-site cookies.
 * Organization membership carries the application role, and the access control
 * defined in `@/lib/permissions` is what every protected operation checks.
 *
 * Provisioning is done by `scripts/provision-client.ts`; organization creation is
 * disabled unless a deployment explicitly opts in via `features.allowAdditionalOrganizations`.
 */

const env = serverEnv();
const isProduction = env.NODE_ENV === 'production';

export const auth = betterAuth({
  appName: site.name,
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,

  database: drizzleAdapter(db(), {
    provider: 'pg',
    schema,
    usePlural: false,
    transaction: true,
  }),

  emailAndPassword: {
    enabled: true,
    // Short passwords are the most common account-compromise vector.
    minPasswordLength: 10,
    /**
     * Email verification is required in production. Development keeps it off so a
     * fresh clone can sign in immediately; the email transport would otherwise be
     * a console log.
     */
    requireEmailVerification: isProduction,
    autoSignIn: true,
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    // Signed cookie cache avoids a database round trip on every request.
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
      strategy: 'compact',
    },
  },

  advanced: {
    useSecureCookies: isProduction,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      path: '/',
    },
  },

  // Login and signup are the endpoints most worth throttling.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/email': { window: 60, max: 10 },
      '/sign-up/email': { window: 60, max: 5 },
      '/forget-password': { window: 300, max: 5 },
      '/reset-password': { window: 300, max: 10 },
      '/organization/invite-member': { window: 60, max: 20 },
    },
  },

  trustedOrigins: [env.PUBLIC_SITE_URL],

  plugins: [
    organization({
      ac,
      roles,
      creatorRole: 'owner',
      // A client installation provisions exactly one organization.
      allowUserToCreateOrganization: features.allowAdditionalOrganizations,
      organizationLimit: 1,
      invitationExpiresIn: 60 * 60 * 48,
      /**
       * Invitations go through the outbox so delivery is retried and auditable,
       * and so a mail outage cannot fail the invitation request itself.
       */
      sendInvitationEmail: async (data) => {
        try {
          await enqueueEmail(db(), {
            organizationId: data.organization.id,
            recipient: data.email,
            type: 'staff_invitation',
            renderContext: { brandName: data.organization.name },
            data: {
              role: data.role,
              organizationName: data.organization.name,
              invitedBy: data.inviter.user.name,
              invitationPath: `/accept-invitation/${data.id}`,
            },
          });
        } catch (error) {
          // Never surface a mail problem to the caller of inviteMember.
          console.error('Failed to queue staff invitation email', error);
        }
      },
    }),
  ],
});

export type Auth = typeof auth;
export type Session = typeof auth.$Infer.Session;
