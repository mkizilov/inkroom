# Production image for the API: the bundled server and migration runner, with production dependencies.
# Build from the repository root:
#   docker build -f apps/api/Dockerfile -t inkroom-api .
# The image needs pnpm-lock.yaml to be committed; the install below uses --frozen-lockfile.

FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /repo

# Dependencies are installed from the manifests alone, so this layer stays cached until they change.
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @inkroom/api...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @inkroom/api run build \
  && pnpm --filter @inkroom/api deploy --prod /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=21080
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 21080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:21080/api/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.js"]
