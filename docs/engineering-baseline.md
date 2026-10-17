# Engineering baseline assessment

Assessment of the repository at commit `0e5d8d5` — _chore: checkpoint event platform before polish_.

Everything below is measured, not assumed. Commands and figures are reproducible
with the scripts in this repository.

## Baseline verification

| Command            | Result                                    |
| ------------------ | ----------------------------------------- |
| `npm run check`    | 0 errors, 0 warnings, 0 hints (125 files) |
| `npm test`         | 105 passed across 9 files                 |
| `npm run build`    | completed                                 |
| `npm run test:e2e` | 29 passed                                 |

The test suites are backed by a real PostgreSQL database created and migrated by
the suite itself (`tests/setup/global-setup.ts`), so row locking, unique
constraints and the partial index on admissions are exercised rather than mocked.

## Assessment by area

| Area            | Finding                                                                                        | Action                                                              |
| --------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Type safety     | 0 `any`, 0 `as any`, 0 `@ts-ignore`, 0 non-null assertions. `astro check` clean.               | None needed                                                         |
| Automated tests | 105 unit/integration/security + 29 browser tests. No coverage measurement.                     | Recommended: add `@vitest/coverage-v8` before large refactors       |
| Formatting      | **No formatter configured.**                                                                   | Added Prettier + `prettier-plugin-astro`, `format` / `format:check` |
| Linting         | No linter. `astro check` covers types; tests cover behaviour.                                  | Deliberately not added — see note below                             |
| Performance     | Animation engine shipped on every page.                                                        | Fixed: conditional loading (see below)                              |
| Accessibility   | Reduced motion and no-JS guaranteed and tested. Focus states defined. No automated a11y audit. | Recommended: axe scan in Playwright                                 |
| Dependencies    | GSAP and Anime.js both present, on separate jobs. 4 moderate advisories, all dev-only.         | None needed                                                         |
| Deployment      | Env validation, health check and migrations exist. Migration tooling resolved incidentally.    | Fixed: dedicated `migrator` image stage                             |

### On linting

`astro check` already fails the build on type errors, and the suites cover
behaviour. A second linter would primarily duplicate what TypeScript enforces.
The missing repeatable check was **formatting**, so that is what was added rather
than introducing a competing configuration surface.

## Performance measurements

Measured against the production build with `npx tsx scripts/measure-pages.ts`,
using the browser's Resource Timing API (`encodedBodySize`, so compression is
included).

### Before

| Page         | Requests | JS     | CSS   | Fonts | Total  |
| ------------ | -------- | ------ | ----- | ----- | ------ |
| Home         | 5        | 143 kB | 45 kB | 61 kB | 249 kB |
| Events       | 5        | 143 kB | 45 kB | 61 kB | 249 kB |
| Event detail | 5        | 143 kB | 45 kB | 61 kB | 249 kB |
| Register     | 6        | 155 kB | 45 kB | 61 kB | 261 kB |
| Login        | 5        | 143 kB | 45 kB | 61 kB | 249 kB |
| Dashboard    | 5        | 143 kB | 45 kB | 61 kB | 249 kB |
| Scanner      | 5        | 143 kB | 45 kB | 61 kB | 249 kB |

### After

| Page         | Requests | JS        | CSS   | Fonts | Total      |
| ------------ | -------- | --------- | ----- | ----- | ---------- |
| Home         | 7        | 145 kB    | 45 kB | 61 kB | 251 kB     |
| Events       | 7        | 145 kB    | 45 kB | 61 kB | 251 kB     |
| Event detail | 7        | 145 kB    | 45 kB | 61 kB | 251 kB     |
| Register     | 7        | **13 kB** | 45 kB | 61 kB | **119 kB** |
| Login        | 6        | **2 kB**  | 45 kB | 61 kB | **108 kB** |
| Dashboard    | 7        | 145 kB    | 45 kB | 61 kB | 251 kB     |
| Scanner      | 6        | **2 kB**  | 45 kB | 61 kB | **108 kB** |

The animation engine (GSAP + ScrollTrigger + Anime.js) is ~143 kB. It was loaded
on every page because the layout imported it unconditionally. `src/lib/motion/boot.ts`
now checks for something the engine can animate before importing it, so screens
with no hero, reveals or counters ship no animation code.

Animated pages pay 2 kB more than before for the loader — an acceptable trade for
removing 141 kB from login and the scanner. The scanner matters most: it is the
page that must stay responsive while admitting people.

The dashboard still loads the engine (145 kB), because it uses staggered metric
cards and counters. That is a deliberate trade for the roadmap's P2 motion item;
a counters-only micro-module would remove it if the cost ever matters more than
the effect.

The barcode scanner library is a separate ~477 kB chunk and is not requested
until the camera is started. Verified by `tests/e2e/motion.spec.ts`.

## Dependency audit

```
4 moderate severity vulnerabilities
```

All four trace the same path: `drizzle-kit → @esbuild-kit/esm-loader →
@esbuild-kit/core-utils → esbuild ≤0.24.2` (GHSA-67mh-4wv8-2f99, esbuild's dev
server accepting cross-origin requests).

Assessment: `drizzle-kit` is a development tool and is not present in the runtime
image's application surface. The advisory concerns esbuild's development server,
which this project never starts. `npm audit fix --force` would downgrade
`drizzle-kit` to 0.18.1, breaking the current configuration. Left as-is and
recorded here rather than force-fixed.

## Deployment findings

**Fixed:** the compose `migrate` service ran `npx drizzle-kit migrate` against an
image built with `npm ci --omit=dev`. `drizzle-kit` is a devDependency, so this
only worked because npm happened to install it as an optional peer of
`better-auth`. Verified empirically: a `--omit=dev` install does contain it today.
That is incidental, not a guarantee — a change in Better Auth's peer range would
break migrations with no code change here.

The Dockerfile now has a `migrator` stage that installs with `--include=dev`, and
the compose service builds that target. The runtime image still ships production
dependencies only.

**Verified:** `/api/health` reports database reachability and returns 503 when it
cannot reach PostgreSQL; the image declares a matching `HEALTHCHECK`. Environment
validation refuses unsafe production configuration (simulated payments, HTTP
origin, short secrets).

## Internal-system audit

The guarantees below are covered by tests; no changes were needed.

| Guarantee                            | Evidence                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Capacity cannot be oversold          | Database check constraint `sold + reserved <= total`; `tests/integration/inventory.test.ts` fires 10 concurrent buyers at the last ticket |
| Reservations expire and release      | `expireAbandonedOrders`; covered in `tests/integration/orders.test.ts` and the `expire-orders` worker                                     |
| Confirmation is idempotent           | `confirmOrder` returns `alreadyConfirmed`; tickets are issued only for attendees lacking one                                              |
| Duplicate webhooks are inert         | Unique `(provider, provider_event_id)` claim; three deliveries in `tests/integration/payments.test.ts` produce two tickets                |
| Amount mismatch withholds tickets    | Flagged for reconciliation instead of issuing; covered in the payments suite                                                              |
| Refunds cannot exceed the balance    | Payment row locked before the balance is read; concurrency path in `src/features/refunds/service.ts`                                      |
| A ticket admits once                 | Partial unique index `unique (ticket_id) where outcome = 'accepted'`; 8 simultaneous scans in `tests/integration/check-in.test.ts`        |
| A database leak yields no tickets    | Credential derived via HMAC from `TICKET_TOKEN_SECRET`; only the SHA-256 hash is stored                                                   |
| Cross-organization access is refused | 18 tests in `tests/security/access-control.test.ts`                                                                                       |
| Email failure cannot undo a payment  | Outbox rows are written inside the confirming transaction; delivery retries separately                                                    |

## Recommended next steps

Ordered by value, with the risk of each change stated.

1. **Coverage measurement** — `@vitest/coverage-v8`, so refactors can be checked
   against a number rather than a test count. Low risk.
2. **Automated accessibility audit** — `@axe-core/playwright` on the homepage,
   event detail, registration and dashboard. Colour contrast on the dark surface
   is the most likely finding. Low risk.
3. **Dashboard motion budget** — if the 143 kB proves to matter to organizers,
   split counters out of the shared engine. Medium risk: two motion paths.
4. **Dependency advisory** — revisit when `drizzle-kit` moves off
   `@esbuild-kit/*`. No action available today without a breaking downgrade.

## Reproducing this assessment

```bash
npm run check
npm test
npm run test:e2e
npm run build

node ./dist/server/entry.mjs &      # measure the production build, not the dev server
npx tsx scripts/measure-pages.ts
npx tsx scripts/screenshots.ts
```
