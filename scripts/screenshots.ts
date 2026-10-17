import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Development aid: capture screenshots of the public pages so the layout can be
 * reviewed without a browser window. Not part of the test suite.
 *
 * Scroll-triggered reveals only run when the page is actually scrolled, so the
 * script walks down the page first. Otherwise a full-page capture shows empty
 * space where the content is waiting to be revealed.
 *
 * Usage: npx tsx scripts/screenshots.ts [baseUrl]
 */
const base = process.argv[2] ?? 'http://localhost:4321';
const outDir = 'screenshots';
mkdirSync(outDir, { recursive: true });

const pages = [
  { name: 'home', path: '/', full: true },
  { name: 'events', path: '/events', full: true },
  { name: 'event-detail', path: '/events/frontier-2026', full: true },
  { name: 'register', path: '/register/frontier-2026', full: true },
  { name: 'login', path: '/login', full: false },
  { name: 'dashboard', path: '/dashboard', full: true, auth: true },
  { name: 'dashboard-events', path: '/dashboard/events', full: true, auth: true },
  { name: 'dashboard-event', path: '/dashboard/events/EVENT_ID', full: true, auth: true },
];

const browser = await chromium.launch();

for (const size of [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'mobile', width: 390, height: 844 },
]) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  // Sign in once per context so the organizer screens can be captured.
  await context.request.post(`${base}/api/auth/sign-in/email`, {
    data: { email: 'owner@example.com', password: 'owner-only' },
  });

  for (const target of pages) {
    const eventId = process.env.EVENT_ID ?? '';
    const path = target.path.replace('EVENT_ID', eventId);

    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });

    // Hide the dev toolbar; it is a development overlay, not part of the design.
    // Also disable smooth scrolling: successive scrollTo calls would otherwise
    // keep cancelling one another and never actually reach the sections.
    await page.addStyleTag({
      content: 'astro-dev-toolbar{display:none!important} html{scroll-behavior:auto!important}',
    });

    // Walk the page so every scroll trigger fires.
    await page.evaluate(async () => {
      const step = Math.round(window.innerHeight * 0.6);
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo({ top: y, behavior: 'instant' });
        await new Promise((resolve) => setTimeout(resolve, 140));
      }
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      window.scrollTo({ top: 0, behavior: 'instant' });
    });

    // Let the hero timeline and the last reveals settle.
    await page.waitForTimeout(2400);

    await page.screenshot({
      path: `${outDir}/${target.name}-${size.label}.png`,
      fullPage: target.full,
    });
    console.log(`  ${target.name}-${size.label}.png`);
  }

  await context.close();
}

await browser.close();
console.log('\nDone.');
