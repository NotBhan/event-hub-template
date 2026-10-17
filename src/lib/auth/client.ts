import { createAuthClient } from 'better-auth/client';
import { organizationClient } from 'better-auth/client/plugins';

/**
 * Browser-side auth client.
 *
 * Only ever used for session-aware UI and for calling the auth endpoints. It
 * carries no permissions: the server decides what a user may do.
 */
export const authClient = createAuthClient({
  plugins: [organizationClient()],
});

export const { signIn, signOut, signUp, useSession } = authClient;
