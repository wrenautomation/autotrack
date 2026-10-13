#!/bin/sh
# Builds the Mac probe, then runs test.mjs (each op's JSON shape, `at` latency over 50 requests) and
# test-shots.mjs (`--shots`: displays, grab, save, ring, grab/save timing; needs Screen Recording).
set -eu
cd "$(dirname "$0")"
./build.sh
node test.mjs
exec node test-shots.mjs
