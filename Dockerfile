# Nomus Engine — multi-stage Dockerfile
# Build context: repository root.
#
#   docker build -t nomus-engine .
#
# The engine imports @nomus/shared, @nomus/chain and nomus-scan at runtime,
# so all three workspace packages are built and shipped alongside it.
# Published as ghcr.io/babbguy/nomus-engine (see .github/workflows/publish.yml).
# Base images are pinned by digest; Dependabot updates the digests.

# ─── Stage 1: Install all dependencies (including dev, for the build) ─────
# Stages 1-2 produce platform-independent JavaScript, so they run on the build
# host's platform even when building for another one; only the production
# dependencies (native modules) are installed for the target platform.
FROM --platform=$BUILDPLATFORM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS deps

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/chain/package.json packages/chain/
COPY packages/scanner/package.json packages/scanner/
COPY engine/package.json engine/

RUN npm ci \
    --workspace=engine \
    --workspace=packages/shared \
    --workspace=packages/chain \
    --workspace=packages/scanner \
    --include-workspace-root

# ─── Stage 2: Build TypeScript ────────────────────────────────────────────
FROM deps AS build

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/chain/ packages/chain/
COPY packages/scanner/ packages/scanner/
COPY engine/ engine/

RUN npm run build -w packages/shared && \
    npm run build -w packages/chain && \
    npm run build -w packages/scanner && \
    npm run build -w engine

# ─── Stage 3: Production-only dependencies ────────────────────────────────
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS prod-deps

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/chain/package.json packages/chain/
COPY packages/scanner/package.json packages/scanner/
COPY engine/package.json engine/

RUN npm ci --omit=dev \
    --workspace=engine \
    --workspace=packages/shared \
    --workspace=packages/chain \
    --workspace=packages/scanner \
    --include-workspace-root

# ─── Stage 4: Runtime ─────────────────────────────────────────────────────
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS runtime

# The engine needs only the node binary at runtime: drop the package managers
# (and their dependency trees) and create the data directory for SQLite
# (mount a volume here to persist it). Everything else stays root-owned and
# read-only to the runtime user.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* && \
    mkdir -p /app/data && chown node:node /app/data

WORKDIR /app

# Production node_modules (workspace packages are symlinked into it) plus the
# compiled output of every workspace package the engine uses.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/chain/dist ./packages/chain/dist
COPY --from=build /app/packages/chain/package.json ./packages/chain/
COPY --from=build /app/packages/scanner/dist ./packages/scanner/dist
COPY --from=build /app/packages/scanner/package.json ./packages/scanner/
COPY --from=build /app/engine/dist ./engine/dist
COPY --from=build /app/engine/package.json ./engine/

USER node

ENV NODE_ENV=production \
    NOMUS_PORT=3100 \
    NOMUS_DB_PATH=/app/data/nomus.db \
    NOMUS_LOG_FORMAT=json

EXPOSE 3100

# /ready: the database is reachable and the signing keys are initialized.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.NOMUS_PORT||3100)+'/ready',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Nomus Engine" \
      org.opencontainers.image.description="Nomus regulatory applicability engine (API, pipeline and scheduler)" \
      org.opencontainers.image.source="https://github.com/babbguy/Nomus" \
      org.opencontainers.image.url="https://github.com/babbguy/Nomus" \
      org.opencontainers.image.documentation="https://github.com/babbguy/Nomus/blob/main/docs/admin-guide/deployment.md" \
      org.opencontainers.image.licenses="FSL-1.1-ALv2" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

CMD ["node", "engine/dist/index.js"]
