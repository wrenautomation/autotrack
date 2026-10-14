#!/bin/sh
# Builds helpers/linux/autotrack-helper: one static x86_64 musl binary. Needs rustup with the
# x86_64-unknown-linux-musl target (`rustup target add x86_64-unknown-linux-musl`). On a non-Linux
# host it type-checks only (no musl linker there).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
target=x86_64-unknown-linux-musl
cd "$here"
if [ "$(uname -s)" != Linux ]; then
  cargo check --release --target "$target"
  echo "not Linux: checked, not linked" >&2
  exit 0
fi
cargo build --release --locked --target "$target"
cp "target/$target/release/autotrack-helper" "$here/autotrack-helper"
chmod 755 "$here/autotrack-helper"
"$here/autotrack-helper" --version
