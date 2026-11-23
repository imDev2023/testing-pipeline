#!/usr/bin/env bash
# Builds the fixture programs Canary's tests load: Canary's own, into each one's target/deploy
# (gitignored), and our containment hook from programs/, into programs/target/deploy, as
# scripts/build-programs.sh builds it for deployment.
# Needs the toolchain on PATH: source scripts/toolchain-env.sh (docs/toolchain.md).
#
#   crates/canary/tests/fixtures/build.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
for program in strategy; do
  echo "== canary fixture: $program"
  cargo build-sbf --manifest-path "$HERE/$program/Cargo.toml"
done
echo "== canary fixture: the containment hook"
"$ROOT/scripts/build-programs.sh" containment-hook
