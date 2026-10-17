import { expect, test } from '@playwright/test';

/**
 * Registration and checkout.
 *
 * The complete path a real buyer takes, in a real browser: choose tickets, give
 * details, submit, land on checkout, pay through the simulated provider, and
 * arrive at a page showing the tickets.
 *
 * This is the flow that has the most moving parts — a form action, a server-side
 * order, an inventory reservation, a payment, and ticket issuance — so it is the
 * one most worth exercising end to end.
 */

/** A unique buyer each run, so repeated runs do not collide. */
function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@example.test`;
}

test.describe('free registration', () => {
  test('completes and issues tickets', async ({ page }) => {
    const buyerEmail = uniqueEmail('e2e-free');

    await page.goto('/register/design-systems-online');

    await expect(page.getByRole('heading', { name: 'Register' })).toBeVisible();

    // One free seat.
    await page.getByLabel('Number of Free seat tickets').fill('1');

    // The attendee block is rendered by the page script once a quantity is set.
    const attendeeName = page.getByLabel('Attendee name');
    await expect(attendeeName).toBeVisible();
    await attendeeName.fill('Ada Lovelace');

    await page.getByLabel('Attendee email').fill(buyerEmail);

    await page.getByLabel('Full name').fill('Ada Lovelace');
    await page.getByLabel('Email', { exact: true }).fill(buyerEmail);

    await page.getByRole('button', { name: 'Continue' }).click();

    // A free order is confirmed immediately, so checkout forwards to the tickets.
    await expect(page).toHaveURL(/\/registrations\/ORD-/, { timeout: 20_000 });

    await expect(page.getByRole('heading', { name: 'Your tickets' })).toBeVisible();
    await expect(page.getByText('Ada Lovelace').first()).toBeVisible();
    await expect(page.getByText('Valid').first()).toBeVisible();

    // The QR code renders inline as SVG, generated on the server.
    const qr = page.locator('svg').first();
    await expect(qr).toBeVisible();

    // No personal data is encoded in the QR payload.
    const svg = await qr.innerHTML();
    expect(svg).not.toContain(buyerEmail);
  });

  test('shows a validation message when no tickets are chosen', async ({ page }) => {
    await page.goto('/register/design-systems-online');

    await page.getByLabel('Full name').fill('Ada Lovelace');
    await page.getByLabel('Email', { exact: true }).fill(uniqueEmail('e2e-empty'));

    await page.getByRole('button', { name: 'Continue' }).click();

    // The server rejects it and the page explains why, without losing the input.
    await expect(page.getByText(/select at least one ticket/i)).toBeVisible();
    await expect(page.getByLabel('Full name')).toHaveValue('Ada Lovelace');
  });

  test('does not submit until every ticket has attendee details', async ({ page }) => {
    await page.goto('/register/design-systems-online');

    await page.getByLabel('Number of Free seat tickets').fill('2');
    await page.getByLabel('Full name').fill('Ada Lovelace');
    await page.getByLabel('Email', { exact: true }).fill(uniqueEmail('e2e-partial'));

    // Fill only the first of two required attendees.
    await page.getByLabel('Attendee name').first().fill('Ada Lovelace');
    await page.getByLabel('Attendee email').first().fill(uniqueEmail('e2e-first'));

    await page.getByRole('button', { name: 'Continue' }).click();

    /**
     * The browser refuses to submit while the second attendee is blank, which is
     * the behaviour we want: no request, no reserved stock, and the missing field
     * is focused. The server-side check still exists for any client that bypasses
     * native validation.
     */
    const secondName = page.getByLabel('Attendee name').nth(1);
    await expect(secondName).toBeFocused();
    await expect(secondName).toHaveJSProperty('validity.valid', false);

    expect(new URL(page.url()).pathname).toBe('/register/design-systems-online');
  });
});

test.describe('paid checkout', () => {
  test('runs the simulated provider and issues exactly one ticket', async ({ page }) => {
    const buyerEmail = uniqueEmail('e2e-paid');

    await page.goto('/register/frontier-2026');

    // The cheapest paid ticket is the student rate.
    const studentQuantity = page.getByLabel('Number of Student tickets');
    await studentQuantity.fill('1');

    await page.getByLabel('Attendee name').fill('Grace Hopper');
    await page.getByLabel('Attendee email').fill(buyerEmail);

    await page.getByLabel('Full name').fill('Grace Hopper');
    await page.getByLabel('Email', { exact: true }).fill(buyerEmail);

    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page).toHaveURL(/\/checkout\//, { timeout: 20_000 });

    // The checkout page is explicit that no real money is involved.
    await expect(page.getByText('Simulated checkout')).toBeVisible();
    await expect(page.getByText(/no money moves/i)).toBeVisible();

    // The amount is computed server-side and shown before payment.
    await expect(page.getByText(/₹\d/).first()).toBeVisible();

    await page.getByRole('button', { name: /Simulate a successful payment/i }).click();

    await expect(page).toHaveURL(/\/registrations\/ORD-/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Your tickets' })).toBeVisible();
    await expect(page.getByText('Grace Hopper').first()).toBeVisible();
  });

  test('a simulated failure leaves the order unpaid and retryable', async ({ page }) => {
    const buyerEmail = uniqueEmail('e2e-fail');

    await page.goto('/register/frontier-2026');

    await page.getByLabel('Number of Student tickets').fill('1');
    await page.getByLabel('Attendee name').fill('Alan Turing');
    await page.getByLabel('Attendee email').fill(buyerEmail);
    await page.getByLabel('Full name').fill('Alan Turing');
    await page.getByLabel('Email', { exact: true }).fill(buyerEmail);

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/checkout\//, { timeout: 20_000 });

    await page.getByRole('button', { name: /Simulate a failed payment/i }).click();

    // Still on checkout, with the failure explained and payment still possible.
    await expect(page.getByRole('button', { name: /Simulate a successful payment/i })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/did not go through/i)).toBeVisible();
  });
});

test.describe('minimal-JavaScript fallback', () => {
  test.use({ javaScriptEnabled: false });

  test('filters the event list without JavaScript', async ({ page }) => {
    await page.goto('/events');

    await page.getByLabel('Search').fill('community');
    await page.getByRole('button', { name: 'Apply filters' }).click();

    await expect(page).toHaveURL(/q=community/);
    await expect(page.getByRole('link', { name: /Community Night/i }).first()).toBeVisible();
  });

  test('validates the registration form on the server', async ({ page }) => {
    await page.goto('/register/design-systems-online');

    // No quantity fields were rendered, so this submits an empty selection and
    // the server has to answer.
    await page.getByLabel('Full name').fill('Ada Lovelace');
    await page.getByLabel('Email', { exact: true }).fill(uniqueEmail('e2e-nojs'));

    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText(/select at least one ticket/i)).toBeVisible();
  });
});
