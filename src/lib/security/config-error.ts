import type { EnvIssue } from './env';

/**
 * Configuration error page.
 *
 * A deployment whose environment is incomplete cannot serve anything, but a blank
 * 500 tells the operator nothing. This renders the specific problems instead —
 * variable names and reasons, never values — so a fresh deployment is
 * self-explanatory without digging through function logs.
 *
 * Deliberately self-contained: inline styles, no imports from the design system,
 * because it has to render when the application itself cannot start.
 */

const REQUIRED: { name: string; purpose: string }[] = [
  { name: 'DATABASE_URL', purpose: 'PostgreSQL connection string (pooled, on serverless hosts)' },
  { name: 'BETTER_AUTH_SECRET', purpose: 'Session signing key, 32+ characters' },
  { name: 'TICKET_TOKEN_SECRET', purpose: 'Keys ticket QR credentials, 32+ characters' },
  { name: 'PUBLIC_SITE_URL', purpose: 'Canonical https origin of this deployment' },
  { name: 'PAYMENT_PROVIDER', purpose: '`razorpay`, or `simulated` for a labelled demo' },
  { name: 'EMAIL_PROVIDER', purpose: '`smtp` for delivery, `console` in development' },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPage(issues: EnvIssue[]): string {
  const problems = issues
    .map(
      (issue) =>
        `<li><code>${escapeHtml(issue.variable)}</code><span>${escapeHtml(issue.message)}</span></li>`,
    )
    .join('');

  const checklist = REQUIRED.map(
    (item) =>
      `<li><code>${escapeHtml(item.name)}</code><span>${escapeHtml(item.purpose)}</span></li>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Configuration required</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 3rem 1.25rem;
        background: #f6f7f9;
        color: #101828;
        font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      main { max-width: 44rem; margin: 0 auto; }
      .eyebrow {
        font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.16em;
        text-transform: uppercase; color: #b42318;
      }
      h1 { margin: 0.5rem 0 0; font-size: 1.75rem; line-height: 1.2; letter-spacing: -0.01em; }
      p.lede { margin: 0.75rem 0 0; color: #475467; }
      section {
        margin-top: 1.75rem; padding: 1.25rem;
        background: #fff; border: 1px solid #e4e7ec; border-radius: 0.75rem;
      }
      h2 { margin: 0 0 0.75rem; font-size: 0.8125rem; letter-spacing: 0.08em; text-transform: uppercase; color: #667085; }
      ul { list-style: none; margin: 0; padding: 0; }
      li { display: flex; flex-wrap: wrap; gap: 0.5rem; padding: 0.5rem 0; border-top: 1px solid #f2f4f7; }
      li:first-child { border-top: 0; }
      code {
        font: 600 0.8125rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        background: #f2f4f7; border-radius: 0.35rem; padding: 0.05rem 0.35rem;
        color: #344054; white-space: nowrap;
      }
      li span { flex: 1 1 16rem; color: #475467; font-size: 0.875rem; }
      footer { margin-top: 1.5rem; font-size: 0.8125rem; color: #667085; }
      a { color: #4f46e5; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Event Hub · configuration required</p>
      <h1>This deployment is missing configuration</h1>
      <p class="lede">
        The application started but cannot serve requests until the items below are resolved.
        No configuration values are shown on this page.
      </p>

      <section>
        <h2>Problems to fix</h2>
        <ul>${problems}</ul>
      </section>

      <section>
        <h2>Required variables</h2>
        <ul>${checklist}</ul>
      </section>

      <footer>
        On Vercel, set these under <strong>Project → Settings → Environment Variables</strong>,
        then redeploy. Locally, copy <code>.env.example</code> to <code>.env</code>.
        Health status is available at <code>/api/health</code>.
      </footer>
    </main>
  </body>
</html>`;
}

/** 500 with a readable body. Never cached. */
export function configurationErrorResponse(issues: EnvIssue[]): Response {
  return new Response(renderPage(issues), {
    status: 500,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
