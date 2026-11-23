# All-in-one standalone self-host image: the API serves the standalone app at
# the root of PUBLIC_ORIGIN. No marketing bundle and no frontend release step.
# Build from the repository root: docker build -f deploy/standalone.Dockerfile .
# The root Dockerfile remains the server-only image used by the split deployment.
ARG TARGETARCH
FROM scratch AS pnpm-amd64
ADD --checksum=sha256:1de98ed2e9621113b0887b06322b461efb9df73d913fc1d151039b10b7117a41 https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.14.0.tgz /pnpm.tgz
FROM scratch AS pnpm-arm64
ADD --checksum=sha256:e7ca24224eb626a032828ec584c67903ad2f389911b849d009ed70a19f70d8d3 https://registry.npmjs.org/@pnpm/exe.linux-arm64/-/exe.linux-arm64-12.14.0.tgz /pnpm.tgz
FROM pnpm-${TARGETARCH} AS pnpm

FROM node:26.12.0-bookworm-slim@sha256:742a0fe7320e09e0321222b68165e6ac731d30470e7ea7f98f9bfc3a6e1034fe AS toolchain
# Install the pinned native CLI directly; npm is not needed in the build stages.
COPY --from=pnpm /pnpm.tgz /pnpm.tgz
RUN tar -xzf /pnpm.tgz -C /usr/local/bin --strip-components=1 package/pnpm && rm /pnpm.tgz
WORKDIR /app

# The root .dockerignore excludes private inputs (.env, keys, data) but only the
# top-level node_modules. Drop host dependency trees so no host-platform module
# or workspace symlink can land over the container install.
FROM toolchain AS source
COPY . /src
RUN find /src -name node_modules -prune -exec rm -rf {} +

# Server: the same server-only closure and compiler as the root Dockerfile.
FROM toolchain AS server
COPY --from=source /src/package.json /src/pnpm-lock.yaml /src/pnpm-workspace.yaml ./
COPY --from=source /src/apps/server/package.json ./apps/server/package.json
COPY --from=source /src/packages/shared/package.json ./packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @entitle/server...
COPY --from=source /src/tsconfig.json ./
COPY --from=source /src/apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY --from=source /src/src ./src
COPY --from=source /src/packages/shared ./packages/shared
COPY --from=source /src/scripts/build-server.ts ./scripts/build-server.ts
ENV BUILD_DIR=/build
RUN node scripts/build-server.ts
RUN pnpm --filter @entitle/server deploy --legacy --prod /runtime

# Standalone app: only the @entitle/web closure. The build packages the reviewed
# source manifest (scripts/source-files.txt) into legal/, so it needs the tree.
FROM toolchain AS web
COPY --from=source /src/package.json /src/pnpm-lock.yaml /src/pnpm-workspace.yaml ./
COPY --from=source /src/apps/web/package.json ./apps/web/package.json
COPY --from=source /src/packages/shared/package.json ./packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @entitle/web...
COPY --from=source /src/ ./
# Canonical/social metadata origin. Leave empty to keep the built-in default.
ARG WEB_PUBLIC_ORIGIN=
ENV BUILD_DIR=/build
# A blank origin is not a valid URL; only a supplied one is passed through. The
# app mount is always the root, matching APP_BASE_PATH= in the runtime below.
RUN if [ -z "$WEB_PUBLIC_ORIGIN" ]; then unset WEB_PUBLIC_ORIGIN; fi \
    && unset WEB_APP_BASE_PATH \
    && node scripts/build-web.ts \
    && test -f /build/web/index.html -a -f /build/web/seller.html -a -f /build/web/legal/source.tar.gz

FROM node:26.12.0-bookworm-slim@sha256:742a0fe7320e09e0321222b68165e6ac731d30470e7ea7f98f9bfc3a6e1034fe
ENV NODE_ENV=production PORT=3211 WEB_DIR=/app/web DATA_DIR=/data SERVER_ROLE=all \
    DEPLOYMENT_MODE=standalone APP_BASE_PATH=
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=server --chown=node:node /runtime/node_modules ./node_modules
COPY --from=server --chown=node:node /build/server/package.json ./package.json
COPY --from=server --chown=node:node /build/server/src ./src
COPY --from=server --chown=node:node /build/server/packages ./packages
# Static assets stay root-owned and read-only to the application user.
COPY --from=web /build/web ./web
COPY --from=source /src/LICENSE /src/ADDITIONAL-PERMISSION.md /src/NOTICE ./
USER node
EXPOSE 3211
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --start-interval=2s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3211') + '/api/v1/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
