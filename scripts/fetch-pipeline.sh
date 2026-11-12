#!/usr/bin/env bash
# Clones Pipeline at the commit programs/Cargo.toml pins into fixtures/pipeline/ (gitignored)
# and builds what this repo uses from it, without copying any of it in:
#
#   sdk        the TypeScript SDK, which is not on npm; the demo scripts link to its build
#   programs   Pipeline's test programs (test-hook, test-hook-refill, test-strategy-cp,
#              test-strategy-evil), for hostile tests; never the router, whose source is
#              BSL 1.1 (the tests load devnet's router from scripts/fetch-router.sh)
#
#   scripts/fetch-pipeline.sh [sdk] [programs]     # default: both
#
# Needs git, Node 24 with npm, and for `programs` the toolchain (source scripts/toolchain-env.sh).
# Safe to run again: it moves the clone to the pinned commit and rebuilds.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES_DIR="${FIXTURES_DIR:-$ROOT/fixtures}"
DEST="$FIXTURES_DIR/pipeline"
REPO=https://github.com/MetalLegBob/pipeline.git
TEST_PROGRAMS=(test-hook test-hook-refill test-strategy-cp test-strategy-evil)

PARTS="${*:-sdk programs}"
for part in $PARTS; do
  case "$part" in
    sdk | programs) ;;
    *) echo "unknown part: $part (expected sdk or programs)" >&2; exit 2 ;;
  esac
done
want() { [[ " $PARTS " == *" $1 "* ]]; }

# The one pin: the rev every Pipeline crate in programs/Cargo.toml uses.
REV="$(python3 - "$ROOT/programs/Cargo.toml" <<'PY'
import sys, tomllib
deps = tomllib.load(open(sys.argv[1], "rb"))["workspace"]["dependencies"]
revs = {spec["rev"] for spec in deps.values()
        if isinstance(spec, dict) and spec.get("git", "").rstrip("/").removesuffix(".git").endswith("MetalLegBob/pipeline")}
if len(revs) != 1:
    sys.exit(f"programs/Cargo.toml must pin every Pipeline crate to one rev, found {sorted(revs) or 'none'}")
print(revs.pop())
PY
)"

if [ ! -d "$DEST/.git" ]; then
  echo "== Cloning Pipeline into $DEST"
  mkdir -p "$FIXTURES_DIR"
  git clone --quiet "$REPO" "$DEST"
fi
if ! git -C "$DEST" cat-file -e "$REV^{commit}" 2>/dev/null; then
  git -C "$DEST" fetch --quiet origin
fi
git -C "$DEST" -c advice.detachedHead=false checkout --quiet --force --detach "$REV"
COMMIT="$(git -C "$DEST" rev-parse HEAD)"
echo "== Pipeline at $COMMIT (pinned rev $REV)"

if want sdk; then
  echo "== TypeScript SDK"
  (cd "$DEST/sdk/ts" && npm ci --no-audit --no-fund --loglevel=error && npm run --silent build)
  echo "   built $DEST/sdk/ts/dist"
fi

if want programs; then
  for program in "${TEST_PROGRAMS[@]}"; do
    echo "== $program"
    cargo build-sbf --manifest-path "$DEST/programs/$program/Cargo.toml"
  done
  echo "   built into $DEST/programs/target/deploy"
fi
