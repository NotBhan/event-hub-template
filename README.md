# Event Hub

A reusable event management platform: a public event site, an organizer dashboard,
a ticketing engine with real payment handling, and QR admission — built as one
Astro application with PostgreSQL.

Each client gets their own deployment: their own database, domain, branding and
payment credentials. This repository stays the shared source of truth.

---

## What this is

A modular monolith. The public site, the organizer dashboard, checkout, the
payment webhook, refunds and the door scanner all live in one application and one
database, organised by business capability rather than by layer.

```
src/features/
  events/         events, sessions, venues, online access
  inventory/      ticket types, capacity, reservations
  orders/         orders, line items, attendees
  payments/       provider adapters, webhooks, reconciliation
  refunds/        refund requests, balances, ticket voiding
  tickets/        issuance, QR credentials
  check-in/       scans, admission, audit of attempts
  notifications/  transactional email through an outbox
  audit/          the trail an investigation would need
```

Pages and endpoints call services — `createOrder()`, `requestRefund()`,
`scanTicket()` — and services own the business rules. Nothing outside
`src/features/` writes to a business table directly.

## Why the design looks like this

**Money is an integer.** Every amount is stored in the currency's smallest unit
(paise for INR) alongside its currency code. `₹499.00` is `49900`. Prices are
snapshotted onto the order, so editing a ticket type never changes an order that
already exists.

**Inventory cannot oversell.** Reservation locks the ticket-type row and
increments a `reserved` counter; the database itself carries a check constraint
asserting `sold + reserved <= total`. Ten simultaneous buyers for the last ticket
produce one order and nine refusals — there is a test that does exactly that.

**Payment confirmation is idempotent.** Webhooks are delivered at least once, can
arrive twice, and can arrive out of order. Each delivery is claimed against a
unique `(provider, provider_event_id)` index before anything is applied, and
tickets are issued by a function that skips attendees who already have one.

**A browser success message proves nothing.** The client-return path verifies the
provider's signature, re-fetches the payment from the provider, and compares the
captured amount against the order before confirmation. A mismatch issues no
tickets and is flagged for a human instead.

**A ticket admits one person once.** Admission is a row in `check_in_attempts`,
and a partial unique index — `unique (ticket_id) where outcome = 'accepted'` —
decides which of two simultaneous scans wins. Every attempt is recorded,
including rejections.

**A database leak does not yield tickets.** The QR credential is derived from a
server-side secret and the ticket id, and only its hash is stored. The secret
lives in deployment configuration, never in the database.

**An id is not access control.** Every dashboard read and write resolves the
record and checks it belongs to the caller's organization.

## Design and motion

Two surfaces, one token system.

**Public site — dark and editorial.** Oversized condensed display type on
near-black, indigo and electric blue with a lime accent used sparingly. Event
artwork is generated per event (see below) so a listing reads as varied without
stock photography.

**Organizer surface — light and dense.** Tables, refunds, inventory and the
scanner inherit the same tokens resolved to a neutral palette. Motion there is
limited to a short entrance on metric cards; nothing delays reading a table or
using the scanner.

### Tokens

Colours, radii and timing are CSS custom properties defined once in
`src/styles/global.css` and mapped into Tailwind's `@theme`. The light surface is
a per-subtree override:

```html
<div data-theme="light"> … </div>
```

Utilities reference `var(--color-*)`, so a component never needs to know which
theme it is in. A client's brand colour is written onto `:root` at runtime from
`organization_settings`, which reaches both themes without a rebuild.

Type is fluid:

| Class | Use | Size |
| --- | --- | --- |
| `.display-hero` | Homepage headline | `clamp(3.25rem, 11vw, 9.5rem)` |
| `.display-xl` / `.display-lg` / `.display-md` | Page and section titles | 1.5–4.5rem |
| `.eyebrow` | Small uppercase label with an accent dot | 0.6875rem |
| `.measure` | Constrained line length for prose | 62ch |

The display face is **Bebas Neue**; body is **Inter**. Both are self-hosted from
`public/fonts` (Latin subset, ~61 kB total) with `font-display: swap` and a
preload for the two files that paint the first screen — no third-party CDN
request, which matters for privacy as much as performance. Regenerate with
`npx tsx scripts/fetch-fonts.ts` if the families change.

### Event artwork

`EventArtwork.astro` renders `coverImageUrl` when an organizer has supplied an
image. Otherwise it composes a deterministic SVG from the event's slug: one of
five palettes, one of three compositions, seeded so an event always looks the
same and no two events in a listing collide. There is nothing to license and
nothing to upload for a fresh installation.

### Motion system

One client module, `src/lib/motion/engine.ts`, owns every animation. Pages opt in
with data attributes rather than importing an animation library:

| Attribute | Effect |
| --- | --- |
| `data-hero` + `data-hero-item` | Hero timeline; `="mask"` clips a line for a masked reveal |
| `data-reveal="up\|fade\|left\|right\|scale"` | Scroll reveal, once |
| `data-reveal-delay="0.2"` | Extra delay in seconds |
| `data-stagger="0.08"` | Children of this element reveal in sequence |
| `data-parallax="0.06"` | Subtle scroll-linked drift (full intensity only) |
| `data-counter="2046"` | Anime.js count-up; the final value is the fallback |

**GSAP** drives the hero timeline, masked line reveals, staggered cards, scroll
reveals and parallax. **Anime.js** drives numeric counters — a job it is better
suited to than GSAP, and one that keeps the two engines on separate elements
rather than competing over the same DOM. React and Motion are deliberately not
used: there are no React islands, and adding React only to animate would be a
cost with no benefit.

Timing lives in `src/lib/motion/tokens.ts` (`motion.duration`, `motion.stagger`,
`motion.ease`, `motion.intensity`), mirrored as CSS custom properties. Set
`intensity` to `'subtle'` to drop parallax, or `'off'` to disable animation for a
deployment.

**Lifecycle.** One `gsap.context()` per page, reverted on `astro:before-swap` and
before each `astro:page-load`, so triggers and timelines cannot accumulate across
client-side navigation.

**Reduced motion.** An inline bootstrap in `<head>` checks
`prefers-reduced-motion` before marking the document animatable. When motion is
reduced — or JavaScript is unavailable — the stylesheet's hidden initial states
never apply and everything renders in its final state. Scroll reveals use
`opacity`, not `visibility`, so content stays in the accessibility tree even
before it animates. Both guarantees have tests: `tests/e2e/motion.spec.ts`.

### Reviewing the design locally

```bash
npx tsx scripts/screenshots.ts          # captures desktop + mobile to ./screenshots
```

The script signs in, walks each page so scroll triggers fire, and hides Astro's
dev toolbar. Pass an `EVENT_ID` environment variable to capture the organizer
event page.

## Getting started

Requires Node 20+ and PostgreSQL 14+. Docker is convenient but not required.

```bash
npm install

# Start a development database (creates the least-privilege roles too)
docker run -d --name event-hub-db \
  -e POSTGRES_USER=event_owner -e POSTGRES_PASSWORD=event_owner_password \
  -e POSTGRES_DB=event_platform -p 5432:5432 \
  -v event-hub-pgdata:/var/lib/postgresql/data \
  -v "$PWD/deployment/postgres/init:/docker-entrypoint-initdb.d:ro" \
  postgres:16-alpine

cp .env.example .env      # then set BETTER_AUTH_SECRET and TICKET_TOKEN_SECRET
npx drizzle-kit migrate   # apply the schema
npm run provision         # create the organization, owner account and settings
npm run seed              # optional: realistic demo events and registrations

npm run dev               # http://localhost:4321
```

`npm run provision` prints the owner's generated password once. Sign in at
`/login` and the dashboard is at `/dashboard`.

Generate the two secrets with:

```bash
openssl rand -base64 48   # BETTER_AUTH_SECRET
openssl rand -base64 48   # TICKET_TOKEN_SECRET — must be different
```

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and run |
| `npm run check` | Type check everything |
| `npm test` | Unit, integration and security tests |
| `npm run db:generate` / `db:migrate` | Create and apply a migration |
| `npm run provision` | Create the organization, owner and settings on a fresh install |
| `npm run seed` | Load demo events (`-- --reset` to replace them) |
| `npx tsx scripts/set-password.ts <email> <password>` | Reset a password locally (development only) |
| `npx tsx scripts/screenshots.ts` | Capture page screenshots for visual review |
| `npx tsx scripts/fetch-fonts.ts` | Re-download the self-hosted webfonts |
| `npm run worker:*` | Run one maintenance task once, or `-- --loop 60` |

## Configuration

Two kinds of configuration, deliberately kept apart.

**Client identity** — `src/config/site.ts` and `src/config/features.ts`. Name,
colours, contact details, default currency and timezone, and which features are
switched on. Runtime branding lives in the database and overrides these, so a
client can change their name without a rebuild.

**Deployment secrets** — `.env`. Database URL, auth secret, payment credentials,
email transport. These are never committed and never editable from the browser.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Runtime connection. Least privilege: no DDL rights. |
| `DATABASE_MIGRATION_URL` | Schema-owning account, used only by migrations. |
| `BETTER_AUTH_SECRET` | Session signing. 32+ characters. |
| `TICKET_TOKEN_SECRET` | Keys ticket QR credentials. 32+ characters, must differ from the auth secret. |
| `PUBLIC_SITE_URL` | Canonical origin. Must be HTTPS in production. |
| `PAYMENT_PROVIDER` | `razorpay`, or `simulated` for a local demo. |
| `RAZORPAY_KEY_ID` / `_SECRET` / `_WEBHOOK_SECRET` | Gateway credentials. |
| `EMAIL_PROVIDER` | `smtp`, or `console` in development. |
| `ORDER_RESERVATION_MINUTES` | How long an unpaid order holds stock (default 30). |

`src/lib/security/env.ts` validates all of this on startup and refuses to run
with a production configuration that is obviously unsafe — a simulated payment
provider, an HTTP origin, or a secret that is too short.

### The simulated payment provider

`PAYMENT_PROVIDER=simulated` enables a clearly labelled demo checkout. It takes
no shortcut: it mints the identifiers and signature a real gateway would produce,
runs them through the ordinary verification path, and then delivers a signed
webhook — so the demo exercises the same code that handles real money, including
the duplicate-webhook case.

It is refused in production, and the UI says plainly that no payment was taken.

## Payments

`PaymentProvider` is the only place a gateway's shape is visible:

```ts
interface PaymentProvider {
  createOrder(input): Promise<ProviderOrder>
  verifyPayment(input): Promise<VerifiedPayment>
  verifyWebhook(input): Promise<VerifiedWebhook>
  refund(input): Promise<ProviderRefund>
  getPayment(id): Promise<ProviderPayment>
  getRefund(id): Promise<ProviderRefund>
}
```

Razorpay is the shipped adapter. `verifyWebhook` hashes the **raw request body** —
the bytes exactly as received — because that is what the signature covers, and
re-serialising the JSON would break it. Only a redacted summary of each payload is
stored.

Adding a second gateway means writing one file and adjusting configuration. The
order model does not change.

### Registering the webhook

Point the provider at `https://your-domain/api/payments/webhook` for
`payment.captured`, `payment.failed`, `refund.processed` and `refund.failed`.
Set `RAZORPAY_WEBHOOK_SECRET` to the signing secret. A 2xx tells the provider to
stop retrying; a 5xx asks it to retry, which is the right answer for a transient
failure on our side.

## Roles

Roles are enforced on the server for every request. The browser never decides its
own role.

| Role | Can |
| --- | --- |
| `owner` | Everything, including staff and settlement records |
| `admin` | Events, staff and registrations. Not ownership or payouts |
| `event_manager` | Assigned events, ticket types, attendee lists, reports |
| `finance` | Financial records, permitted refunds, exports |
| `checkin_staff` | Scan tickets and see minimal admission information |
| `attendee` | Their own registrations and tickets |

Only an owner may grant ownership, and an owner cannot be removed until their
role is changed — so an organization can never be left with nobody able to manage
it.

## Background work

Three tasks, run by `workers/scheduler.ts` in the deployment:

- **expire-orders** — releases inventory held by abandoned checkouts, and closes
  out finished events.
- **process-outbox** — sends queued email, with backoff and a retry ceiling.
  Messages are queued inside the transaction that confirmed the order, so a
  confirmed order always has its notification recorded, and a mail outage can
  never roll back a payment.
- **reconcile-payments** — asks the provider about payments whose outcome is
  unknown: timeouts, delayed confirmations, and captures whose amount does not
  match the order. Recovered payments go through the same idempotent path a
  webhook uses.

Each is also runnable on its own, so any scheduler will do.

## Testing

```bash
npm test
```

105 tests against a real PostgreSQL database — created, migrated and wiped by the
suite, so it never touches working data. Mocks are not used for the parts that
matter: row locking, unique constraints and the partial index only exist in the
database, so a mocked test would prove nothing.

The ones worth reading first:

| Test | What it pins down |
| --- | --- |
| `integration/inventory` | Ten buyers, one ticket: exactly one order succeeds |
| `integration/payments` | Three webhook deliveries produce two tickets, not six |
| `integration/check-in` | Eight simultaneous scans admit a ticket once |
| `integration/orders` | Confirming twice issues one set of tickets |
| `security/access-control` | An event or order from another organization is unreachable |
| `unit/timezone` | An event time survives a daylight-saving boundary |

## Deployment

Two targets from the same commit. The adapter is chosen at build time from the
environment, so nothing needs to be maintained in parallel.

### Vercel

Vercel sets `VERCEL=1` during its build, which switches Astro to the Vercel
adapter and emits a serverless function. Without that branch a Vercel deployment
receives a standalone Node server it cannot route, and **every page returns 404** —
which is the most common way this project fails on Vercel.

1. Import the repository as a Vercel project. Framework preset: **Astro**.
2. Provision a hosted PostgreSQL database. Use a **pooled** connection string:
   serverless functions open many short-lived connections, and a direct
   (unpooled) URL will exhaust the server's connection limit.
3. Set these environment variables for Production (and Preview if you want
   previews to work):

   | Variable | Required | Notes |
   | --- | --- | --- |
   | `DATABASE_URL` | yes | Pooled PostgreSQL URL reachable from Vercel |
   | `BETTER_AUTH_SECRET` | yes | 32+ characters |
   | `TICKET_TOKEN_SECRET` | yes | 32+ characters, different from the auth secret |
   | `PUBLIC_SITE_URL` | recommended | `https://your-domain`; derived from Vercel's own domain variables when omitted |
   | `BETTER_AUTH_URL` | recommended | Same as `PUBLIC_SITE_URL` |
   | `PAYMENT_PROVIDER` | yes | `razorpay`, or `simulated` for a demo |
   | `RAZORPAY_KEY_ID` / `_SECRET` / `_WEBHOOK_SECRET` | if Razorpay | Client's own merchant account |
   | `EMAIL_PROVIDER` | yes | `smtp` for real delivery |
   | `ALLOW_SIMULATED_PAYMENTS` | demo only | `true` is required for `simulated` under `NODE_ENV=production` |

4. Apply the schema once, from a machine that can reach the database:

   ```bash
   DATABASE_MIGRATION_URL='<unpooled-url>' npx drizzle-kit migrate
   npx tsx scripts/provision-client.ts --name "Client" --slug client --email owner@client.example
   ```

5. Point the payment provider's webhook at
   `https://your-domain/api/payments/webhook`. Vercel serves it from the same
   serverless function as the rest of the site; no separate route configuration
   is needed.

Notes specific to Vercel:

- **If every page returns 500**, the configuration is incomplete. The response
  names the offending variables (never their values) and lists what is required;
  `/api/health` returns the same information as JSON. Both are safe to open on a
  broken deployment.
- `NODE_ENV` is `production`, so the simulated provider is rejected unless
  `ALLOW_SIMULATED_PAYMENTS=true`. That is deliberate: a demo must say so.
- Vercel preview deployments get their own hostname. The auth layer trusts
  `VERCEL_URL` and `VERCEL_BRANCH_URL` automatically, so sign-in works on previews
  without extra configuration.
- The background workers do **not** run on Vercel. Reservation expiry, email
  delivery and payment reconciliation need a scheduler, such as a Vercel Cron
  Job hitting a protected endpoint, a small always-on process, or the Docker
  worker described below. Without one, abandoned checkouts keep holding stock and
  queued email is never sent.

### Neon

The project ships a [`neon.ts`](./neon.ts) that declares which Neon services a
branch should have — Postgres, and an `assets` bucket for uploaded event artwork.

```bash
npx neon@latest init -y --org-id <org-id> --project-id <project-id> --branch production
npx neon@latest deploy          # provisions the declared buckets, then pulls env vars
```

`neon init` writes four things into `.env` (or your platform's environment
variables):

| Variable | Used for |
| --- | --- |
| `DATABASE_URL` | The **pooled** endpoint. The app's runtime connection. |
| `DATABASE_URL_UNPOOLED` | The direct endpoint. Drizzle Kit applies migrations through it, because PgBouncer will not carry schema changes. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Object storage credentials. |
| `AWS_ENDPOINT_URL_S3` / `AWS_REGION` | Bucket endpoint and region. |

Then apply the schema and provision:

```bash
npm run db:migrate              # uses DATABASE_URL_UNPOOLED
npm run provision               # organization + owner account
npm run seed                    # optional demo data
```

Object storage is optional. Without it the cover image URL field still works and
the upload control reports that storage is not configured; everything else runs
unchanged. Uploaded covers are stored as objects and the database keeps the key,
so a read URL is signed per request rather than stored — a stored signature would
expire and leave broken images behind.

### Docker

`Dockerfile` builds the Astro Node server as an unprivileged user; `docker-compose.yml`
runs the database, a migration job, the web process and the worker.

```bash
cp .env.example .env      # fill in real values
docker compose up -d --build
```

Put a TLS-terminating reverse proxy (Caddy or Nginx) in front of the `web`
service. HTTPS is not optional — session cookies use `Secure`, and payment
webhooks are signed.

The application serves `/api/health`, which checks the database and returns 503
when it is unreachable, so a load balancer can act on it. The image also carries a
`HEALTHCHECK`.

See [`deployment/README.md`](deployment/README.md) for backups, restore
procedures, secret rotation and the go-live checklist.

## Before going live

The platform is the technology; the organizer still owns the commercial
relationship. Confirm each of these for every client deployment:

- Payment credentials are the client's own, and `PAYMENT_PROVIDER` is not
  `simulated`.
- `TICKET_TOKEN_SECRET` and `BETTER_AUTH_SECRET` are freshly generated and
  different from each other.
- The policy pages under `/policies` have been replaced with the organizer's own
  terms, privacy notice and refund rules.
- `npm run seed` demo data is **not** present, or has been removed.
- Backups run automatically, and a restore has actually been tested.
- Somebody is responsible for orders with ambiguous payment outcomes.

The dashboard settings page shows the deployment's payment provider and email
transport, so a misconfigured installation is visible rather than assumed.
