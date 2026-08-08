#!/bin/sh
# Bring up a virtual display, then Chromium on it.
set -e

export DISPLAY="${DISPLAY:-:99}"
SCREEN="${SCREEN:-1920x1080x24}"

# Both of these are the cost of restarting with state that outlives the process.
#
# Xvfb leaves /tmp/.X<n>-lock behind when it is killed rather than shut down, and
# refuses to start again with "Server is already active for display".
DISPLAY_NUM="${DISPLAY#:}"
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true

# Chromium writes a singleton lock into the profile, and the profile is a
# volume, so a killed container leaves one pointing at a process that no longer
# exists — "The profile appears to be in use by another Chromium process".
# Nothing else shares this profile, so a lock at startup is always stale.
rm -f /profile/Singleton* 2>/dev/null || true

Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp -noreset &

# Chromium exits immediately if X isn't up yet, so wait for it rather than sleep
# a guessed amount.
i=0
until xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 100 ] && echo "Xvfb did not start" && exit 1
  sleep 0.1
done
echo "Xvfb up on $DISPLAY ($SCREEN)"

# Optional, and worth having on a remote box: without it you have no way to see
# what the browser is doing. Off by default because it is unauthenticated.
if [ "${ENABLE_VNC:-false}" = "true" ]; then
  x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 -nopw -quiet &
  echo "VNC on :5900 (no password — bind it to localhost or tunnel it)"
fi

# A session bus silences the "Failed to connect to the bus" spam and lets
# Chromium's own services start properly.
# A real headful browser reports a truthful UA; only override when asked.
if [ -n "${CHROME_USER_AGENT:-}" ]; then
  set -- "--user-agent=${CHROME_USER_AGENT}" "$@"
fi

exec dbus-run-session -- chromium \
  --user-data-dir=/profile \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  "$@"
