#!/usr/bin/env bash
# Makes imDev2023/testing-pipeline public (the owner's decision, 2026-11-09).
# Run by the owner, because auto mode refuses outward GitHub writes.
set -euo pipefail

gh repo edit imDev2023/testing-pipeline --visibility public --accept-visibility-change-consequences
gh repo view imDev2023/testing-pipeline --json visibility --jq .visibility
