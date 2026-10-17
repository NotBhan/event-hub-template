/**
 * One-off: set an account's password directly.
 *
 * The sign-up and password-reset policy requires at least 10 characters, so a
 * shorter value cannot go through the normal API. This writes the hash with the
 * library's own algorithm (scrypt), which means sign-in verifies it exactly as it
 * would a policy-compliant password.
 *
 * Development only: refuses to run in production.
 *
 * Usage: npx tsx scripts/set-password.ts <email> <new-password>
 */
import '../src/lib/security/load-env';
import { eq } from 'drizzle-orm';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { closeDatabase, db } from '../src/lib/db/client';
import { account, user } from '../src/lib/db/schema';
import { serverEnv } from '../src/lib/security/env';

async function main() {
  const email = (process.argv[2] ?? '').toLowerCase();
  const newPassword = process.argv[3] ?? '';

  if (!email || !newPassword) {
    throw new Error('Usage: npx tsx scripts/set-password.ts <email> <new-password>');
  }

  const env = serverEnv();
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to set a password this way in production.');
  }

  const [existing] = await db().select().from(user).where(eq(user.email, email)).limit(1);
  if (!existing) throw new Error(`No account with email ${email}`);

  const hash = await hashPassword(newPassword);

  // Prove the hash verifies before writing it, so a bad value cannot lock the
  // account out silently.
  if (!(await verifyPassword({ hash, password: newPassword }))) {
    throw new Error('Hash verification failed; refusing to write it');
  }

  const updated = await db()
    .update(account)
    .set({ password: hash, updatedAt: new Date() })
    .where(eq(account.userId, existing.id))
    .returning({ id: account.id });

  if (updated.length === 0) throw new Error('No credential row for that account');

  console.log(`Password for ${email} updated (${updated.length} credential row).`);

  if (newPassword.length < 10) {
    console.log(
      `Note: "${newPassword}" is ${newPassword.length} characters, below the 10-character ` +
        'minimum the sign-up and reset forms enforce. It works for signing in; changing it ' +
        'again will require a longer value.',
    );
  }

  await closeDatabase();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await closeDatabase();
  process.exit(1);
});
