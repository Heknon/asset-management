# syntax=docker/dockerfile:1.7
# One Dockerfile for every image:
#   docker build --target service --build-arg SERVICE=registry -t asset-management/registry .
#   docker build --target web -t asset-management/web .
# Runtime images are OpenShift-friendly: they run as an arbitrary non-root UID
# in group 0 and need no writable filesystem besides /tmp.

ARG NODE_VERSION=22.20.0

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/platform/package.json packages/platform/
COPY packages/browser-runtime/package.json packages/browser-runtime/
COPY packages/demo-seed/package.json packages/demo-seed/
COPY services/identity/package.json services/identity/
COPY services/registry/package.json services/registry/
COPY services/files/package.json services/files/
COPY services/scheduler/package.json services/scheduler/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY . .

FROM build AS service-build
ARG SERVICE
RUN test -n "$SERVICE" || (echo "--build-arg SERVICE is required" && exit 1)
# dist/ holds our bundled code; a flat production node_modules holds third-party
# packages, which OpenTelemetry instruments at runtime when tracing is enabled.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm --filter "@am/${SERVICE}" build \
 && pnpm --filter "@am/${SERVICE}" deploy --prod --legacy --config.node-linker=hoisted /out \
 && rm -rf /out/src

FROM build AS web-build
RUN pnpm --filter web build

# ─── Backend services ────────────────────────────────────────────────────────
FROM registry.access.redhat.com/ubi9/nodejs-22-minimal:latest AS service
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
FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=web-build /src/apps/web/dist /usr/share/nginx/html
ENV IDENTITY_UPSTREAM=identity:8080 \
    REGISTRY_UPSTREAM=registry:8080 \
    FILES_UPSTREAM=files:8080 \
    SCHEDULER_UPSTREAM=scheduler:8080 \
    S3_ORIGIN=https://s3.amazonaws.com \
    NGINX_ENVSUBST_FILTER="UPSTREAM|S3_ORIGIN"
EXPOSE 8080
