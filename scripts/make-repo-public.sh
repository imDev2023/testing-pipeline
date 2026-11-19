#!/usr/bin/env bash
# Makes imDev2023/testing-pipeline public (the owner's decision, 2026-11-09), once the move to a new
# repository (#167, scripts/move-repo/README.md) is done and the owner has said yes. Run by the
# owner, because auto mode refuses outward GitHub writes. Safe to run again.
#
#   bash scripts/make-repo-public.sh
#
# The archive, imDev2023/testing-pipeline-archive, stays private for good; nothing here touches it.
set -euo pipefail
cd "$(dirname "$0")/.."
R=imDev2023/testing-pipeline

echo "== 1. The proof: every issue number matches the archive and nothing purged is on GitHub"
node scripts/move-repo/move.mjs check

# CI goes back to GitHub's runners, which cost nothing on a public repository. The iMac's runners
# keep their home volumes between jobs, so a pull request from a fork must never reach them: they
# are stopped and unregistered, not only unused (docs/toolchain.md, "CI on the owner's iMac").
echo "== 2. CI back on GitHub's runners; the iMac's runners stopped and unregistered"
gh variable delete CI_RUNS_ON --repo "$R" 2>/dev/null || true
docker compose -f scripts/ci-runner/compose.yml down || echo "  (Docker is not running; the runners are stopped already)"
for id in $(gh api "repos/$R/actions/runners" --jq '.runners[].id'); do
  gh api -X DELETE "repos/$R/actions/runners/$id"
done
echo "  runners left: $(gh api "repos/$R/actions/runners" --jq '.total_count')"

echo "== 3. Public"
gh repo edit "$R" --visibility public --accept-visibility-change-consequences
gh repo view "$R" --json visibility --jq '"  \(.visibility)"'

echo "== 4. A pull request from anyone outside runs CI only after approval"
gh api -X PUT "repos/$R/actions/permissions/fork-pr-contributor-approval" -f approval_policy=all_external_contributors --silent
gh api "repos/$R/actions/permissions/fork-pr-contributor-approval" --jq '"  \(.approval_policy)"'

echo "== 5. The settings that need a public repository"
bash scripts/github-settings.sh
