import { chromium } from '@playwright/test';

/**
 * Performance baseline.
 *
 * Uses the Resource Timing API rather than response headers: chunked responses
 * often omit `content-length`, and `encodedBodySize` is what the browser actually
 * transferred (compression included).
 */
const base = 'http://localhost:4321';
const pages = [
  { name: 'home', path: '/' },
  { name: 'events', path: '/events' },
  { name: 'event detail', path: '/events/frontier-2026' },
  { name: 'register', path: '/register/frontier-2026' },
  { name: 'login', path: '/login' },
  { name: 'dashboard', path: '/dashboard' },
  { name: 'scanner', path: '/dashboard/check-in', auth: true },
];

interface PageWeight {
  js: number;
  css: number;
  font: number;
  img: number;
  total: number;
  count: number;
  biggest: { name: string; size: number }[];
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

await context.request.post(`${base}/api/auth/sign-in/email`, {
  data: { email: 'owner@example.com', password: 'owner-only' },
});

const rows: string[] = [];

for (const target of pages) {
  const page = await context.newPage();
  await page.goto(`${base}${target.path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const data = (await page.evaluate(`(() => {
    const entries = performance.getEntriesByType('resource');
    let js = 0, css = 0, font = 0, img = 0, total = 0, count = 0;
    const biggest = [];

    for (const entry of entries) {
      const size = entry.encodedBodySize || 0;
      total += size; count += 1;
      if (entry.initiatorType === 'script' || /\\.js($|\\?)/.test(entry.name)) js += size;
      else if (/\\.css($|\\?)/.test(entry.name)) css += size;
      else if (/\\.woff2?($|\\?)/.test(entry.name)) font += size;
      else if (/\\.(svg|png|jpg|webp)($|\\?)/.test(entry.name)) img += size;
      biggest.push({ name: entry.name.split('/').pop(), size });
    }

    biggest.sort((a, b) => b.size - a.size);

    return { js, css, font, img, total, count, biggest: biggest.slice(0, 4) };
  })()`)) as PageWeight;

  const kb = (n: number) => `${Math.round(n / 1024)}kB`;
  rows.push(
    `${target.name.padEnd(14)} ${String(data.count).padStart(3)} req  ` +
      `js ${kb(data.js).padStart(7)}  css ${kb(data.css).padStart(6)}  ` +
      `fonts ${kb(data.font).padStart(5)}  total ${kb(data.total).padStart(7)}` +
      `   | ${data.biggest.map((b: { name: string; size: number }) => `${b.name} ${kb(b.size)}`).join(', ')}`,
  );

  await page.close();
}

console.log('\n' + rows.join('\n'));
console.log('');

await browser.close();
