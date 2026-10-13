#!/bin/sh
# Builds the Mac probe, then runs test.mjs: each op's JSON shape and `at` latency over 50 requests.
set -eu
cd "$(dirname "$0")"
./build.sh
exec node test.mjs
