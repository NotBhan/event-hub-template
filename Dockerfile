# ---------------------------------------------------------------------------
# Production images for the Astro Node server.
#
# Multi-stage: dependencies are installed with the full lockfile, the app is
# built, and the runtime image carries only production dependencies plus the
# build output. Both runnable images run as an unprivileged user.
#
# Stages:
#   deps      — full dependency install, used to build
#   build     — the compiled application
#   migrator  — schema tooling for the one-shot migration job
#   runtime   — the web process (default)
#
# The migrator is separate because drizzle-kit is a development dependency. The
# runtime image installs with `--omit=dev`, so relying on it being present there
# would depend on npm resolving an optional peer of another package — true today,
# but incidental and not something a production migration should rest on.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Dev dependencies are required to build; pruned before the runtime stage.
RUN npm ci --include=dev --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Runtime configuration is injected at run time, never baked into the image.
ENV NODE_ENV=production
RUN npm run build

# ---------------------------------------------------------------------------
# Migration job: needs drizzle-kit, which is a dev dependency by design.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS migrator
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

ENV NODE_ENV=production

CMD ["npx", "drizzle-kit", "migrate"]

# ---------------------------------------------------------------------------
# Web process.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# Only production dependencies ship.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/workers ./workers
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/public ./public

# Never run as root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321

EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4321)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "./dist/server/entry.mjs"]
