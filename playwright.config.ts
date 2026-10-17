import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * These tests drive the real application in a real browser against a real
 * database. They exist to catch what unit and integration tests structurally
 * cannot: a form that posts the wrong field, a redirect that loops, a page that
 * only works with JavaScript enabled.
 *
 * The web server is started automatically and reuses an already-running one, so
 * `npm run dev` does not have to be stopped first.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4321',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The scanner needs a camera; nothing else does.
    permissions: [],
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:4321/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
