# syntax=docker/dockerfile:1.7
# Multi-stage build. Targets:
#   web     – Next.js standalone server (dashboard + API)
#   worker  – BullMQ workers (role chosen with WORKER_QUEUES), includes FFmpeg
#   migrate – one-shot `prisma migrate deploy` (also runs the seed script)

ARG NODE_VERSION=22.22.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build && pnpm worker:build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# ── web ──────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS web
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd --system app && useradd --system --gid app app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://localhost:3000/api/health/live || exit 1
CMD ["node", "server.js"]

# ── worker ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS worker
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production WORKER_HEALTH_PORT=9464
RUN groupadd --system app && useradd --system --gid app app
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist/worker ./dist/worker
COPY --chown=app:app package.json ./
USER app
EXPOSE 9464
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://localhost:9464/healthz || exit 1
CMD ["node", "--enable-source-maps", "dist/worker/main.mjs"]

# ── migrate ──────────────────────────────────────────────────────────────────
FROM build AS migrate
ENV NODE_ENV=production
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]
