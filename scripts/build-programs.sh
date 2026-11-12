#!/usr/bin/env bash
# Builds every program of the on-chain workspace (programs/Cargo.toml), one at a time by its
# own manifest, into programs/target/deploy. A whole-workspace build unifies dependency
# features across programs and changes their bytes (docs/spec/README.md, "Framework and
# toolchain"), so programs are never built that way.
#
#   scripts/build-programs.sh [program ...]     # default: every workspace member
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
  done < <(python3 -c 'import tomllib; print("\n".join(tomllib.load(open("Cargo.toml", "rb"))["workspace"]["members"]))')
fi

for program in "${programs[@]}"; do
  echo "== $program"
  cargo build-sbf --manifest-path "$program/Cargo.toml"
done
