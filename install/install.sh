#!/bin/sh
# autotrack installer for Mac and Linux. No sudo, no Node needed. Re-running it updates in place.
#
#   AUTOTRACK='<install code>' sh -c "$(curl -fsSL https://raw.githubusercontent.com/wrenautomation/autotrack/main/install/install.sh)"
#
# To update, run the same line without AUTOTRACK: the installed config.json's code is kept.
# The code comes from `autobrowse autotrack enroll <device>`. Other env, for tests:
#   AUTOTRACK_BUNDLE         local path or URL of the bundle instead of the latest release;
#                            SHA256SUMS is read from beside it. A folder works too: the bundle for
#                            this OS and CPU is taken from it (the installers' bundled copies)
#   AUTOTRACK_DIR            data dir (default ~/Library/Application Support/autotrack on Mac,
#                            ${XDG_DATA_HOME:-~/.local/share}/autotrack on Linux)
#   AUTOTRACK_ENDPOINT       S3-compatible endpoint instead of AWS
#   AUTOTRACK_NO_AUTOSTART=1 install everything but start nothing at login and ask for nothing
#   AUTOTRACK_PERM_TIMEOUT   seconds to wait for the Mac permissions (default 600)
#   AUTOTRACK_NO_BROWSER=1   unpack the extension but don't copy its path or open a browser
#   AUTOTRACK_STEP=check     only check the code and the bundle's checksum; touches nothing (the
#                            installer apps ask for the code, check it, then install)
set -eu

REPO=wrenautomation/autotrack
LABEL=com.wrenautomation.autotrack
SERVICE=autotrack.service
# The extension ships unpacked until it is on the Chrome Web Store. Set STORE_LIVE=1 once the
# listing exists: the installer then prints STORE_URL and no longer unpacks or opens anything.
STORE_LIVE=0
STORE_URL="https://chromewebstore.google.com/detail/autotrack/colpoheiepckdglfmebejhelggjikjim"

say() { printf '%s\n' "$*"; }
die() {
  printf 'autotrack install: %s\n' "$*" >&2
  exit 1
}

os=$(uname -s)
case $os in
  Darwin | Linux) ;;
  *) die "this installer is for Mac and Linux. On Windows, use install.ps1 (see the README)." ;;
esac
arch=$(uname -m)
if [ "$os" = Darwin ]; then
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ] && arch=arm64 # Rosetta shell
  case $arch in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) die "unsupported CPU: $arch" ;;
  esac
  asset="autotrack-darwin-$arch.tar.gz"
  data=${AUTOTRACK_DIR:-"$HOME/Library/Application Support/autotrack"}
else
  case $arch in
    x86_64 | amd64) arch=x64 ;;
    *) die "unsupported CPU: $arch (Linux builds are x86_64 only)" ;;
  esac
  asset="autotrack-linux-$arch.tar.gz"
  data=${AUTOTRACK_DIR:-"${XDG_DATA_HOME:-$HOME/.local/share}/autotrack"}
  config=${XDG_CONFIG_HOME:-}
  case $config in /*) ;; *) config="$HOME/.config" ;; esac
  unit="$config/systemd/user/$SERVICE"
  desktop="$config/autostart/autotrack.desktop"
fi

# An update needs no code: a device already installed keeps the one in its config.json.
code=${AUTOTRACK:-}
if [ -z "$code" ] && [ -f "$data/config.json" ]; then
  code=$(sed -n 's/^ *"code": *"\([A-Za-z0-9_-]*\)".*/\1/p' "$data/config.json" | head -n 1)
fi
[ -n "$code" ] || die "AUTOTRACK is not set. Run the whole line that \`autobrowse autotrack enroll <device>\` printed."
case $code in *[!A-Za-z0-9_-]*) die "AUTOTRACK is not an install code (base64url expected).";; esac
export AUTOTRACK="$code"

app="$data/app"
uid=$(id -u)
plist="$HOME/Library/LaunchAgents/$LABEL.plist"
autostart=1
[ -n "${AUTOTRACK_NO_AUTOSTART:-}" ] && autostart=
step=${AUTOTRACK_STEP:-all}
case $step in all | check) ;; *) die "AUTOTRACK_STEP must be all or check (got '$step')." ;; esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

fetch() { # <src> <dest>: http(s) URL, file:// URL or a path
  case $1 in
    http://* | https://*)
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 -o "$2" "$1" || die "download failed: $1"
      elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" "$1" || die "download failed: $1"
      else
        die "neither curl nor wget is installed"
      fi
      ;;
    file://*) cp "${1#file://}" "$2" 2>/dev/null || die "not found: $1" ;;
    *) cp "$1" "$2" 2>/dev/null || die "not found: $1" ;;
  esac
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'; else shasum -a 256 "$1" | awk '{ print $1 }'; fi
}

if [ -n "${AUTOTRACK_BUNDLE:-}" ]; then
  src=$AUTOTRACK_BUNDLE
  [ -d "$src" ] && src="$src/$asset"
  asset=$(basename "$src")
  sums="$(dirname "$src")/SHA256SUMS"
else
  src="https://github.com/$REPO/releases/latest/download/$asset"
  sums="https://github.com/$REPO/releases/latest/download/SHA256SUMS"
fi

say "Downloading $asset"
fetch "$src" "$tmp/$asset"
fetch "$sums" "$tmp/SHA256SUMS"
want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/SHA256SUMS")
[ -n "$want" ] || die "SHA256SUMS has no line for $asset"
got=$(sha256 "$tmp/$asset")
[ "$got" = "$want" ] || die "checksum mismatch for $asset: got $got, want $want"
say "Checksum ok"

# `check` unpacks into the temp dir and leaves the data dir alone.
if [ "$step" = check ]; then
  new="$tmp/app.new"
else
  mkdir -p "$data"
  chmod 700 "$data"
  new="$data/app.new"
  [ "$os" = Darwin ] || { mkdir -p "$data/versions" && new="$data/versions/new"; }
fi
rm -rf "$new"
mkdir "$new"
tar -xzf "$tmp/$asset" -C "$new" || die "could not unpack $asset"
if ! "$new/node/node" "$new/install/setup.mjs" --check; then
  rm -rf "$new"
  die "fix the code and run again"
fi
[ "$step" = check ] && exit 0

# Stop the running one: autostart first, so nothing restarts it.
if [ -n "$autostart" ]; then
  if [ "$os" = Darwin ]; then
    launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
  elif [ -f "$unit" ]; then
    systemctl --user stop "$SERVICE" 2>/dev/null || true
  fi
fi
if [ -x "$app/bin/autotrack" ]; then AUTOTRACK_DIR="$data" "$app/bin/autotrack" stop >/dev/null 2>&1 || true; fi
i=0
while [ -f "$data/track.pid" ] && kill -0 "$(cat "$data/track.pid" 2>/dev/null || echo 0)" 2>/dev/null && [ $i -lt 20 ]; do
  sleep 0.5
  i=$((i + 1))
done

if [ "$os" = Darwin ]; then
  # Mac keeps a real app folder: its permissions are tied to the node binary, so no self-update yet.
  rm -rf "$data/app.old"
  [ -d "$app" ] && mv "$app" "$data/app.old"
  mv "$new" "$app"
  rm -rf "$data/app.old"
else
  # Linux self-updates (src/update.ts): versions/<v>, and app a symlink to the current one. An
  # install before 0.3.0 left a real app folder: it goes.
  version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$new/package.json" | head -n 1)
  case "$version" in [0-9]*.[0-9]*.[0-9]*) ;; *) die "bad version in the bundle: $version" ;; esac
  mkdir -p "$data/versions"
  rm -rf "$data/versions/$version"
  mv "$new" "$data/versions/$version"
  if [ -d "$app" ] && [ ! -L "$app" ]; then rm -rf "$app"; fi
  ln -sfn "versions/$version" "$data/app.next"
  mv -T "$data/app.next" "$app"
  # A fresh install starts clean: no pending rollback, other versions gone.
  rm -f "$data/update.json"
  for d in "$data/versions"/*; do
    [ "$d" = "$data/versions/$version" ] || rm -rf "$d"
  done
fi
node="$app/node/node"
cli="$app/bin/autotrack"
say "Installed $(cat "$app/VERSION") in $app"

(umask 077 && "$node" "$app/install/setup.mjs") || die "setup failed"

# The browser extension, unpacked at a stable path (Chrome and Edge reload unpacked extensions
# from it on restart). Replaced on update. The manifest's fixed key keeps the extension id. The
# Linux bundle carries it unpacked too (unzip is not on every distro).
ext="$data/extension"
if [ "$STORE_LIVE" != 1 ]; then
  rm -rf "$data/extension.new"
  if [ -f "$app/extension/manifest.json" ]; then
    cp -R "$app/extension" "$data/extension.new"
  else
    mkdir "$data/extension.new"
    unzip -q "$app/extension.zip" -d "$data/extension.new" 2>/dev/null || true
  fi
  if [ -f "$data/extension.new/manifest.json" ]; then
    rm -rf "$data/extension.old"
    [ -d "$ext" ] && mv "$ext" "$data/extension.old"
    mv "$data/extension.new" "$ext"
    rm -rf "$data/extension.old"
    say "Extension unpacked in $ext"
  else
    rm -rf "$data/extension.new"
    say "Warning: could not unpack the browser extension. The recorder works without it."
    ext=""
  fi
fi

# `autotrack` on the command line.
mkdir -p "$HOME/.local/bin"
envline=""
[ -n "${AUTOTRACK_DIR:-}" ] && envline="AUTOTRACK_DIR='$data' "
printf '#!/bin/sh\n# autotrack CLI (written by install.sh)\n%sexec "%s" "$@"\n' "$envline" "$cli" >"$HOME/.local/bin/autotrack"
chmod 755 "$HOME/.local/bin/autotrack"

# ---- Linux ---------------------------------------------------------------------------------

# A systemd value: % and $ doubled, the whole in double quotes with \ and " escaped.
sd_quote() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/\$/$$/g')"; }
# A desktop-entry Exec argument: double quotes with \ " ` $ escaped, % doubled.
de_quote() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\\\\\/g' -e 's/"/\\"/g' -e 's/`/\\`/g' -e 's/\$/\\$/g' -e 's/%/%%/g')"; }

running() { [ -f "$data/track.pid" ] && kill -0 "$(cat "$data/track.pid" 2>/dev/null || echo 0)" 2>/dev/null; }
wayland() { [ "${XDG_SESSION_TYPE:-}" = wayland ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }

linux_libs() { # the X libraries the input hook loads; a desktop has them, a minimal box may not
  missing=""
  for l in libX11.so.6 libXtst.so.6 libXt.so.6 libXrandr.so.2; do
    if command -v ldconfig >/dev/null 2>&1; then
      ldconfig -p 2>/dev/null | grep -q "$l" && continue
    fi
    for d in /usr/lib/x86_64-linux-gnu /usr/lib64 /usr/lib /lib/x86_64-linux-gnu; do
      [ -e "$d/$l" ] && continue 2
    done
    missing="$missing $l"
  done
  if [ -n "$missing" ]; then
    say ""
    say "Warning: missing X libraries:$missing"
    say "  Ubuntu, Debian: sudo apt install libx11-6 libxtst6 libxt6 libxrandr2"
    say "  Fedora:         sudo dnf install libX11 libXtst libXt libXrandr"
  fi
}

linux_autostart() {
  rm -f "$desktop"
  if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet graphical-session.target 2>/dev/null; then
    mkdir -p "$(dirname "$unit")"
    {
      printf '[Unit]\n'
      printf 'Description=autotrack: records input and the screen around it\n'
      printf 'PartOf=graphical-session.target\nAfter=graphical-session.target\n\n'
      printf '[Service]\n'
      printf 'ExecStart=%s %s start\n' "$(sd_quote "$node")" "$(sd_quote "$app/dist/cli.js")"
      [ -n "${AUTOTRACK_DIR:-}" ] && printf 'Environment=%s\n' "$(sd_quote "AUTOTRACK_DIR=$data")"
      # Exit 75 is an update or a rollback; anything but 0 restarts.
      printf 'Environment=AUTOTRACK_SUPERVISED=1\nRestart=on-failure\nRestartSec=10\n\n'
      printf '[Install]\nWantedBy=graphical-session.target\n'
    } >"$unit"
    systemctl --user daemon-reload
    systemctl --user import-environment DISPLAY XAUTHORITY 2>/dev/null || true
    systemctl --user enable "$SERVICE" >/dev/null 2>&1 || die "systemctl could not enable $unit"
    say "Login service $unit"
    systemctl --user restart "$SERVICE" || die "systemctl could not start $SERVICE"
  else
    # No systemd user session (or no graphical-session.target): the XDG autostart entry, and
    # started now, detached from this shell.
    if [ -f "$unit" ]; then
      systemctl --user disable --now "$SERVICE" >/dev/null 2>&1 || true
      rm -f "$unit"
    fi
    mkdir -p "$(dirname "$desktop")"
    exec_line="$(de_quote "$node") $(de_quote "$app/dist/cli.js") start"
    [ -n "${AUTOTRACK_DIR:-}" ] && exec_line="env $(de_quote "AUTOTRACK_DIR=$data") $exec_line"
    {
      printf '[Desktop Entry]\nType=Application\nName=autotrack\n'
      printf 'Comment=Records input and the screen around it\n'
      printf 'Exec=%s\n' "$exec_line"
      printf 'Terminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n'
    } >"$desktop"
    say "Login item $desktop"
    if [ -n "${DISPLAY:-}" ]; then
      if command -v setsid >/dev/null 2>&1; then
        AUTOTRACK_DIR="$data" setsid "$node" "$app/dist/cli.js" start >>"$data/autostart.log" 2>&1 </dev/null &
      else
        AUTOTRACK_DIR="$data" nohup "$node" "$app/dist/cli.js" start >>"$data/autostart.log" 2>&1 </dev/null &
      fi
    fi
  fi
  if [ ! -f "$unit" ] && [ -z "${DISPLAY:-}" ]; then
    say "No X display in this shell: autotrack starts at your next desktop login."
    return
  fi
  i=0
  until running; do
    i=$((i + 1))
    [ $i -lt 30 ] && sleep 0.5 || break
  done
  running && say "Started" || say "Warning: autotrack did not start yet; see $data/track.log"
}

# Browsers on PATH, as "<command> <label> <scheme>".
linux_browsers() {
  seen=""
  for b in "google-chrome-stable|Google Chrome|chrome" "google-chrome|Google Chrome|chrome" \
    "chromium|Chromium|chrome" "chromium-browser|Chromium|chrome" \
    "microsoft-edge-stable|Microsoft Edge|edge" "microsoft-edge|Microsoft Edge|edge" \
    "brave-browser|Brave|brave" "brave|Brave|brave"; do
    cmd=${b%%|*}
    rest=${b#*|}
    label=${rest%%|*}
    command -v "$cmd" >/dev/null 2>&1 || continue
    case "|$seen|" in *"|$label|"*) continue ;; esac
    seen="$seen|$label"
    printf '%s|%s\n' "$b" ""
  done
}

copy_text() { # to the clipboard: X11, then Wayland
  if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$1" | wl-copy >/dev/null 2>&1 && return 0
  fi
  if command -v xclip >/dev/null 2>&1; then
    printf '%s' "$1" | xclip -selection clipboard >/dev/null 2>&1 && return 0
  fi
  if command -v xsel >/dev/null 2>&1; then
    printf '%s' "$1" | xsel --clipboard --input >/dev/null 2>&1 && return 0
  fi
  return 1
}

linux_extension_help() {
  say ""
  if [ "$STORE_LIVE" = 1 ]; then
    say "Browser clicks: add the autotrack extension to Chrome, Edge or Brave: $STORE_URL"
    return
  fi
  [ -n "$ext" ] || return 0
  say "Browser clicks: load the autotrack extension in Chrome, Chromium, Edge or Brave."
  say "Folder: $ext"
  found=""
  [ -n "${AUTOTRACK_NO_BROWSER:-}" ] || found=$(linux_browsers)
  if [ -z "$found" ]; then
    say "Open chrome://extensions (or edge://, brave://), turn on Developer mode, Load unpacked, pick that folder."
    return
  fi
  copy_text "$ext" && say "(Copied to your clipboard.)"
  printf '%s\n' "$found" | while IFS='|' read -r cmd label scheme _; do
    say ""
    say "$label:"
    say "  1. Open $scheme://extensions and turn on Developer mode (top right)."
    say "  2. Click Load unpacked."
    say "  3. Press Ctrl+L, paste the folder (already copied), press Enter, then Select."
    # chrome:// is not a URL xdg-open can hand over: the browser itself opens it, as a new tab
    # when it is running.
    if command -v setsid >/dev/null 2>&1; then
      setsid "$cmd" "$scheme://extensions" >/dev/null 2>&1 </dev/null &
    else
      nohup "$cmd" "$scheme://extensions" >/dev/null 2>&1 </dev/null &
    fi
  done
  say ""
  say "If autotrack is already listed there, press its reload button instead."
}

if [ "$os" = Linux ]; then
  linux_libs
  if [ -z "$autostart" ]; then
    say "AUTOTRACK_NO_AUTOSTART set: not starting it."
    linux_extension_help
    say "Done."
    exit 0
  fi
  linux_autostart
  if wayland; then
    say ""
    say "This is a Wayland session. autotrack sees only XWayland apps there: most input, windows"
    say "and screen are missed. For full recording, log out, pick the Xorg session (the gear icon"
    say "on the login screen), and log in again."
  fi
  say ""
  say "Checking (about 15 seconds)..."
  AUTOTRACK_DIR="$data" "$cli" doctor 2>&1 || true
  say ""
  if running; then
    say "autotrack is recording."
  elif [ ! -f "$unit" ] && [ -z "${DISPLAY:-}" ]; then
    say "NOT DONE: no X display here. Log in to the desktop; autotrack starts then."
  else
    say "NOT DONE: autotrack is not running. See $data/track.log, then run: autotrack start"
  fi
  say "Pause or resume: Ctrl+Alt+Shift+P (a notification says which)."
  say "Status: autotrack status    Uninstall: autotrack uninstall"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "(autotrack is in ~/.local/bin, not on your PATH: run \"$cli\" instead.)" ;; esac
  linux_extension_help
  exit 0
fi

# ---- Mac -----------------------------------------------------------------------------------

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# <label> <log> <keepalive 0|1> <args...>: a LaunchAgent plist running the bundled node.
agent_plist() {
  label=$1 log=$2 keep=$3
  shift 3
  printf '<?xml version="1.0" encoding="UTF-8"?>\n'
  printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
  printf '<plist version="1.0">\n<dict>\n'
  printf '  <key>Label</key><string>%s</string>\n' "$label"
  printf '  <key>ProgramArguments</key>\n  <array>\n'
  printf '    <string>%s</string>\n' "$(xml "$node")"
  for a in "$@"; do printf '    <string>%s</string>\n' "$(xml "$a")"; done
  printf '  </array>\n'
  printf '  <key>RunAtLoad</key><true/>\n'
  if [ "$keep" = 1 ]; then
    printf '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n'
    printf '  <key>ThrottleInterval</key><integer>30</integer>\n'
  fi
  printf '  <key>ProcessType</key><string>Interactive</string>\n'
  printf '  <key>StandardOutPath</key><string>%s</string>\n' "$(xml "$log")"
  printf '  <key>StandardErrorPath</key><string>%s</string>\n' "$(xml "$log")"
  if [ -n "${AUTOTRACK_DIR:-}" ]; then
    printf '  <key>EnvironmentVariables</key><dict><key>AUTOTRACK_DIR</key><string>%s</string></dict>\n' "$(xml "$data")"
  fi
  printf '</dict>\n</plist>\n'
}

mkdir -p "$(dirname "$plist")"
agent_plist "$LABEL" "$data/launchd.log" 1 "$app/dist/cli.js" start >"$plist"
say "Login item $plist"

# Browser extension: three steps per browser found.
have_app() { [ -d "/Applications/$1.app" ] || [ -d "$HOME/Applications/$1.app" ]; }
# <app name> <bundle id> <url>. chrome:// URLs aren't openable by `open -a`; AppleScript works
# whether or not the browser is running (it may ask to let Terminal control it). Fallback: pass the
# URL as an argument, which only takes effect if the browser wasn't running.
open_page() {
  osascript -e "tell application \"$1\" to activate" -e "tell application \"$1\" to open location \"$3\"" >/dev/null 2>&1 && return 0
  open -b "$2" --args "$3" >/dev/null 2>&1 || true
}
browser_steps() { # <app name> <bundle id> <scheme>
  say ""
  say "$1:"
  say "  1. Open $3://extensions and turn on Developer mode (top right)."
  say "  2. Click Load unpacked."
  say "  3. Press Cmd+Shift+G, paste the folder (already copied), press Enter, then Select."
  [ -n "${AUTOTRACK_NO_BROWSER:-}" ] || open_page "$1" "$2" "$3://extensions"
}

extension_help() {
  say ""
  if [ "$STORE_LIVE" = 1 ]; then
    say "Browser clicks: add the autotrack extension to Chrome or Edge: $STORE_URL"
  elif [ -n "$ext" ]; then
    say "Browser clicks: load the autotrack extension in Chrome or Edge."
    say "Folder: $ext"
    found=""
    if [ -z "${AUTOTRACK_NO_BROWSER:-}" ]; then
      have_app "Google Chrome" && found="$found chrome"
      have_app "Microsoft Edge" && found="$found edge"
    fi
    if [ -n "$found" ]; then
      printf '%s' "$ext" | pbcopy 2>/dev/null && say "(Copied to your clipboard.)"
      case $found in *chrome*) browser_steps "Google Chrome" com.google.Chrome chrome ;; esac
      case $found in *edge*) browser_steps "Microsoft Edge" com.microsoft.edgemac edge ;; esac
      say ""
      say "If autotrack is already listed there, press its reload button instead."
    else
      say "Open chrome://extensions (or edge://extensions), turn on Developer mode, Load unpacked, pick that folder."
    fi
  fi
}

if [ -z "$autostart" ]; then
  say "AUTOTRACK_NO_AUTOSTART set: not starting it, not asking for permissions."
  extension_help
  say "Done."
  exit 0
fi

launchctl enable "gui/$uid/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$uid" "$plist" || die "launchctl could not load $plist"
say "Started"

# Runs node <args> once as a LaunchAgent job and waits for it. macOS checks permissions against
# the "responsible" process: run from this shell, node would answer for Terminal, not itself.
once() { # <name> <log> <args...>
  label="$LABEL.$1" log=$2
  shift 2
  p="$tmp/$label.plist"
  agent_plist "$label" "$log" 0 "$@" >"$p"
  rm -f "$log"
  launchctl bootout "gui/$uid/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$p" || return 1
  n=0
  while [ $n -lt 120 ]; do # 60 s
    sleep 0.5
    n=$((n + 1))
    state=$(launchctl print "gui/$uid/$label" 2>/dev/null || true)
    case $state in *"state = running"*) continue ;; esac
    case $state in *"last exit code = "[0-9]*) break ;; esac
  done
  launchctl bootout "gui/$uid/$label" 2>/dev/null || true
}

perm_json() {
  rm -f "$tmp/perm.json"
  once perm "$tmp/perm.log" "$app/install/perm.mjs" "$tmp/perm.json"
  cat "$tmp/perm.json" 2>/dev/null || echo '{}'
}
granted() { # <json> <key>
  case $1 in *"\"$2\":true"*) return 0 ;; esac
  return 1
}

pane() {
  case $1 in
    accessibility) echo "Privacy_Accessibility Accessibility" ;;
    input) echo "Privacy_ListenEvent Input_Monitoring" ;;
    screen) echo "Privacy_ScreenCapture Screen_Recording" ;;
  esac
}

timeout=${AUTOTRACK_PERM_TIMEOUT:-600}
start=$(date +%s)
perms=$(perm_json)
missing=""
for k in accessibility input screen; do granted "$perms" "$k" || missing="$missing $k"; done
if [ -n "$missing" ]; then
  say ""
  say "autotrack needs three Mac permissions for its own node (\"node\" in the lists):"
  say "  Accessibility, Input Monitoring, Screen Recording."
  say "In each pane that opens, turn on \"node\". If it isn't listed, press +, then Cmd+Shift+G,"
  say "paste the path below, and choose it:"
  say "  $node"
  for k in $missing; do
    set -- $(pane "$k")
    say ""
    say "Opening $(echo "$2" | tr _ ' ')..."
    open "x-apple.systempreferences:com.apple.preference.security?$1" 2>/dev/null || true
    while :; do
      perms=$(perm_json)
      granted "$perms" "$k" && break
      [ $(($(date +%s) - start)) -ge "$timeout" ] && break
      sleep 2
    done
  done
  launchctl kickstart -k "gui/$uid/$LABEL" 2>/dev/null || true # pick the grants up
fi
perms=$(perm_json)
missing=""
for k in accessibility input screen; do granted "$perms" "$k" || missing="$missing $(pane "$k" | cut -d' ' -f2 | tr _ ' ')"; done

say ""
say "Checking (about 15 seconds)..."
once doctor "$tmp/doctor.log" "$app/dist/cli.js" doctor || true
cat "$tmp/doctor.log" 2>/dev/null || true

say ""
if [ -n "$missing" ]; then
  say "NOT DONE: still missing:$missing."
  say "Turn \"node\" on in System Settings > Privacy & Security for each, then run:"
  say "  launchctl kickstart -k gui/$uid/$LABEL && autotrack doctor"
else
  say "autotrack is recording."
fi
say "Pause or resume: Ctrl+Alt+Shift+P (a notification says which)."
say "Status: autotrack status    Uninstall: autotrack uninstall"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "(autotrack is in ~/.local/bin, not on your PATH: run \"$cli\" instead.)" ;; esac
extension_help
