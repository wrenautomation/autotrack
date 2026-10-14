#!/bin/sh
# Runs a command in a throwaway X11 desktop (CI only): Xvfb with RECORD, openbox for EWMH, and,
# under the caller's dbus-run-session, the AT-SPI bus GTK apps report to.
#   dbus-run-session -- sh test/e2e/linux-x.sh <command> [args...]
set -eu

export DISPLAY=:99
export XDG_SESSION_TYPE=x11
unset WAYLAND_DISPLAY || true
export NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge

Xvfb "$DISPLAY" -screen 0 1600x900x24 +extension RECORD -nolisten tcp >/tmp/autotrack-xvfb.log 2>&1 &
xvfb=$!
i=0
until xdpyinfo >/dev/null 2>&1 || xdotool getmouselocation >/dev/null 2>&1; do
  i=$((i + 1))
  [ $i -lt 50 ] || { echo "::error::Xvfb did not start: $(cat /tmp/autotrack-xvfb.log)"; exit 1; }
  sleep 0.2
done
openbox >/tmp/autotrack-openbox.log 2>&1 &
wm=$!
# The accessibility bus, started now rather than on the first GTK app's request.
for l in /usr/libexec/at-spi-bus-launcher /usr/lib/at-spi2-core/at-spi-bus-launcher; do
  if [ -x "$l" ]; then
    "$l" --launch-immediately >/tmp/autotrack-atspi.log 2>&1 &
    break
  fi
done
sleep 1
xdotool mousemove 800 450

rc=0
"$@" || rc=$?
kill "$wm" "$xvfb" 2>/dev/null || true
exit "$rc"
