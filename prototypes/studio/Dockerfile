# Build context is the repository root: Studio's API handlers import
# `packages/db` directly, so the image needs the whole pnpm workspace.
FROM node:24-bookworm-slim

# Model providers and the OIDC issuer are reached over TLS, which needs the CA bundle.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The provider starts the package-local Codex executable from an isolated
# temporary cwd. CODEX_HOME lives in the mounted Studio configuration volume.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    HOME=/root \
    CODEX_HOME=/root/.config/codex
RUN corepack enable && corepack prepare pnpm@12.8.1 --activate

WORKDIR /workspace

# Manifests first so the dependency layer survives every source edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json packages/db/
COPY packages/studio-configuration/package.json packages/studio-configuration/
COPY packages/extraction/package.json packages/extraction/
COPY packages/extraction-result-export/package.json packages/extraction-result-export/
COPY prototypes/studio/package.json prototypes/studio/
COPY prototypes/parsing_service/package.json prototypes/parsing_service/

# The root `postinstall` runs `uv sync` for the Python services, which this
# JavaScript-only image neither contains nor needs, so install skips scripts.
# Naming the dependencies keeps the rebuild out of the workspace root's own
# lifecycle script; the allowed builds are listed in pnpm-workspace.yaml's `allowBuilds`,
# and an entry absent from the tree is ignored.
RUN --mount=type=cache,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store --global \
    && pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm -r rebuild @anthropic-ai/claude-code @prisma/engines esbuild prisma \
    && install -d -m 700 "$CODEX_HOME" \
    && pnpm --filter studio exec codex --version \
    && pnpm --filter studio exec claude --version

COPY . .

# The other half of that skipped `postinstall`. `packages/db/src/generated/prisma`
# is emitted, never committed; emitting the contract reads the schema only, so
# the connection string below is never dialled.
RUN DATABASE_URL=postgresql://contract:emit@127.0.0.1:5432/free pnpm db:generate

# Produce both the browser bundle and the Node server before the runtime image
# is started. The image deliberately retains the workspace tooling needed to
# replay authored database migrations at startup.
RUN pnpm --filter studio build

ENV NODE_ENV=production

COPY docker/studio-entrypoint.sh /usr/local/bin/studio-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/studio-entrypoint \
    && chmod +x /usr/local/bin/studio-entrypoint

EXPOSE 5173
ENTRYPOINT ["/usr/local/bin/studio-entrypoint"]
# Run the built Hono host; Vite is never part of the hosted request path.
CMD ["pnpm", "--filter", "studio", "start"]
