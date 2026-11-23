#!/bin/sh
set -eu

if [ "${ENTITLE_RUNTIME_MODE:-frontend}" = api-router ]; then
    exec /usr/local/bin/entitle-api-router
fi

# Only validated operator configuration is expanded. Request forwarding headers
# are never trusted for the public origin. ENTITLE_PUBLIC_HOST is required;
# and keep ENTITLE_PUBLIC_SCHEME consistent with the API's PUBLIC_ORIGIN.
ENTITLE_API_UPSTREAM=${ENTITLE_API_UPSTREAM:-entitle-api:3211}
case "$ENTITLE_API_UPSTREAM" in
    *[!A-Za-z0-9.:-]*) echo 'Invalid ENTITLE_API_UPSTREAM characters' >&2; exit 1 ;;
esac
if ! printf '%s\n' "$ENTITLE_API_UPSTREAM" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9.-]*:[0-9]{1,5}$'; then
    echo 'Invalid ENTITLE_API_UPSTREAM: expected a DNS name or IPv4 address and port' >&2
    exit 1
fi
upstream_port=${ENTITLE_API_UPSTREAM##*:}
if [ "$upstream_port" -lt 1 ] || [ "$upstream_port" -gt 65535 ]; then
    echo 'Invalid ENTITLE_API_UPSTREAM port' >&2
    exit 1
fi
if [ -z "${ENTITLE_PUBLIC_HOST:-}" ]; then
    echo 'ENTITLE_PUBLIC_HOST is required' >&2
    exit 1
fi
case "$ENTITLE_PUBLIC_HOST" in
    *[!A-Za-z0-9.:-]*) echo 'Invalid ENTITLE_PUBLIC_HOST characters' >&2; exit 1 ;;
esac
if ! printf '%s\n' "$ENTITLE_PUBLIC_HOST" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$'; then
    echo 'Invalid ENTITLE_PUBLIC_HOST: expected a hostname with optional port' >&2
    exit 1
fi
ENTITLE_PUBLIC_SCHEME=${ENTITLE_PUBLIC_SCHEME:-https}
case "$ENTITLE_PUBLIC_SCHEME" in
    https|http) ;;
    *) echo 'Invalid ENTITLE_PUBLIC_SCHEME: expected https or http' >&2; exit 1 ;;
esac
# Only a validated local mount may enter Nginx location expressions.
# Empty or "/" selects the default /app mount. Standalone releases have no app/
# directory, so their application is served at the root through the fallbacks.
ENTITLE_APP_BASE_PATH=${ENTITLE_APP_BASE_PATH:-/app}
if [ "$ENTITLE_APP_BASE_PATH" = / ]; then ENTITLE_APP_BASE_PATH=/app; fi
case "$ENTITLE_APP_BASE_PATH" in
    *[!A-Za-z0-9_/-]*) echo 'Invalid ENTITLE_APP_BASE_PATH characters' >&2; exit 1 ;;
esac
if ! printf '%s\n' "$ENTITLE_APP_BASE_PATH" | grep -Eq '^/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$' || [ "${#ENTITLE_APP_BASE_PATH}" -gt 128 ]; then
    echo 'Invalid ENTITLE_APP_BASE_PATH: expected an absolute app path' >&2
    exit 1
fi
export ENTITLE_API_UPSTREAM ENTITLE_PUBLIC_HOST ENTITLE_PUBLIC_SCHEME ENTITLE_APP_BASE_PATH
# Comma-separated IPv4/IPv6 CIDRs. Never accept hostnames, bare addresses,
# whitespace or Nginx syntax. Configure the exact ingress /32 or /128 where
# possible. Empty means no trusted proxies, including private network peers.
ENTITLE_REAL_IP_CONFIG=
if [ -n "${ENTITLE_TRUSTED_PROXY_CIDRS:-}" ]; then
    case "$ENTITLE_TRUSTED_PROXY_CIDRS" in
        *[!A-Fa-f0-9:.,/]*) echo 'Invalid ENTITLE_TRUSTED_PROXY_CIDRS' >&2; exit 1 ;;
    esac
    if ! ENTITLE_REAL_IP_CONFIG=$(printf '%s\n' "$ENTITLE_TRUSTED_PROXY_CIDRS" | awk '
        function groups(s, parts, n, i) {
            if (s == "") return 0;
            n = split(s, parts, ":");
            for (i = 1; i <= n; i++)
                if (parts[i] !~ /^[0-9a-fA-F]+$/ || length(parts[i]) > 4) return -100;
            return n;
        }
        function ipv6(s, halves, n, left, right) {
            n = split(s, halves, "::");
            if (n == 1) return groups(s) == 8;
            if (n != 2) return 0;
            left = groups(halves[1]); right = groups(halves[2]);
            return left >= 0 && right >= 0 && left + right < 8;
        }
        function ipv4(s, octets, n, i) {
            n = split(s, octets, "[.]");
            if (n != 4) return 0;
            for (i = 1; i <= n; i++)
                if (octets[i] !~ /^[0-9]+$/ || length(octets[i]) > 3 || octets[i] + 0 > 255 ||
                    (length(octets[i]) > 1 && substr(octets[i], 1, 1) == "0")) return 0;
            return 1;
        }
        {
            count = split($0, cidrs, ",");
            for (i = 1; i <= count; i++) {
                if (split(cidrs[i], pair, "/") != 2 || pair[2] !~ /^[0-9]+$/ ||
                    length(pair[2]) > 3 || (length(pair[2]) > 1 && substr(pair[2], 1, 1) == "0")) exit 1;
                v6 = index(pair[1], ":") > 0;
                if ((v6 && (!ipv6(pair[1]) || pair[2] + 0 > 128)) ||
                    (!v6 && (!ipv4(pair[1]) || pair[2] + 0 > 32))) exit 1;
            }
            print "real_ip_header X-Forwarded-For;";
            print "real_ip_recursive on;";
            for (i = 1; i <= count; i++) print "set_real_ip_from " cidrs[i] ";";
        }
    '); then
        echo 'Invalid ENTITLE_TRUSTED_PROXY_CIDRS: expected comma-separated IPv4/IPv6 CIDRs' >&2
        exit 1
    fi
fi
export ENTITLE_REAL_IP_CONFIG
umask 077
envsubst '${ENTITLE_API_UPSTREAM} ${ENTITLE_PUBLIC_HOST} ${ENTITLE_PUBLIC_SCHEME} ${ENTITLE_REAL_IP_CONFIG} ${ENTITLE_APP_BASE_PATH}' \
    < /etc/entitle/nginx.conf.template > /runtime/nginx.conf
nginx -t -c /runtime/nginx.conf
exec nginx -c /runtime/nginx.conf -g 'daemon off;'
