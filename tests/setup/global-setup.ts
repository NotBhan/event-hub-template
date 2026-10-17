import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { loadEnvFile } from '../../src/lib/security/env-file';

/**
 * Test database provisioning.
 *
 * Creates a throwaway database, applies every committed migration to it, and
 * drops it when the run finishes. Running the real migration files — rather than
 * a generated schema — means the suite also verifies that the migrations
 * themselves are correct, including the constraints and partial indexes the
 * correctness guarantees depend on.
 */

const MIGRATIONS_DIR = 'drizzle';

export default async function setup(): Promise<() => Promise<void>> {
  loadEnvFile();

  const adminUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('DATABASE_URL must be set to run the test suite');

  const databaseName = process.env.TEST_DATABASE_NAME ?? 'event_platform_test';

  // Connect to the maintenance database so the test database can be recreated.
  const adminConnection = adminUrl.replace(/\/[^/?]+(\?|$)/, `/postgres$1`);
  const admin = postgres(adminConnection, { max: 1, onnotice: () => {} });

  try {
    const existing = await admin`
      select 1 from pg_database where datname = ${databaseName}
    `;

    if (existing.length === 0) {
      // Identifiers cannot be parameterised, so the name is quoted explicitly.
      await admin.unsafe(`create database "${databaseName}"`);
      console.log(`[test] created database ${databaseName}`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  const testUrl = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`);
  const client = postgres(testUrl, { max: 1, onnotice: () => {} });

  try {
    // Start from a clean schema every run so results never depend on leftovers.
    await client.unsafe('drop schema if exists public cascade');
    await client.unsafe('create schema public');

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

      // Drizzle separates statements with this marker.
      for (const statement of sql.split('--> statement-breakpoint')) {
        const trimmed = statement.trim();
        if (trimmed) await client.unsafe(trimmed);
      }

      console.log(`[test] applied ${file}`);
    }

    // The runtime account needs access to the objects the migration created.
    const appRole = await client`
      select 1 from pg_roles where rolname = 'event_app'
    `;

    if (appRole.length > 0) {
      await client.unsafe('grant usage on schema public to event_app');
      await client.unsafe(
        'grant select, insert, update, delete on all tables in schema public to event_app',
      );
      await client.unsafe('grant usage, select on all sequences in schema public to event_app');
    }
  } finally {
    await client.end({ timeout: 5 });
  }

  return async () => {
    // Nothing to tear down: the database is left in place so a failing run can be
    // inspected. It is wiped at the start of the next one.
  };
}
