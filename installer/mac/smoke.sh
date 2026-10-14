#!/bin/sh
# Mounts the disk image and installs from its app with no UI, then doctor, version, upgrade,
# uninstall. CI only. A shape-valid code with a fake key; nothing ships, nothing starts at login.
#   sh installer/mac/smoke.sh <dmg> <version>
set -eu

dmg=$1
version=$2
data="$HOME/Library/Application Support/autotrack"
app="$data/app"
step() { printf '\n== %s\n' "$*"; }
die() {
  echo "::error::installer smoke: $*"
  exit 1
}

mnt=$(mktemp -d)
hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null
trap 'hdiutil detach "$mnt" -force >/dev/null 2>&1 || true' EXIT
bundle="$mnt/autotrack Installer.app"
exe="$bundle/Contents/MacOS/autotrack-installer"
[ -x "$exe" ] || die "no launcher in $dmg"
plutil -lint "$bundle/Contents/Info.plist" >/dev/null
[ -f "$mnt/Read me first.txt" ] || die "no read-me on the disk image"

json='{"v":1,"bucket":"autotrack-smoke","region":"us-east-1","device":"smoke","keyId":"AKIASMOKETESTKEY0001","secret":"smoke-secret-not-a-real-key"}'
code=$(printf '%s' "$json" | base64 | tr -d '\n=' | tr '+/' '-_')
export AUTOTRACK_NO_AUTOSTART=1 AUTOTRACK_NO_BROWSER=1
unset AUTOTRACK AUTOTRACK_CODE_FILE || true

step "bad code: refused"
if AUTOTRACK="not!a!code" "$exe"; then die "a bad code was accepted"; fi
if AUTOTRACK="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" "$exe"; then die "an undecodable code was accepted"; fi
[ ! -e "$app" ] || die "bad code: something was installed"

step "install with the code in the environment"
AUTOTRACK="$code" "$exe"
cli="$HOME/.local/bin/autotrack"
[ -x "$cli" ] || die "no $cli"
[ -f "$app/VERSION" ] || die "no $app/VERSION"
grep -q "^$version+" "$app/VERSION" || die "installed $(cat "$app/VERSION"), expected $version+<sha>"
[ -f "$data/extension/manifest.json" ] || die "no unpacked extension"
[ -f "$HOME/Library/LaunchAgents/com.wrenautomation.autotrack.plist" ] || die "no LaunchAgent plist"
"$cli" doctor || true
echo "installed $(cat "$app/VERSION")"

step "upgrade with the code in a file"
codefile=$(mktemp)
printf '%s\n' "$code" >"$codefile"
AUTOTRACK_CODE_FILE="$codefile" "$exe"
rm -f "$codefile"
grep -q "^$version+" "$app/VERSION" || die "upgrade left $(cat "$app/VERSION")"

step "uninstall"
"$cli" uninstall --yes
[ ! -e "$app" ] || die "uninstall left $app"
[ ! -f "$HOME/Library/LaunchAgents/com.wrenautomation.autotrack.plist" ] || die "plist still there"
echo "installer smoke ok"
