#!/bin/sh
# Linux end to end (CI only: it posts real input). Run inside test/e2e/linux-x.sh. Installs the
# built bundle with a fake install code pointing at the local S3 stub, drives a GTK text editor
# window and a password form with xdotool, answers the task prompt, waits idle for OCR, measures
# the active cost with `doctor` (fails past 6% CPU over the 10 s burst or 200 MB RSS), stops,
# ships, checks what the stub received, then uninstalls and checks nothing is left registered.
#
#   dbus-run-session -- sh test/e2e/linux-x.sh sh test/e2e/linux.sh   (after `node scripts/bundle.mjs`)
set -eu

repo=$(cd "$(dirname "$0")/../.." && pwd)
work="${RUNNER_TEMP:-/tmp}/autotrack-e2e"
rm -rf "$work"
mkdir -p "$work"
data="${XDG_DATA_HOME:-$HOME/.local/share}/autotrack"
config="${XDG_CONFIG_HOME:-$HOME/.config}"
app="$data/app"
cli="$HOME/.local/bin/autotrack"
host=com.wrenautomation.autotrack
device=e2e-linux
bucket=autotrack-e2e
key_id=AKIAE2ETESTKEY000001
secret=e2e-secret-not-real-0123456789
browsers="google-chrome chromium microsoft-edge BraveSoftware/Brave-Browser"

step() { printf '\n== %s\n' "$*"; }
die() {
  echo "::error::e2e: $*"
  exit 1
}

bundle="$repo/bundles/autotrack-linux-x64.tar.gz"
[ -f "$bundle" ] || die "no linux bundle at $bundle"
[ -n "${DISPLAY:-}" ] || die "no DISPLAY: run inside test/e2e/linux-x.sh"

step "S3 stub"
node "$repo/test/e2e/s3-stub.mjs" --root "$work/s3" --key-id "$key_id" --secret "$secret" \
  --prefix "$device/" --port-file "$work/port" >"$work/stub.log" 2>&1 &
stub=$!
note="" form=""
cleanup() {
  kill "$stub" 2>/dev/null || true
  [ -n "$note" ] && kill "$note" 2>/dev/null || true
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

step "install.sh"
{
  AUTOTRACK="$code" AUTOTRACK_BUNDLE="$bundle" AUTOTRACK_ENDPOINT="http://127.0.0.1:$port" \
    AUTOTRACK_NO_BROWSER=1 sh "$repo/install/install.sh" 2>&1 && rc=0 || rc=$?
  echo "$rc" >"$work/install.rc"
} | tee "$work/install.log"
[ "$(cat "$work/install.rc")" = 0 ] || die "install.sh exited $(cat "$work/install.rc")"
if [ -f "$config/systemd/user/autotrack.service" ]; then
  echo "autostart: systemd user unit"
elif [ -f "$config/autostart/autotrack.desktop" ]; then
  echo "autostart: XDG autostart entry (no systemd graphical session on this runner)"
  cat "$config/autostart/autotrack.desktop"
else
  die "no systemd unit and no autostart entry"
fi
for b in $browsers; do
  [ -f "$config/$b/NativeMessagingHosts/$host.json" ] || die "no $b native host manifest"
done
[ -f "$data/extension/manifest.json" ] || die "no unpacked extension in $data/extension"
grep -q '"key"' "$data/extension/manifest.json" || die "unpacked manifest.json has no key (the extension id would change)"
[ "$(stat -c %a "$data/config.json")" = 600 ] || die "config.json is $(stat -c %a "$data/config.json"), want 600"
grep -q "AT-SPI accessibility bus answers" "$work/install.log" || die "doctor: AT-SPI not answering"
grep -q "RECORD extension present" "$work/install.log" || die "doctor: no RECORD"
grep -q "tesseract found" "$work/install.log" || die "doctor: tesseract not found"

i=0
until "$cli" status >/dev/null 2>&1; do
  i=$((i + 1))
  [ $i -lt 30 ] || die "recorder not running: $(tail -30 "$data/track.log" "$data/autostart.log" 2>/dev/null)"
  sleep 1
done
"$cli" status

step "Drive input"
# doctor measures the running recorder over 10 s while the input below is driven: the active cost.
"$cli" doctor >"$work/doctor-active.log" 2>&1 &
doctor=$!
python3 "$repo/test/e2e/linux-form.py" note "$work/note.json" >"$work/note.log" 2>&1 &
note=$!
i=0
while [ ! -s "$work/note.json" ]; do
  i=$((i + 1))
  [ $i -lt 100 ] || die "the note window did not come up: $(cat "$work/note.log")"
  sleep 0.1
done
xy() { node -e 'const j=require(process.argv[1]); const p=j[process.argv[2]]; console.log(p.x+" "+p.y)' "$1" "$2"; }
set -- $(xy "$work/note.json" text)
xdotool mousemove --sync "$1" "$2"
sleep 0.15
xdotool click 1
sleep 0.8
xdotool type --delay 60 hello
xdotool key Return
sleep 1.5
# A copy while the text area has focus: the recorder writes it as a clipboard event.
printf 'autotrack e2e clip 42' | xclip -selection clipboard
sleep 1

python3 "$repo/test/e2e/linux-form.py" form "$work/form.json" >"$work/form.log" 2>&1 &
form=$!
i=0
while [ ! -s "$work/form.json" ]; do
  i=$((i + 1))
  [ $i -lt 100 ] || die "the form did not come up: $(cat "$work/form.log")"
  sleep 0.1
done
sleep 0.5
set -- $(xy "$work/form.json" password)
xdotool mousemove --sync "$1" "$2"
sleep 0.15
xdotool click 1
sleep 0.8
xdotool type --delay 60 hunter2pw
sleep 1.5
set -- $(xy "$work/form.json" submit)
xdotool mousemove --sync "$1" "$2"
sleep 0.15
xdotool click 1
sleep 1.5
[ -f "$work/form.json.done" ] && echo "form submitted" || echo "::warning::e2e: the form never saw Submit"
sleep 2

step "task prompt"
# Opened through the control socket; the front window must be the prompt (the installed helper
# says what is in front), then the answer is typed into it.
"$cli" task >/dev/null || die "autotrack task failed"
i=0
while :; do
  fr=$(printf '{"id":1,"op":"front"}\n' | "$app/helpers/linux/autotrack-helper" --probe 2>/dev/null | head -1)
  case $fr in *'"title":"autotrack"'*) break ;; esac
  i=$((i + 1))
  [ $i -lt 30 ] || die "the task prompt is not in front after 15 s: $fr"
  sleep 0.5
done
echo "front: $fr"
sleep 0.3
xdotool type --delay 60 "e2e task"
xdotool key Return
sleep 2

step "idle: OCR, doctor"
# OCR runs only after 20 s without input, one image at a time; poll for a read that found text.
i=0
until find "$data/sessions" -path '*/ocr/*.json' -exec grep -lE '"text":"[^"]*([Hh]ello|Submit|Password|note\.txt)' {} + 2>/dev/null | grep -q .; do
  i=$((i + 1))
  [ $i -lt 60 ] || die "no OCR with the known text after 180 s"
  sleep 3
done
echo "ocr files: $(find "$data/sessions" -path '*/ocr/*' -name '*.json' | wc -l)"
wait "$doctor" 2>/dev/null || true
echo "-- doctor while input was driven:"
cat "$work/doctor-active.log" || true
# The active budget: CI fails past 6% over the 10 s burst (driven input is denser than real use;
# the target is 3% on average) or past 200 MB.
cpu=$(sed -n 's/.*CPU \([0-9.]*\)% of one core.*/\1/p' "$work/doctor-active.log" | head -1)
rss=$(sed -n 's/.*RSS \([0-9]*\) MB peak.*/\1/p' "$work/doctor-active.log" | head -1)
inputs=$(sed -n 's/.*active, \([0-9]*\) inputs.*/\1/p' "$work/doctor-active.log" | head -1)
echo "::notice::e2e linux active input: CPU ${cpu:-?}% over 10 s, RSS ${rss:-?} MB peak, ${inputs:-0} inputs (CI limits 6%, 200 MB)"
[ -n "$cpu" ] && [ -n "$rss" ] || die "doctor did not report CPU and RSS while input was driven"
[ "${inputs:-0}" -gt 0 ] || echo "::warning::e2e: doctor saw no input in its window"
over=""
awk -v c="$cpu" 'BEGIN { exit !(c > 6) }' && over="$over 10 s burst CPU $cpu% is over 6%;"
[ "$rss" -le 200 ] || over="$over active RSS $rss MB is over 200 MB;"
echo "-- doctor idle:"
"$cli" doctor >"$work/doctor-idle.log" 2>&1 || true
cat "$work/doctor-idle.log"
idle_cpu=$(sed -n 's/.*CPU \([0-9.]*\)% of one core.*/\1/p' "$work/doctor-idle.log" | head -1)
echo "::notice::e2e linux idle: CPU ${idle_cpu:-?}% over 10 s"
[ -z "$over" ] || die "over budget:$over"

step "stop, ship"
"$cli" stop
i=0
while "$cli" status >/dev/null 2>&1; do
  i=$((i + 1))
  [ $i -lt 30 ] || die "recorder did not stop"
  sleep 1
done
"$cli" ship || die "ship failed"
cat "$work/stub.log"

step "check"
# Linux points are X pixels: a 256-point crop is 256 px.
node "$repo/test/e2e/check.mjs" --dir "$work/s3/$bucket/$device" --crop-px 256

step "uninstall --yes"
cp "$data"/*.log "$work/" 2>/dev/null || true
"$cli" uninstall --yes
[ ! -f "$config/systemd/user/autotrack.service" ] || die "systemd unit still there"
[ ! -f "$config/autostart/autotrack.desktop" ] || die "autostart entry still there"
for b in $browsers; do
  [ ! -f "$config/$b/NativeMessagingHosts/$host.json" ] || die "$b native host manifest still there"
done
[ ! -d "$app" ] || die "app still in $app"
[ ! -e "$data/extension/manifest.json" ] || die "unpacked extension still in $data/extension"
[ ! -e "$cli" ] || die "CLI shim still in $cli"
! pgrep -f "$app/dist/cli.js" >/dev/null || die "a recorder is still running"
echo "uninstall left nothing registered"
