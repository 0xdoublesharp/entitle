ARG TARGETARCH
FROM scratch AS pnpm-amd64
ADD --checksum=sha256:1de98ed2e9621113b0887b06322b461efb9df73d913fc1d151039b10b7117a41 https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.14.0.tgz /pnpm.tgz
FROM scratch AS pnpm-arm64
ADD --checksum=sha256:e7ca24224eb626a032828ec584c67903ad2f389911b849d009ed70a19f70d8d3 https://registry.npmjs.org/@pnpm/exe.linux-arm64/-/exe.linux-arm64-12.14.0.tgz /pnpm.tgz
FROM pnpm-${TARGETARCH} AS pnpm
FROM node:26.12.0-bookworm-slim@sha256:742a0fe7320e09e0321222b68165e6ac731d30470e7ea7f98f9bfc3a6e1034fe AS build
# Install the pinned native CLI directly; npm is not needed in the build stage.
COPY --from=pnpm /pnpm.tgz /pnpm.tgz
RUN tar -xzf /pnpm.tgz -C /usr/local/bin --strip-components=1 package/pnpm && rm /pnpm.tgz
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @entitle/server...
COPY tsconfig.json ./
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY src ./src
COPY packages/shared ./packages/shared
COPY scripts/build-server.ts ./scripts/build-server.ts
ENV BUILD_DIR=/build
RUN node scripts/build-server.ts
RUN pnpm --filter @entitle/server deploy --legacy --prod /runtime

FROM node:26.12.0-bookworm-slim@sha256:742a0fe7320e09e0321222b68165e6ac731d30470e7ea7f98f9bfc3a6e1034fe
ENV NODE_ENV=production PORT=3211 WEB_DIR=/app/web DATA_DIR=/data SERVER_ROLE=all
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /build/server/package.json ./package.json
COPY --from=build --chown=node:node /build/server/src ./src
COPY --from=build --chown=node:node /build/server/packages ./packages
COPY LICENSE ADDITIONAL-PERMISSION.md NOTICE ./
USER node
EXPOSE 3211
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --start-interval=2s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3211') + '/api/v1/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
