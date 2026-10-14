#!/bin/sh
# Builds the Mac installer: a disk image with "autotrack Installer.app" (launcher, install.sh and
# the Mac bundles inside it). Run on a Mac, after `node scripts/bundle.mjs` (one arch) or with both
# bundles downloaded into bundles/ (release):
#   sh installer/mac/build.sh [bundle dir] [out dir]
# Writes <out>/autotrack-<version>.dmg and prints its path. Unsigned.
set -eu

repo=$(cd "$(dirname "$0")/../.." && pwd)
bundles=${1:-"$repo/bundles"}
out=${2:-"$repo/installer/mac/out"}
version=$(node -p 'require(process.argv[1]).version' "$repo/package.json")
dmg="$out/autotrack-$version.dmg"

found=""
for a in arm64 x64; do
  [ -f "$bundles/autotrack-darwin-$a.tar.gz" ] && found="$found $a"
done
[ -n "$found" ] || { echo "no autotrack-darwin-*.tar.gz in $bundles" >&2; exit 1; }
echo "bundles:$found"

stage="$out/stage"
app="$stage/autotrack Installer.app"
rm -rf "$stage" "$dmg"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/bundles"

cp "$repo/installer/mac/autotrack-installer" "$app/Contents/MacOS/autotrack-installer"
chmod 755 "$app/Contents/MacOS/autotrack-installer"
cp "$repo/install/install.sh" "$app/Contents/Resources/install.sh"
for a in $found; do
  cp "$bundles/autotrack-darwin-$a.tar.gz" "$app/Contents/Resources/bundles/"
  (cd "$app/Contents/Resources/bundles" && shasum -a 256 "autotrack-darwin-$a.tar.gz") >>"$app/Contents/Resources/bundles/SHA256SUMS"
done

cat >"$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>autotrack-installer</string>
  <key>CFBundleIdentifier</key><string>com.wrenautomation.autotrack.installer</string>
  <key>CFBundleName</key><string>autotrack Installer</string>
  <key>CFBundleDisplayName</key><string>autotrack Installer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
plutil -lint "$app/Contents/Info.plist"

cat >"$stage/Read me first.txt" <<TXT
autotrack $version

1. Open "autotrack Installer". Paste your install code when it asks.
2. In System Settings, turn on "node" in Accessibility, Input Monitoring and Screen Recording.

This installer is not signed yet, so macOS blocks it the first time.
  macOS 14 or older: right-click "autotrack Installer", choose Open, then Open.
  macOS 15 or newer: open it once, then System Settings > Privacy & Security >
  scroll down > "Open Anyway" next to autotrack Installer.

It installs for you only (no administrator password). To remove it: run "autotrack uninstall" in Terminal.
TXT

mkdir -p "$out"
hdiutil create -quiet -volname autotrack -srcfolder "$stage" -ov -format UDZO "$dmg"
rm -rf "$stage"
echo "Built $dmg ($(du -h "$dmg" | cut -f1))"
