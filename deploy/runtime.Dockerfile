# Build from the repository root: docker build -f deploy/runtime.Dockerfile .
# This stable runtime contains no application build or release-specific files.
FROM ghcr.io/nginx/nginx-unprivileged:1.31.9-alpine@sha256:60214a103e6f38e953ff957f34b1f2e97a9db801ab2df3821da955d0fe6cadd6
USER root
RUN mkdir -p /runtime /cache /releases \
    && chown 101:101 /runtime /cache
COPY deploy/nginx.conf.template /etc/entitle/nginx.conf.template
COPY --chmod=0555 deploy/runtime-entrypoint.sh /usr/local/bin/entitle-runtime
COPY --chmod=0555 deploy/api-router-entrypoint.sh /usr/local/bin/entitle-api-router
USER 101:101
ENV ENTITLE_API_UPSTREAM=entitle-api:3211 ENTITLE_PUBLIC_SCHEME=https
# Supply ENTITLE_PUBLIC_HOST as the canonical public hostname, with optional port.
EXPOSE 8080
# Use a read-only root filesystem, a read-only bind of the entire release parent
# at /releases (not current's resolved target), and separate writable tmpfs mounts
# /runtime and /cache with uid=101,gid=101,mode=0700. No published host ports.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/entitle-runtime"]
