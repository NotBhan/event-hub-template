import { afterEach, describe, expect, it } from 'vitest';
import { resetServerEnvCache, tryServerEnv } from '@/lib/security/env';
import { configurationErrorResponse } from '@/lib/security/config-error';

/**
 * Configuration diagnostics.
 *
 * A deployment with one missing variable used to throw during module evaluation,
 * producing a blank 500 with no indication of what was wrong. These tests pin the
 * replacement behaviour: name the problem, never the value.
 */
describe('configuration diagnostics', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    resetServerEnvCache();
  });

  it('reports the missing variable by name instead of throwing', () => {
    delete process.env.DATABASE_URL;
    resetServerEnvCache();

    const result = tryServerEnv();

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const problem = result.issues.find((issue) => issue.variable === 'DATABASE_URL');
    expect(problem).toBeDefined();
    // The message explains the problem without echoing any configured value.
    expect(problem?.message).toMatch(/required|expected/i);
  });

  it('returns the validated environment when everything is present', () => {
    resetServerEnvCache();

    const result = tryServerEnv();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.env.DATABASE_URL).toBe(originalDatabaseUrl);

    // The parsed environment is memoised, so repeated calls do not re-parse.
    const second = tryServerEnv();
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.env).toBe(result.env);
  });

  it('renders a readable page listing the problems', async () => {
    const response = configurationErrorResponse([
      { variable: 'DATABASE_URL', message: 'Required' },
      { variable: 'BETTER_AUTH_SECRET', message: 'Must be at least 32 characters' },
    ]);

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = await response.text();

    expect(body).toContain('DATABASE_URL');
    expect(body).toContain('BETTER_AUTH_SECRET');
    expect(body).toContain('This deployment is missing configuration');
    // Machine-readable hint for an operator following the message.
    expect(body).toContain('/api/health');
  });

  it('escapes configuration values rather than interpolating them', async () => {
    const response = configurationErrorResponse([
      { variable: '<script>alert(1)</script>', message: '"quoted" & <angled>' },
    ]);

    const body = await response.text();

    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
    expect(body).toContain('&quot;quoted&quot;');
  });
});
