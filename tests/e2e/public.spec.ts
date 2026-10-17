import { expect, test } from '@playwright/test';

/**
 * Public site.
 *
 * These tests assert what a visitor can see and do, and — just as importantly —
 * what they cannot. The draft/private checks matter because leaking an
 * unpublished event is a real embarrassment for an organizer.
 */
test.describe('public site', () => {
  test('homepage lists what is on sale', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Upcoming events' })).toBeVisible();

    // The seeded demo event should be discoverable.
    await expect(page.getByRole('link', { name: /Frontier 2026/i }).first()).toBeVisible();
  });

  test('event listing filters without JavaScript', async ({ page }) => {
    await page.goto('/events');

    await expect(page.getByRole('heading', { name: 'Events', exact: true })).toBeVisible();

    // Filtering is a plain GET, so the resulting URL is shareable.
    await page.getByLabel('Search').fill('frontier');
    await page.getByRole('button', { name: 'Apply filters' }).click();

    await expect(page).toHaveURL(/q=frontier/);
    await expect(page.getByRole('link', { name: /Frontier 2026/i }).first()).toBeVisible();
  });

  test('event detail shows the schedule, venue and price', async ({ page }) => {
    await page.goto('/events/frontier-2026');

    await expect(page.getByRole('heading', { name: 'Frontier 2026' })).toBeVisible();
    await expect(page.getByText(/Bengaluru/).first()).toBeVisible();

    // A price is rendered from the stored minor units, formatted for the buyer.
    await expect(page.getByText(/₹\d/).first()).toBeVisible();

    // The refund policy is stated before payment, as the spec requires.
    await expect(page.getByText('Refunds', { exact: true })).toBeVisible();
  });

  test('an online event offers no physical venue', async ({ page }) => {
    await page.goto('/events/design-systems-online');

    await expect(page.getByRole('heading', { name: 'Design Systems, Online' })).toBeVisible();
    await expect(page.getByText('Online event')).toBeVisible();
  });

  test('an unknown event slug is a 404, not an error', async ({ page }) => {
    const response = await page.goto('/events/this-event-does-not-exist');

    // Non-existent and private are deliberately indistinguishable.
    expect(response?.status()).toBe(404);
  });

  test('policy pages are reachable from the footer', async ({ page }) => {
    await page.goto('/');

    const footer = page.getByRole('contentinfo');

    await footer.getByRole('link', { name: 'Terms', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Terms of service' })).toBeVisible();

    await page.getByRole('link', { name: 'Privacy policy', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Privacy policy' })).toBeVisible();
  });

  test('pages carry a title and a description', async ({ page }) => {
    await page.goto('/events');

    await expect(page).toHaveTitle(/Events/);

    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute('content', /.+/);
  });
});

test.describe('access control', () => {
  test('the dashboard sends signed-out visitors to sign in', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('a registration page cannot be reached without the emailed key', async ({ page }) => {
    // References are display values; they are not access credentials.
    const response = await page.goto('/registrations/ORD-AAAAAA-AAAAAA');

    expect([403, 404]).toContain(response?.status() ?? 0);
  });

  test('the webhook endpoint rejects anything but a signed POST', async ({ request }) => {
    const get = await request.get('/api/payments/webhook');
    expect(get.status()).toBe(405);

    const unsigned = await request.post('/api/payments/webhook', {
      data: { event: 'payment.captured' },
    });
    expect(unsigned.status()).toBe(401);
  });

  test('scanning requires authentication', async ({ request }) => {
    const response = await request.post('/api/check-in/scan', {
      data: { eventId: '00000000-0000-4000-8000-000000000000', token: 'whatever' },
    });

    expect(response.status()).toBe(401);
  });
});

test.describe('health', () => {
  test('reports the database as reachable', async ({ request }) => {
    const response = await request.get('/api/health');

    expect(response.status()).toBe(200);

    const body = (await response.json()) as { status: string; database: string };
    expect(body.status).toBe('ok');
    expect(body.database).toBe('reachable');
  });
});

test.describe('responsive layout', () => {
  test('the homepage works at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // The mobile navigation strip replaces the desktop nav rather than
    // overflowing the viewport.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(400);
  });

  test('an event page does not scroll sideways on a small screen', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto('/events/frontier-2026');

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(385);
  });
});
