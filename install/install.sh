#!/bin/sh
# autotrack installer for Mac. No sudo, no Node needed. Re-running it updates in place.
#
#   AUTOTRACK='<install code>' sh -c "$(curl -fsSL https://raw.githubusercontent.com/wrenautomation/autotrack/main/install/install.sh)"
#
# The code comes from `autobrowse autotrack enroll <device>`. Other env, for tests:
#   AUTOTRACK_BUNDLE         local path or URL of the bundle instead of the latest release;
#                            SHA256SUMS is read from beside it
#   AUTOTRACK_DIR            data dir (default ~/Library/Application Support/autotrack)
#   AUTOTRACK_ENDPOINT       S3-compatible endpoint instead of AWS
#   AUTOTRACK_NO_AUTOSTART=1 install everything but load no LaunchAgent and ask for nothing
#   AUTOTRACK_PERM_TIMEOUT   seconds to wait for the permissions (default 600)
set -eu

REPO=wrenautomation/autotrack
LABEL=com.wrenautomation.autotrack
# Placeholder until the extension is published (unlisted) on the Chrome Web Store.
STORE_URL="https://chromewebstore.google.com/detail/autotrack/colpoheiepckdglfmebejhelggjikjim"

say() { printf '%s\n' "$*"; }
die() {
  printf 'autotrack install: %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || die "this installer is for Mac. On Windows, use install.ps1 (see the README)."
code=${AUTOTRACK:-}
[ -n "$code" ] || die "AUTOTRACK is not set. Run the whole line that \`autobrowse autotrack enroll <device>\` printed."
case $code in *[!A-Za-z0-9_-]*) die "AUTOTRACK is not an install code (base64url expected).";; esac

arch=$(uname -m)
[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ] && arch=arm64 # Rosetta shell
case $arch in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) die "unsupported CPU: $arch" ;;
esac
asset="autotrack-darwin-$arch.tar.gz"

data=${AUTOTRACK_DIR:-"$HOME/Library/Application Support/autotrack"}
app="$data/app"
uid=$(id -u)
plist="$HOME/Library/LaunchAgents/$LABEL.plist"
autostart=1
[ -n "${AUTOTRACK_NO_AUTOSTART:-}" ] && autostart=

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

fetch() { # <src> <dest>: http(s) URL, file:// URL or a path
  case $1 in
    http://* | https://*) curl -fsSL --retry 3 -o "$2" "$1" || die "download failed: $1" ;;
    file://*) cp "${1#file://}" "$2" 2>/dev/null || die "not found: $1" ;;
    *) cp "$1" "$2" 2>/dev/null || die "not found: $1" ;;
  esac
}

if [ -n "${AUTOTRACK_BUNDLE:-}" ]; then
  src=$AUTOTRACK_BUNDLE
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
got=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
[ "$got" = "$want" ] || die "checksum mismatch for $asset: got $got, want $want"
say "Checksum ok"

mkdir -p "$data"
chmod 700 "$data"
rm -rf "$data/app.new"
mkdir "$data/app.new"
tar -xzf "$tmp/$asset" -C "$data/app.new" || die "could not unpack $asset"
if ! "$data/app.new/node/node" "$data/app.new/install/setup.mjs" --check; then
  rm -rf "$data/app.new"
  die "fix the code and run again"
fi

# Stop the running one: login item first, so nothing restarts it.
if [ -n "$autostart" ]; then launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true; fi
if [ -x "$app/bin/autotrack" ]; then AUTOTRACK_DIR="$data" "$app/bin/autotrack" stop >/dev/null 2>&1 || true; fi
i=0
while [ -f "$data/track.pid" ] && kill -0 "$(cat "$data/track.pid" 2>/dev/null || echo 0)" 2>/dev/null && [ $i -lt 20 ]; do
  sleep 0.5
  i=$((i + 1))
done

rm -rf "$data/app.old"
[ -d "$app" ] && mv "$app" "$data/app.old"
mv "$data/app.new" "$app"
rm -rf "$data/app.old"
node="$app/node/node"
cli="$app/bin/autotrack"
say "Installed $(cat "$app/VERSION") in $app"

(umask 077 && "$node" "$app/install/setup.mjs") || die "setup failed"

# `autotrack` on the command line.
mkdir -p "$HOME/.local/bin"
envline=""
[ -n "${AUTOTRACK_DIR:-}" ] && envline="AUTOTRACK_DIR='$data' "
printf '#!/bin/sh\n# autotrack CLI (written by install.sh)\n%sexec "%s" "$@"\n' "$envline" "$cli" >"$HOME/.local/bin/autotrack"
chmod 755 "$HOME/.local/bin/autotrack"

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

if [ -z "$autostart" ]; then
  say "AUTOTRACK_NO_AUTOSTART set: not starting it, not asking for permissions."
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
say "Browser clicks: add the autotrack extension to Chrome or Edge: $STORE_URL"
