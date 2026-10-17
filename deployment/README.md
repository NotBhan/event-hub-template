# Deployment

Everything the architecture specification requires of a live installation:
HTTPS, environment validation, health checks, migrations, backups, error
reporting and log retention.

## Topology

```
        ┌──────────────┐
        │  Reverse     │  TLS termination, HTTPS redirect
        │  proxy       │  Caddy or Nginx
        └──────┬───────┘
               │ 127.0.0.1:4321
        ┌──────▼───────┐        ┌──────────────┐
        │  web         │───────▶│  PostgreSQL  │
        │  (docker)    │        │  (docker or  │
        └──────────────┘        │   managed)   │
        ┌──────────────┐        └──────────────┘
        │  worker      │───────────────▲
        │  (scheduler) │
        └──────────────┘
```

The `web` service binds to `127.0.0.1` only. The database is never published; it
is reachable only from the compose network.

## First deployment

```bash
git clone <repository> /srv/event-hub && cd /srv/event-hub
cp .env.example .env
```

Fill in `.env`:

```bash
# Generate both secrets — they must be different from each other.
openssl rand -base64 48   # BETTER_AUTH_SECRET
openssl rand -base64 48   # TICKET_TOKEN_SECRET

# Postgres superuser for the container; the app uses its own least-privilege role.
openssl rand -base64 24   # POSTGRES_OWNER_PASSWORD
```

Set `NODE_ENV=production`, `PUBLIC_SITE_URL=https://events.example.com`,
`PAYMENT_PROVIDER=razorpay`, the client's Razorpay credentials, and SMTP details.
Startup validation rejects a production configuration that is still pointing at
the simulated provider or an HTTP origin.

```bash
docker compose up -d --build
docker compose logs -f migrate   # confirm migrations applied
docker compose logs -f web
```

Then provision the organization:

```bash
docker compose exec web npx tsx scripts/provision-client.ts \
  --name "Client Name" --slug client-slug --email owner@client.example
```

Store the generated password immediately; it is printed once.

## Reverse proxy

Caddy, with automatic certificates:

```caddyfile
events.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4321
}
```

Nginx, if you prefer:

```nginx
server {
    listen 443 ssl http2;
    server_name events.example.com;

    ssl_certificate     /etc/letsencrypt/live/events.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/events.example.com/privkey.pem;

    # The application sets its own security headers and CSP.
    location / {
        proxy_pass http://127.0.0.1:4321;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name events.example.com;
    return 301 https://$host$request_uri;
}
```

Forward `X-Forwarded-For`: rate limiting and the audit trail both depend on the
real client address.

## Health and monitoring

`GET /api/health` returns `200` with the database status, or `503` when the
database is unreachable. The container image also declares a `HEALTHCHECK`, so
`docker compose ps` shows health without extra tooling.

Point the proxy's health check, or an uptime monitor, at that path. It is
deliberately unauthenticated and returns no information beyond reachability.

## Backups

Nightly logical backup and a retention window:

```bash
#!/usr/bin/env bash
# /srv/event-hub/deployment/backup.sh
set -euo pipefail

cd /srv/event-hub
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DIR=/srv/backups/event-hub
mkdir -p "$DIR"

docker compose exec -T db pg_dump \
  -U "${POSTGRES_OWNER_USER:-event_owner}" \
  -d "${POSTGRES_DB:-event_platform}" \
  --format=custom --no-owner \
  > "$DIR/event-platform-$STAMP.dump"

gzip -f "$DIR/event-platform-$STAMP.dump"

# Keep 30 days locally.
find "$DIR" -name 'event-platform-*.dump.gz' -mtime +30 -delete

echo "backup written: $DIR/event-platform-$STAMP.dump.gz"
```

```cron
15 2 * * * /srv/event-hub/deployment/backup.sh >> /var/log/event-hub-backup.log 2>&1
```

Copy backups off the machine. A backup that only exists on the host it protects
is not a backup. Include `TICKET_TOKEN_SECRET` and `BETTER_AUTH_SECRET` in
whatever secret store you use — a database restore without them leaves existing
ticket QR codes unverifiable.

### Restoring — test this before you need it

```bash
cd /srv/event-hub

# Stop writers so nothing changes mid-restore.
docker compose stop web worker

# Restore into a scratch database first and sanity-check it.
docker compose exec -T db createdb -U event_owner -T template0 event_platform_restore
gunzip -c /srv/backups/event-hub/event-platform-<STAMP>.dump.gz \
  | docker compose exec -T db pg_restore -U event_owner -d event_platform_restore --no-owner

docker compose exec -T db psql -U event_owner -d event_platform_restore -c \
  "select
     (select count(*) from events)   as events,
     (select count(*) from orders)   as orders,
     (select count(*) from tickets)  as tickets,
     (select count(*) from payments) as payments;"

# Only when those numbers look right:
docker compose exec -T db psql -U event_owner -d postgres -c 'drop database event_platform;'
docker compose exec -T db psql -U event_owner -d postgres -c 'alter database event_platform_restore rename to event_platform;'

docker compose start web worker
docker compose exec web npx tsx -e "fetch('http://127.0.0.1:4321/api/health').then(r=>r.text()).then(console.log)"
```

Record the date of the last successful restore test somewhere you will look
again.

## Migrations

Migrations run as a one-shot `migrate` service before `web` starts, and the
runtime account deliberately has no DDL rights — so a compromised application
cannot alter its own schema.

```bash
docker compose run --rm migrate            # apply pending migrations
npm run db:generate                        # create one (development machine)
```

Always take a backup before a migration that drops or rewrites a column. Review
the generated SQL; `drizzle-kit generate` is deterministic but it does not know
your intent.

## Secret rotation

| Secret | Effect of rotating |
| --- | --- |
| `BETTER_AUTH_SECRET` | Every session is invalidated. Users sign in again. |
| `TICKET_TOKEN_SECRET` | **Every existing ticket QR code stops verifying.** Only rotate if tickets are being reissued. |
| `RAZORPAY_WEBHOOK_SECRET` | Update it in the provider dashboard at the same moment, or webhooks will be rejected until both agree. |
| `RAZORPAY_KEY_SECRET` | Rotate in the dashboard, then update `.env` and restart `web`. |
| Database password | `alter role`, then update `.env` and restart `web` and `worker`. |

After changing `.env`:

```bash
docker compose up -d --force-recreate web worker
docker compose logs --tail=50 web     # confirm it started cleanly
```

## Log retention

The application logs to stdout. Let Docker manage rotation:

```json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "7" }
}
```

in `/etc/docker/daemon.json`, then restart the daemon. That keeps roughly a week
of logs at 20 MB per file.

Application logs contain no passwords, tokens or full payment payloads. Audit
records are in `audit_logs` and are queryable; they are access-controlled by
role.

## Error reporting

`console.error` is used for anything that needs attention, which is enough for a
single-instance deployment read through `docker compose logs`. To route errors to
a service, send stderr on rather than adding a dependency to the application:

```yaml
# docker-compose.yml, under web and worker
logging:
  driver: syslog
  options:
    syslog-address: "udp://logs.internal:514"
```

## Troubleshooting

**The site returns 500 on every request.** Almost always configuration. The
startup error names the offending variable:

```bash
docker compose logs web | head -40
```

**"Invalid environment configuration".** A required value is missing or unsafe.
The message lists every problem at once, so fix them in one pass.

**Webhooks are rejected.** `RAZORPAY_WEBHOOK_SECRET` does not match the provider's
signing secret, or a proxy is rewriting the request body. The body must reach the
application byte-for-byte; do not enable request buffering or body rewriting for
`/api/payments/webhook`.

**Tickets say "Not a valid ticket" at the door.** `TICKET_TOKEN_SECRET` differs
from the one that issued them — usually a new `.env` without the old value.

**A payment succeeded but no tickets were issued.** Look for the order in the
dashboard; a comment is added when an order could not be completed automatically
(an expired reservation, or an amount mismatch). `npm run worker:reconcile-payments`
will pick it up:

```bash
docker compose exec worker npx tsx workers/reconcile-payments.ts
```

**Orders stay "awaiting payment" and stock stays held.** The worker is not
running:

```bash
docker compose logs worker
docker compose exec worker npx tsx workers/expire-orders.ts
```
