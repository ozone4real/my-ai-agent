# Headful Chromium on a virtual display.
#
# Not headless: a real browser drawing to a real (if virtual) X server, so it
# has genuine WebGL renderer strings, fonts, screen metrics and window
# behaviour. That is the honest way to look like a desktop browser — the
# `--headless=new` + spoofed-UA combination leaves all of those wrong.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb x11-utils x11vnc \
      dbus dbus-x11 \
      # Without fonts a headful browser still renders, but the font list is
      # empty — itself a strong automation signal, and pages look wrong.
      fonts-liberation fonts-noto fonts-noto-color-emoji fonts-dejavu-core \
      procps curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY docker/chrome/start.sh /usr/local/bin/start-chrome.sh
RUN chmod +x /usr/local/bin/start-chrome.sh

# Persisted by a volume so cookies and site data survive a restart.
RUN mkdir -p /profile
VOLUME ["/profile"]

EXPOSE 9222 5900
ENTRYPOINT ["/usr/local/bin/start-chrome.sh"]
