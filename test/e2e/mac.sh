#!/bin/sh
# Mac end to end (CI only: it posts real input). Installs the built bundle with a fake install code
# pointing at the local S3 stub, drives TextEdit and a password form with CGEvents, stops, ships,
# checks what the stub received, then uninstalls and checks nothing is left registered.
#
#   sh test/e2e/mac.sh        (after `node scripts/bundle.mjs`; needs node on PATH and swiftc)
set -eu

repo=$(cd "$(dirname "$0")/../.." && pwd)
work="${RUNNER_TEMP:-/tmp}/autotrack-e2e"
rm -rf "$work"
mkdir -p "$work"
uid=$(id -u)
label=com.wrenautomation.autotrack
data="$HOME/Library/Application Support/autotrack"
app="$data/app"
cli="$HOME/.local/bin/autotrack"
device=e2e-mac
bucket=autotrack-e2e
key_id=AKIAE2ETESTKEY000001
secret=e2e-secret-not-real-0123456789

step() { printf '\n== %s\n' "$*"; }
die() {
  echo "::error::e2e: $*"
  exit 1
}

bundle=$(ls "$repo"/bundles/autotrack-darwin-*.tar.gz | head -1)
[ -f "$bundle" ] || die "no darwin bundle in $repo/bundles"

step "S3 stub"
node "$repo/test/e2e/s3-stub.mjs" --root "$work/s3" --key-id "$key_id" --secret "$secret" \
  --prefix "$device/" --port-file "$work/port" >"$work/stub.log" 2>&1 &
stub=$!
form=""
cleanup() {
  kill "$stub" 2>/dev/null || true
  [ -n "$form" ] && kill "$form" 2>/dev/null || true
  cp "$data"/*.log "$work/" 2>/dev/null || true
}
trap cleanup EXIT
i=0
while [ ! -s "$work/port" ]; do
  i=$((i + 1))
  [ $i -lt 50 ] || die "stub did not start: $(cat "$work/stub.log")"
  sleep 0.2
done
port=$(cat "$work/port")
code=$(node -e 'console.log(Buffer.from(JSON.stringify({v:1,bucket:process.argv[1],region:"us-east-1",device:process.argv[2],keyId:process.argv[3],secret:process.argv[4]})).toString("base64url"))' \
  "$bucket" "$device" "$key_id" "$secret")

step "Input driver and form"
swiftc -O -o "$work/mac-input" "$repo/test/e2e/mac-input.swift"
swiftc -O -o "$work/mac-form" "$repo/test/e2e/mac-form.swift"

step "TCC grants"
soft=""
if ! sh "$repo/test/e2e/mac-tcc.sh" "$app/node/node" "$app/helpers/mac/probe" "$work/mac-input"; then
  soft="input,screen"
fi

step "install.sh"
{
  AUTOTRACK="$code" AUTOTRACK_BUNDLE="$bundle" AUTOTRACK_ENDPOINT="http://127.0.0.1:$port" \
    AUTOTRACK_PERM_TIMEOUT=60 AUTOTRACK_NO_BROWSER=1 sh "$repo/install/install.sh" 2>&1 && rc=0 || rc=$?
  echo "$rc" >"$work/install.rc"
} | tee "$work/install.log"
[ "$(cat "$work/install.rc")" = 0 ] || die "install.sh exited $(cat "$work/install.rc")"
[ -f "$HOME/Library/LaunchAgents/$label.plist" ] || die "no LaunchAgent plist"
launchctl print "gui/$uid/$label" >/dev/null 2>&1 || die "LaunchAgent not loaded"
for b in "Google/Chrome" "Microsoft Edge"; do
  [ -f "$HOME/Library/Application Support/$b/NativeMessagingHosts/$label.json" ] || die "no $b native host manifest"
done
[ -f "$data/extension/manifest.json" ] || die "no unpacked extension in $data/extension"
grep -q '"key"' "$data/extension/manifest.json" || die "unpacked manifest.json has no key (the extension id would change)"
grep -q "Input Monitoring granted" "$work/install.log" || soft="$soft,input"
grep -q "Accessibility granted" "$work/install.log" || soft="$soft,input"
grep -q "Screen Recording granted" "$work/install.log" || soft="$soft,screen"
[ -z "$soft" ] || echo "::warning::e2e: permissions not granted on this runner ($soft): those checks are skipped"

i=0
until "$cli" status >/dev/null 2>&1; do
  i=$((i + 1))
  [ $i -lt 30 ] || die "recorder not running: $(tail -20 "$data/track.log" "$data/launchd.log" 2>/dev/null)"
  sleep 1
done
"$cli" status

step "Drive input"
: >"$work/note.txt"
open -a TextEdit "$work/note.txt"
sleep 3
"$work/mac-form" "$work/form.json" >"$work/form.log" 2>&1 &
form=$!
i=0
while [ ! -s "$work/form.json" ]; do
  i=$((i + 1))
  [ $i -lt 100 ] || die "form did not come up: $(cat "$work/form.log")"
  sleep 0.2
done
# The driver as its own launchd job, so its TCC identity is the driver binary (granted above), not
# this shell. Arguments go to mac-input; waits up to a minute for it to exit.
drive() {
  args=""
  for a in "$@"; do args="$args<string>$a</string>"; done
  cat >"$work/input.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label.e2e-input</string>
  <key>ProgramArguments</key><array><string>$work/mac-input</string>$args</array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$work/input.log</string>
  <key>StandardErrorPath</key><string>$work/input.log</string>
</dict></plist>
EOF
  launchctl bootstrap "gui/$uid" "$work/input.plist"
  i=0
  while [ $i -lt 120 ]; do
    sleep 0.5
    i=$((i + 1))
    state=$(launchctl print "gui/$uid/$label.e2e-input" 2>/dev/null || true)
    case $state in *"state = running"*) continue ;; esac
    case $state in *"last exit code = "[0-9]*) break ;; esac
  done
  launchctl bootout "gui/$uid/$label.e2e-input" 2>/dev/null || true
}
drive "$work/form.json"
cat "$work/input.log" || true
[ -f "$work/form.json.done" ] && echo "form submitted" || echo "::warning::e2e: the form never saw Submit"
sleep 2

step "task prompt"
# Opened through the control socket; the front window must be the prompt (the installed probe
# says what is in front), then the driver types the answer into it.
case ",$soft," in
*,input,*) echo "::warning::e2e: no Accessibility or event posting on this runner: task prompt skipped" ;;
*)
  "$cli" task >/dev/null || die "autotrack task failed"
  i=0
  while :; do
    fr=$(printf '{"id":1,"op":"front"}\n' | "$app/helpers/mac/probe" 2>/dev/null | head -1)
    case $fr in *'"title":"autotrack"'*) break ;; esac
    i=$((i + 1))
    [ $i -lt 30 ] || die "the task prompt is not in front after 15 s: $fr"
    sleep 0.5
  done
  echo "front: $fr"
  drive --type "e2e task"
  cat "$work/input.log" || true
  sleep 2
  ;;
esac

step "stop, ship"
"$cli" stop
i=0
while "$cli" status >/dev/null 2>&1; do
  i=$((i + 1))
  [ $i -lt 30 ] || die "recorder did not stop"
  sleep 1
done
osascript -e 'tell application "TextEdit" to quit saving no' 2>/dev/null || true
"$cli" ship || die "ship failed"
cat "$work/stub.log"

step "check"
node "$repo/test/e2e/check.mjs" --dir "$work/s3/$bucket/$device" --mac --soft "$soft"

step "uninstall --yes"
cp "$data"/*.log "$work/" 2>/dev/null || true
"$cli" uninstall --yes
[ ! -f "$HOME/Library/LaunchAgents/$label.plist" ] || die "plist still there"
! launchctl print "gui/$uid/$label" >/dev/null 2>&1 || die "LaunchAgent still loaded"
for b in "Google/Chrome" "Microsoft Edge"; do
  [ ! -f "$HOME/Library/Application Support/$b/NativeMessagingHosts/$label.json" ] || die "$b native host manifest still there"
done
[ ! -d "$app" ] || die "app still in $app"
[ ! -e "$data/extension/manifest.json" ] || die "unpacked extension still in $data/extension"
[ ! -e "$cli" ] || die "CLI shim still in $cli"
echo "uninstall left nothing registered"
