// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

/**
 * Server-rendered configuration.
 *
 * `output: 'server'` is required: registration availability, account permissions,
 * ticket status and payment webhooks are all handled dynamically.
 */
export default defineConfig({
  site: process.env.PUBLIC_SITE_URL ?? 'http://localhost:4321',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
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
