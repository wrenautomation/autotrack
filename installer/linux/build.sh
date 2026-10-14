#!/bin/sh
# Builds the Linux installer: one self-extracting .run file (autotrack-installer with install.sh
# and the Linux bundle appended as a tar.gz). Run after `node scripts/bundle.mjs` on Linux, or with
# the release bundle downloaded into bundles/:
#   sh installer/linux/build.sh [bundle dir] [out dir]
# Writes <out>/autotrack-<version>-linux-x64.run and prints its path. Unsigned; SHA256SUMS covers it.
set -eu

repo=$(cd "$(dirname "$0")/../.." && pwd)
bundles=${1:-"$repo/bundles"}
out=${2:-"$repo/installer/linux/out"}
version=$(node -p 'require(process.argv[1]).version' "$repo/package.json")
asset=autotrack-linux-x64.tar.gz
run="$out/autotrack-$version-linux-x64.run"

[ -f "$bundles/$asset" ] || { echo "no $asset in $bundles" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/bundles" "$out"
cp "$repo/install/install.sh" "$stage/install.sh"
cp "$bundles/$asset" "$stage/bundles/$asset"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$stage/bundles" && sha256sum "$asset") >"$stage/bundles/SHA256SUMS"
else
  (cd "$stage/bundles" && shasum -a 256 "$asset") >"$stage/bundles/SHA256SUMS"
fi

rm -f "$run"
{
  cat "$repo/installer/linux/autotrack-installer"
  printf '__AUTOTRACK_PAYLOAD__\n'
  tar -czf - -C "$stage" install.sh bundles
} >"$run"
chmod 755 "$run"
echo "Built $run ($(du -h "$run" | cut -f1))"
