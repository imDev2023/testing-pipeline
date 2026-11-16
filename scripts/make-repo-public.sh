#!/usr/bin/env bash
# Makes imDev2023/testing-pipeline public (the owner's decision, 2026-11-09).
# Run by the owner, because auto mode refuses outward GitHub writes.
set -euo pipefail

# CI goes back to GitHub's runners first, which cost nothing on a public repository: the iMac's
# runners keep their home volumes between jobs, so they must never run pull requests from forks
# (docs/toolchain.md, "CI on the owner's iMac").
gh variable delete CI_RUNS_ON --repo imDev2023/testing-pipeline 2>/dev/null || true
gh repo edit imDev2023/testing-pipeline --visibility public --accept-visibility-change-consequences
gh repo view imDev2023/testing-pipeline --json visibility --jq .visibility
