import { loadEnvFile } from './env-file';

/**
 * Environment preload for standalone processes.
 *
 * ES module imports are evaluated before any statement in the importing file
 * runs, so calling `loadEnvFile()` inside a script body would still be too late:
 * the module graph — including anything that validates configuration at import
 * time — has already been evaluated.
 *
 * Importing this module *first* guarantees the file is loaded before anything
 * else looks at `process.env`:
 *
 *   import '../src/lib/security/load-env';
 *   import { db } from '../src/lib/db/client';
 */
loadEnvFile();

export {};
