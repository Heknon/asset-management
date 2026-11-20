# syntax=docker/dockerfile:1.7
# One Dockerfile for every image:
#   docker build --target service --build-arg SERVICE=registry -t asset-management/registry .
#   (SERVICE is identity, registry, files, scheduler or mcp; buildah bud takes the same arguments)
#   docker build --target web -t asset-management/web .
# Runtime images are OpenShift-friendly: they run as an arbitrary non-root UID
# in group 0 and need no writable filesystem besides /tmp. Services run on Node 22:
# their OpenTelemetry tracing hooks Node's module loader, which Bun does not support.

#
# Air-gapped builds (see .gitlab-ci.yml) point every base image at a mirror and
# install packages from a private npm registry:
#   --build-arg BUN_IMAGE=artifactory.example.com/docker-remote/oven/bun:1.4.4-alpine (and the other *_IMAGE args)
#   --build-arg NPM_REGISTRY=https://artifactory.example.com/artifactory/api/npm/npm-remote/
#   --secret id=npmrc,src=.npmrc     (the registry token, never stored in a layer)

ARG BUN_IMAGE=oven/bun:1.4.4-alpine
ARG NODE_IMAGE=node:22.20.0-alpine
ARG SERVICE_BASE_IMAGE=registry.access.redhat.com/ubi9/nodejs-22-minimal:latest
ARG WEB_BASE_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine

FROM ${BUN_IMAGE} AS bun

# Builds run with Bun (install, scripts, bundling); Node is there for tools that expect it.
FROM ${NODE_IMAGE} AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# Empty = the public npm registry.
ARG NPM_REGISTRY=""
ENV BUN_CONFIG_REGISTRY=${NPM_REGISTRY} \
    NPM_CONFIG_REGISTRY=${NPM_REGISTRY}
WORKDIR /src
COPY bun.lock bunfig.toml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/platform/package.json packages/platform/
COPY packages/browser-runtime/package.json packages/browser-runtime/
COPY packages/demo-seed/package.json packages/demo-seed/
COPY packages/serverless/package.json packages/serverless/
COPY services/identity/package.json services/identity/
COPY services/registry/package.json services/registry/
COPY services/files/package.json services/files/
COPY services/scheduler/package.json services/scheduler/
COPY services/mcp/package.json services/mcp/
COPY apps/web/package.json apps/web/
# The optional `npmrc` secret carries registry credentials (//host/:_authToken=…) for this step only.
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache \
    --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    bun install --frozen-lockfile
COPY . .

FROM build AS service-build
ARG SERVICE
RUN test -n "$SERVICE" || (echo "--build-arg SERVICE is required" && exit 1)
# dist/ holds our bundled code; a production node_modules with only this service's
# third-party packages, which OpenTelemetry instruments at runtime when tracing is on.
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache \
    --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    bun run --filter "@am/${SERVICE}" build \
 && mkdir -p /prod /out \
 && cp package.json bun.lock bunfig.toml /prod/ \
 && for f in packages/*/package.json services/*/package.json apps/*/package.json; do mkdir -p "/prod/$(dirname "$f")" && cp "$f" "/prod/$f"; done \
 && cd /prod && bun install --production --frozen-lockfile --filter "@am/${SERVICE}" \
 && mv /prod/node_modules /out/node_modules \
 && cp -r "/src/services/${SERVICE}/dist" /out/dist \
 && cp "/src/services/${SERVICE}/package.json" /out/package.json

FROM build AS web-build
RUN bun run --filter web build

# ─── Backend services ────────────────────────────────────────────────────────
FROM ${SERVICE_BASE_IMAGE} AS service
ARG SERVICE
LABEL org.opencontainers.image.title="asset-management-${SERVICE}" \
      org.opencontainers.image.source="https://github.com/heknon/asset-management"
WORKDIR /app
COPY --from=service-build --chown=1001:0 /out/node_modules ./node_modules
COPY --from=service-build --chown=1001:0 /out/dist ./dist
COPY --from=service-build --chown=1001:0 /out/package.json ./package.json
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    PORT=8080
USER 1001
EXPOSE 8080
# The telemetry preload is a no-op unless OTEL_ENABLED=true.
# `... migrate` runs migrations and exits (used by the init container).
ENTRYPOINT ["node", "--import", "./dist/telemetry.mjs", "dist/main.mjs"]

# ─── Web (static SPA + API reverse proxy) ────────────────────────────────────
FROM ${WEB_BASE_IMAGE} AS web
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=web-build /src/apps/web/dist /usr/share/nginx/html
ENV IDENTITY_UPSTREAM=identity:8080 \
    REGISTRY_UPSTREAM=registry:8080 \
    FILES_UPSTREAM=files:8080 \
    SCHEDULER_UPSTREAM=scheduler:8080 \
    MCP_UPSTREAM=mcp:8080 \
    S3_ORIGIN=https://s3.amazonaws.com \
    NGINX_ENVSUBST_FILTER="UPSTREAM|S3_ORIGIN"
EXPOSE 8080
