#!/usr/bin/env bash
# Moves imDev2023/testing-pipeline to a new repository of the same name, keeping every issue number,
# and renames the old one to imDev2023/testing-pipeline-archive, private for good (#167).
# scripts/move-repo/README.md says what it does, step by step. The owner runs it, because auto mode
# refuses repository creation and renaming.
#
#   bash scripts/move-repo.sh --dry-run   builds and checks everything, prints every change, changes nothing
#   bash scripts/move-repo.sh             the move; safe to re-run, stops at the first failed check
#   bash scripts/move-repo.sh check       proves the issue numbers and scans the new repository
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/move-repo/move.mjs "$@"
