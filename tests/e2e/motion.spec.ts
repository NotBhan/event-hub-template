import { expect, test } from '@playwright/test';

/**
 * Motion guarantees.
 *
 * The design leans on animation, so the failure modes worth testing are the ones
 * where animation *withholds* content. Two independent safety nets should make
 * that impossible:
 *
 *   • `prefers-reduced-motion: reduce` — the bootstrap never marks the document
 *     as animatable, so nothing is hidden in the first place.
 *   • JavaScript disabled — the inline bootstrap does not run, so again nothing
 *     is hidden.
 *
 * Both are tested from the outside, on the real pages.
 */
test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('does not hide hero content from someone who asked for less motion', async ({ page }) => {
    await page.goto('/');

    // The bootstrap in <head> checks the media query before marking the page.
    const marker = await page.evaluate('document.documentElement.dataset.motion ?? null');
    expect(marker).toBeNull();

    // The headline is visible without waiting for any timeline.
    const headline = page.getByRole('heading', { level: 1 });
    await expect(headline).toBeVisible();
    await expect(headline).toContainText(/events/i);

    // And it is actually painted, not merely present in the DOM.
    const opacity = await headline.evaluate((element) => getComputedStyle(element).opacity);
    expect(Number(opacity)).toBeGreaterThan(0.9);
  });

  test('leaves scroll-revealed sections visible without scrolling', async ({ page }) => {
    await page.goto('/');

    // These are below the fold and would otherwise wait for a scroll trigger.
    await expect(page.getByRole('heading', { name: 'Upcoming events' })).toBeVisible();

    const opacity = await page
      .getByRole('heading', { name: 'Upcoming events' })
      .evaluate((element) => getComputedStyle(element).opacity);

    expect(Number(opacity)).toBeGreaterThan(0.9);
  });

  test('keeps event cards visible on the listing page', async ({ page }) => {
    await page.goto('/events');

    const card = page.getByRole('link', { name: /Frontier 2026/i }).first();
    await expect(card).toBeVisible();

    const opacity = await card.evaluate((element) => getComputedStyle(element).opacity);
    expect(Number(opacity)).toBeGreaterThan(0.9);
  });

  test('shows every event on an event page without animation', async ({ page }) => {
    await page.goto('/events/frontier-2026');

    await expect(page.getByRole('heading', { name: 'Frontier 2026' })).toBeVisible();
    await expect(page.getByText('Refunds', { exact: true })).toBeVisible();

    const tickets = page.getByRole('heading', { name: 'Tickets' });
    await expect(tickets).toBeVisible();

    const opacity = await tickets.evaluate((element) => getComputedStyle(element).opacity);
    expect(Number(opacity)).toBeGreaterThan(0.9);
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('renders the hero and the event list as static content', async ({ page }) => {
    await page.goto('/');

    // Nothing is hidden by a stylesheet rule that only a script can undo.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Upcoming events' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Frontier 2026/i }).first()).toBeVisible();

    const opacity = await page
      .getByRole('heading', { level: 1 })
      .evaluate((element) => getComputedStyle(element).opacity);

    expect(Number(opacity)).toBeGreaterThan(0.9);
  });

  test('keeps the registration form usable', async ({ page }) => {
    await page.goto('/register/design-systems-online');

    await expect(page.getByRole('heading', { name: 'Register' })).toBeVisible();
    await expect(page.getByLabel('Full name')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });
});

test.describe('motion lifecycle', () => {
  test('does not leave elements stranded at zero opacity after load', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    // Give the hero timeline time to finish.
    await page.waitForTimeout(2000);

    const stranded = await page.evaluate(`(() => {
      const hidden = [];
      for (const element of document.querySelectorAll('[data-hero-item], [data-reveal]')) {
        const style = getComputedStyle(element);
        // Above the fold only: below-fold reveals are legitimately still waiting.
        const box = element.getBoundingClientRect();
        const inViewport = box.top < window.innerHeight && box.bottom > 0;
        if (inViewport && Number(style.opacity) === 0) {
          hidden.push(element.textContent.trim().slice(0, 40));
        }
      }
      return hidden;
    })()`);

    expect(stranded).toEqual([]);
  });

  test('survives a client-side navigation without duplicating state', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1200);

    // Scroll-triggered pages must not accumulate triggers across navigations.
    // Navigate twice and confirm content is still revealed, not frozen.
    await page.goto('/events');
    await page.waitForTimeout(1200);
    await page.goto('/');
    await page.waitForTimeout(1600);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Upcoming events' })).toBeVisible();
  });
});

test.describe('animation budget', () => {
  test('loads the animation engine only where there is something to animate', async ({ page }) => {
    const animationRequests: string[] = [];

    page.on('request', (request) => {
      const url = request.url();
      if (/gsap|anime/i.test(url)) animationRequests.push(url);
    });

    // The login screen has no hero, no reveals and no counters.
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    expect(animationRequests).toEqual([]);
  });

  test('loads the engine on a page that does animate', async ({ page }) => {
    const animationRequests: string[] = [];

    page.on('request', (request) => {
      const url = request.url();
      if (/gsap|anime/i.test(url)) animationRequests.push(url);
    });

    await page.goto('/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

    expect(animationRequests.length).toBeGreaterThan(0);
  });

  test('does not load the camera library until the scanner is started', async ({ page }) => {
    const scannerRequests: string[] = [];

    page.on('request', (request) => {
      if (/zxing/i.test(request.url())) scannerRequests.push(request.url());
    });

    await page.goto('/dashboard', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    expect(scannerRequests).toEqual([]);
  });
});
