// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';

/**
 * Server-rendered configuration.
 *
 * `output: 'server'` is required: registration availability, account permissions,
 * ticket status and payment webhooks are all handled dynamically.
 *
 * The adapter is chosen by environment. Vercel sets `VERCEL=1` during its build,
 * so a deployment from the same commit produces a serverless function there and a
 * standalone Node server everywhere else. Without this branch, Vercel receives a
 * Node build it cannot route and every page 404s.
 */
const isVercel = Boolean(process.env.VERCEL);

/**
 * Canonical origin.
 *
 * On Vercel, fall back to the project's own domain so canonical URLs and
 * auth callbacks are correct even if `PUBLIC_SITE_URL` was not configured.
 * `VERCEL_PROJECT_PRODUCTION_URL` is the stable production domain;
 * `VERCEL_URL` is the per-deployment preview host.
 */
const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL ?? undefined;

const siteUrl =
  process.env.PUBLIC_SITE_URL ?? (vercelHost ? `https://${vercelHost}` : 'http://localhost:4321');

export default defineConfig({
  site: siteUrl,
  output: 'server',
  adapter: isVercel ? vercel() : node({ mode: 'standalone' }),
  server: {
    host: true,
    port: Number(process.env.PORT ?? 4321),
  },
  security: {
    checkOrigin: true,
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
