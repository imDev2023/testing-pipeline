#!/usr/bin/env bash
# Builds every program of the on-chain workspace (programs/Cargo.toml's members that build a
# cdylib; library crates are built as their dependencies), one at a time by its
# own manifest, into programs/target/deploy. A whole-workspace build unifies dependency
# features across programs and changes their bytes (docs/spec/README.md, "Framework and
# toolchain"), so programs are never built that way.
#
# Test programs (scripts/workspace-programs.py --test-programs, such as the stand-in
# launchpad) are built the same way but into the gitignored fixtures/test-programs, like
# Pipeline's test programs, so nothing that deploys from programs/target/deploy finds them.
# TEST_PROGRAMS_DIR moves them (default $FIXTURES_DIR/test-programs); the tests and
# local-validator.sh read the same variable.
#
#   scripts/build-programs.sh [program ...]     # default: every program, test programs too
#
# Needs the toolchain (source scripts/toolchain-env.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_PROGRAMS_DIR="${TEST_PROGRAMS_DIR:-${FIXTURES_DIR:-$ROOT/fixtures}/test-programs}"
cd "$ROOT/programs"

# A program's folder, resolved, so any spelling of a test program's path is recognised.
resolved() { (cd "$1" && pwd -P); }
test_programs=()
while IFS= read -r member; do
  test_programs+=("$(resolved "$member")")
done < <(python3 "$ROOT/scripts/workspace-programs.py" --test-programs)
is_test_program() {
  local member dir
  dir="$(resolved "$1")"
  for member in ${test_programs[@]+"${test_programs[@]}"}; do
    [ "$member" = "$dir" ] && return 0
  done
  return 1
}

if [ "$#" -gt 0 ]; then
  programs=("$@")
else
  programs=()
  while IFS= read -r member; do
    programs+=("$member")
  done < <(python3 "$ROOT/scripts/workspace-programs.py")
  while IFS= read -r member; do
    programs+=("$member")
  done < <(python3 "$ROOT/scripts/workspace-programs.py" --test-programs)
fi

for program in "${programs[@]}"; do
  echo "== $program"
  if is_test_program "$program"; then
    mkdir -p "$TEST_PROGRAMS_DIR"
    cargo build-sbf --manifest-path "$program/Cargo.toml" --sbf-out-dir "$TEST_PROGRAMS_DIR"
  else
    cargo build-sbf --manifest-path "$program/Cargo.toml"
  fi
done
