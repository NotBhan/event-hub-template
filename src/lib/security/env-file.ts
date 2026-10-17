import { readFileSync } from 'node:fs';

/**
 * Configuration file loading.
 *
 * Node's own `--env-file` and Vite's `.env` handling both stop short of what this
 * application needs:
 *
 *  - Astro exposes `.env` values through `import.meta.env` but does not populate
 *    `process.env`, so server configuration read from `process.env` would be
 *    empty during development.
 *  - A shell that exports `NODE_ENV=production` globally (common in sandboxes and
 *    CI images) would otherwise force every local run through the production
 *    safety checks, demanding HTTPS origins and a live payment provider.
 *
 * So the project's own `.env` is treated as the authority for `NODE_ENV`, and as
 * a fallback for everything else.
 *
 * Precedence:
 *   1. `NODE_ENV` — the file wins, and a warning is logged when it overrides an
 *      ambient value, so the switch is never silent.
 *   2. Every other variable — the real process environment wins, so genuine
 *      deployment secrets always take precedence over a stray file.
 *
 * No `.env` file is present in a production image, so deployment behaviour is
 * unaffected.
 */

let loaded = false;

export function loadEnvFile(path = '.env'): void {
  if (loaded) return;
  loaded = true;

  let contents: string;

  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    // No file: rely entirely on the process environment.
    return;
  }

  const ambientNodeEnv = process.env.NODE_ENV;

  for (const [key, value] of parseEnv(contents)) {
    if (key === 'NODE_ENV') {
      if (ambientNodeEnv !== undefined && ambientNodeEnv !== value) {
        console.warn(
          `[env] NODE_ENV was "${ambientNodeEnv}" in the environment; using "${value}" from ${path}`,
        );
      }
      process.env.NODE_ENV = value;
      continue;
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** Test hook: allows a second load after the environment has been reset. */
export function resetEnvFileLoad(): void {
  loaded = false;
}

/** Minimal dotenv parser: comments, `export` prefix, and single/double quotes. */
function parseEnv(contents: string): Map<string, string> {
  const result = new Map<string, string>();

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).replace(/^export\s+/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(separator + 1).trim();

    const isQuoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);

    if (isQuoted) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing comment from unquoted values only.
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trim();
    }

    result.set(key, value);
  }

  return result;
}
