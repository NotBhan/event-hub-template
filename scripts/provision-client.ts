/**
 * Client provisioning.
 *
 * Turns a fresh deployment into a usable installation: one organization, its
 * settings, an owner account and a starter event. Running this against a
 * database that is already provisioned is safe — it reports what exists and makes
 * no changes.
 *
 * Usage:
 *   npm run provision
 *   npm run provision -- --name "Acme Events" --slug acme --email owner@acme.test --password '...'
 *
 * Deliberately creates exactly one organization: a client installation is a
 * single-tenant deployment, and `features.allowAdditionalOrganizations` stays off
 * so nobody can create more.
 */
import { randomUUID } from 'node:crypto';
// Must be imported before anything that reads configuration.
import '../src/lib/security/load-env';
import { eq } from 'drizzle-orm';
import { db, closeDatabase } from '../src/lib/db/client';
import { member, organization, organizationSettings, user } from '../src/lib/db/schema';
import { auth } from '../src/lib/auth';
import { serverEnv } from '../src/lib/security/env';
import { site } from '../src/config/site';

interface Options {
  name: string;
  slug: string;
  email: string;
  password: string;
}

function parseArgs(argv: string[]): Options {
  const env = serverEnv();
  const options: Options = {
    name: process.env.PROVISION_ORG_NAME ?? env.PROVISION_ORG_NAME ?? site.name,
    slug: process.env.PROVISION_ORG_SLUG ?? env.PROVISION_ORG_SLUG ?? 'event-hub',
    email: process.env.PROVISION_OWNER_EMAIL ?? env.PROVISION_OWNER_EMAIL ?? 'owner@example.com',
    password: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (!value) continue;

    if (flag === '--name') options.name = value;
    if (flag === '--slug') options.slug = value;
    if (flag === '--email') options.email = value;
    if (flag === '--password') options.password = value;
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  console.log(`\nProvisioning "${options.name}" (${options.slug})\n`);

  // --- Organization ---------------------------------------------------------
  const [existingOrganization] = await db()
    .select()
    .from(organization)
    .where(eq(organization.slug, options.slug))
    .limit(1);

  let organizationId: string;

  if (existingOrganization) {
    organizationId = existingOrganization.id;
    console.log(`• Organization already exists — reusing it (${organizationId})`);
  } else {
    organizationId = randomUUID();

    await db().insert(organization).values({
      id: organizationId,
      name: options.name,
      slug: options.slug,
      metadata: null,
    });

    console.log(`• Organization created (${organizationId})`);
  }

  // --- Settings -------------------------------------------------------------
  const [existingSettings] = await db()
    .select({ id: organizationSettings.id })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);

  if (existingSettings) {
    console.log('• Settings already present — left untouched');
  } else {
    await db().insert(organizationSettings).values({
      organizationId,
      brandName: options.name,
      defaultCurrency: site.defaultCurrency,
      defaultTimezone: site.defaultTimezone,
      supportEmail: options.email,
      contactAddressLines: [],
      featureFlags: {},
    });

    console.log('• Settings created');
  }

  // --- Owner account --------------------------------------------------------
  const [existingUser] = await db().select().from(user).where(eq(user.email, options.email.toLowerCase())).limit(1);

  let ownerUserId: string;

  if (existingUser) {
    ownerUserId = existingUser.id;
    console.log(`• Owner account already exists — reusing it (${options.email})`);
  } else {
    if (!options.password) {
      options.password = generatePassword();
      console.log('• No password supplied — one has been generated below.');
    }

    /**
     * The account is created through Better Auth so the password is hashed with
     * the library's own algorithm. Writing the hash by hand would risk creating an
     * account that cannot sign in.
     */
    const result = await auth.api.signUpEmail({
      body: {
        email: options.email.toLowerCase(),
        password: options.password,
        name: options.name,
      },
    });

    if (!result?.user?.id) {
      throw new Error('Better Auth did not return a user for the owner account');
    }

    ownerUserId = result.user.id;
    console.log(`• Owner account created (${options.email})`);
    console.log(`\n   PASSWORD: ${options.password}\n   Store it now — it is not shown again.\n`);
  }

  // --- Membership -----------------------------------------------------------
  const [existingMembership] = await db()
    .select({ id: member.id, role: member.role })
    .from(member)
    .where(eq(member.userId, ownerUserId))
    .limit(1);

  if (existingMembership) {
    if (existingMembership.role !== 'owner') {
      await db().update(member).set({ role: 'owner' }).where(eq(member.id, existingMembership.id));
      console.log(`• Membership role promoted to owner (was "${existingMembership.role}")`);
    } else {
      console.log('• Owner membership already present');
    }
  } else {
    await db().insert(member).values({
      id: randomUUID(),
      organizationId,
      userId: ownerUserId,
      role: 'owner',
    });

    console.log('• Owner membership created');
  }

  console.log(`
Next steps
  1. Sign in at ${serverEnv().PUBLIC_SITE_URL}/login with ${options.email}
  2. Create an event, or run \`npm run seed\` to load demo data
  3. Configure payment credentials in .env before selling paid tickets
`);

  await closeDatabase();
}

/** Readable, high-entropy password for a newly provisioned owner. */
function generatePassword(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);

  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

main().catch(async (error) => {
  console.error('\nProvisioning failed:', error);
  await closeDatabase();
  process.exit(1);
});
