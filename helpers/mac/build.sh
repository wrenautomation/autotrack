#!/bin/sh
# Builds the Mac probe as a universal (arm64 + x86_64) binary at track/helpers/mac/probe.
set -eu
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12.3" -o "$tmp/probe-$arch" probe.swift
done
lipo -create "$tmp/probe-arm64" "$tmp/probe-x86_64" -output probe
echo "built $(pwd)/probe ($(lipo -archs probe))"
