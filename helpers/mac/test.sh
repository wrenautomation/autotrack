#!/bin/sh
# Builds the Mac probe, then runs test.mjs (each op's JSON shape, `at` latency over 50 requests, no
# name that shows a typed value) and
# test-shots.mjs (`--shots`: displays, grab, save, crop, usage, ring, grab/save timing; needs Screen
# Recording) and test-ocr.mjs (`--ocr`: known text from test/fixtures/ocr-text.jpg).
set -eu
cd "$(dirname "$0")"
./build.sh
node test.mjs
node test-ocr.mjs
exec node test-shots.mjs
