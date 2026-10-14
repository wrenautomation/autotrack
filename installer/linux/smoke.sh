#!/bin/sh
# Runs the .run installer with no UI: bad codes refused, install, doctor, version, upgrade with
# the code in a file, uninstall through --uninstall. CI only. A shape-valid code with a fake key;
# nothing ships, nothing starts at login.
#   sh installer/linux/smoke.sh <run file> <version>
set -eu

run=$1
version=$2
data="${XDG_DATA_HOME:-$HOME/.local/share}/autotrack"
app="$data/app"
config="${XDG_CONFIG_HOME:-$HOME/.config}"
step() { printf '\n== %s\n' "$*"; }
die() {
  echo "::error::installer smoke: $*"
  exit 1
}

[ -f "$run" ] || die "no $run"
head -n "$(grep -n '^__AUTOTRACK_PAYLOAD__$' "$run" | cut -d: -f1)" "$run" | sed '$d' | sh -n || die "the header does not parse"

json='{"v":1,"bucket":"autotrack-smoke","region":"us-east-1","device":"smoke","keyId":"AKIASMOKETESTKEY0001","secret":"smoke-secret-not-a-real-key"}'
code=$(printf '%s' "$json" | base64 | tr -d '\n=' | tr '+/' '-_')
export AUTOTRACK_NO_AUTOSTART=1 AUTOTRACK_NO_BROWSER=1
unset AUTOTRACK AUTOTRACK_CODE_FILE || true

step "bad code: refused"
if AUTOTRACK="not!a!code" sh "$run"; then die "a bad code was accepted"; fi
if AUTOTRACK="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" sh "$run"; then die "an undecodable code was accepted"; fi
[ ! -e "$app" ] || die "bad code: something was installed"
if sh "$run" </dev/null; then die "no code and no way to ask, yet it succeeded"; fi

step "install with the code in the environment"
AUTOTRACK="$code" sh "$run"
cli="$HOME/.local/bin/autotrack"
[ -x "$cli" ] || die "no $cli"
[ -f "$app/VERSION" ] || die "no $app/VERSION"
grep -q "^$version+" "$app/VERSION" || die "installed $(cat "$app/VERSION"), expected $version+<sha>"
[ -x "$app/helpers/linux/autotrack-helper" ] || die "no Linux helper in the bundle"
[ -f "$data/extension/manifest.json" ] || die "no unpacked extension"
for b in google-chrome chromium microsoft-edge BraveSoftware/Brave-Browser; do
  [ -f "$config/$b/NativeMessagingHosts/com.wrenautomation.autotrack.json" ] || die "no $b native host manifest"
done
[ "$(stat -c %a "$data/config.json")" = 600 ] || die "config.json is $(stat -c %a "$data/config.json"), want 600"
"$cli" doctor || true
echo "installed $(cat "$app/VERSION")"

step "upgrade with the code in a file"
codefile=$(mktemp)
printf '%s\n' "$code" >"$codefile"
AUTOTRACK_CODE_FILE="$codefile" sh "$run"
rm -f "$codefile"
grep -q "^$version+" "$app/VERSION" || die "upgrade left $(cat "$app/VERSION")"

step "uninstall"
sh "$run" --uninstall --yes
[ ! -e "$app" ] || die "uninstall left $app"
[ ! -e "$cli" ] || die "uninstall left $cli"
for b in google-chrome chromium microsoft-edge BraveSoftware/Brave-Browser; do
  [ ! -f "$config/$b/NativeMessagingHosts/com.wrenautomation.autotrack.json" ] || die "$b native host manifest still there"
done
if sh "$run" --uninstall; then die "a second uninstall claimed success"; fi
echo "installer smoke ok"
