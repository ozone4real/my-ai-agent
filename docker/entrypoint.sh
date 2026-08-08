#!/bin/sh
# Resolve the Chrome container to an IP before starting the app.
#
# Chrome's DevTools HTTP endpoint refuses any Host header that isn't an IP or
# localhost — ask it for /json/version as "chrome:9222" and it answers
# "Host header is specified and is not an IP address or localhost." Since
# Compose only gives us a service *name*, resolve it here and hand
# chrome-devtools-mcp an IP instead.
#
# No Chrome service (or DNS not up yet) just leaves CHROME_URL as configured;
# the browser tools then fail on use rather than at startup, which is the same
# behaviour as running without Chrome locally.
set -e

if [ -z "${CHROME_URL_RESOLVED:-}" ] && [ -n "${CHROME_HOST:-}" ]; then
  ip=$(getent hosts "$CHROME_HOST" 2>/dev/null | awk '{print $1}' | head -n 1)
  if [ -n "$ip" ]; then
    export CHROME_URL="http://${ip}:${CHROME_PORT:-9222}"
    export CHROME_URL_RESOLVED=1
    echo "Chrome DevTools at $CHROME_URL (resolved from $CHROME_HOST)"
  else
    echo "Could not resolve $CHROME_HOST; leaving CHROME_URL as ${CHROME_URL:-unset}"
  fi
fi

exec "$@"
