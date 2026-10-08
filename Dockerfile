# Nomus Engine — multi-stage Dockerfile
# Build context: repository root.
#
#   docker build -t nomus-engine .
#
# The engine imports @nomus/shared, @nomus/chain and @nomus/scanner at runtime,
# so all three workspace packages are built and shipped alongside it.

# ─── Stage 1: Install all dependencies (including dev, for the build) ─────
FROM node:20-slim AS deps

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
FROM node:20-slim AS prod-deps

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
FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

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

# Data directory for SQLite (mount a volume here to persist it)
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

ENV NODE_ENV=production
ENV NOMUS_PORT=3100
ENV NOMUS_DB_PATH=/app/data/nomus.db
ENV NOMUS_LOG_FORMAT=json

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3100/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "engine/dist/index.js"]
