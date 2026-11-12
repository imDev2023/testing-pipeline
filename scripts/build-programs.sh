#!/usr/bin/env bash
# Builds every program of the on-chain workspace (programs/Cargo.toml's members that build a
# cdylib; library crates are built as their dependencies), one at a time by its
# own manifest, into programs/target/deploy. A whole-workspace build unifies dependency
# features across programs and changes their bytes (docs/spec/README.md, "Framework and
# toolchain"), so programs are never built that way.
#
#   scripts/build-programs.sh [program ...]     # default: every program of the workspace
#
# Needs the toolchain (source scripts/toolchain-env.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/programs"

if [ "$#" -gt 0 ]; then
  programs=("$@")
else
  programs=()
  while IFS= read -r member; do
    programs+=("$member")
  done < <(python3 "$ROOT/scripts/workspace-programs.py")
fi

for program in "${programs[@]}"; do
  echo "== $program"
  cargo build-sbf --manifest-path "$program/Cargo.toml"
done
