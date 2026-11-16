#!/usr/bin/env bash
# Builds the fixture programs Canary's tests load, into each one's target/deploy (gitignored).
# Needs the toolchain on PATH: source scripts/toolchain-env.sh (docs/toolchain.md).
#
#   crates/canary/tests/fixtures/build.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
for program in strategy; do
  echo "== canary fixture: $program"
  cargo build-sbf --manifest-path "$HERE/$program/Cargo.toml"
done
