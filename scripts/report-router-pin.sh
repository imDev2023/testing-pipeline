#!/usr/bin/env bash
# Opens the issue that says devnet's Pipeline router no longer matches the pin, or comments on
# it when one is already open, so a router upgrade shows up in the tracker once and every
# later failed day adds to the same issue. Run by the daily router pin check
# (.github/workflows/router-pin.yml, BAR-43) after scripts/fetch-router.sh exits 3.
#
#   scripts/report-router-pin.sh <fetch log> <run url>
#
# Needs `gh` signed in with permission to write issues, and GITHUB_REPOSITORY (owner/name).
set -euo pipefail
LOG="${1:?usage: report-router-pin.sh <fetch log> <run url>}"
RUN_URL="${2:?usage: report-router-pin.sh <fetch log> <run url>}"
: "${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY to owner/name}"

TITLE="Devnet's Pipeline router no longer matches the pin"

body="$(cat <<EOF
The daily router pin check failed on $(date -u +%Y-%m-%d): the router dumped from devnet is not the one \`fixtures/pins.env\` pins ([the run]($RUN_URL)).

Every on-chain CI job fails until a PR re-pins it, as \`docs/toolchain.md\` ("Fixtures") and BAR-32 say: run the tests against the new bytes, adapt what the upgrade changes, then move \`ROUTER_SHA256\` and Pipeline's rev together.

\`\`\`
$(cat "$LOG")
\`\`\`

Opened by \`.github/workflows/router-pin.yml\` (BAR-43).
EOF
)"

existing="$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --search "\"$TITLE\" in:title" \
  --json number,title --jq "map(select(.title == \"$TITLE\")) | .[0].number // empty")"
if [ -n "$existing" ]; then
  gh issue comment "$existing" --repo "$GITHUB_REPOSITORY" --body "$body"
  echo "Commented on issue #$existing."
else
  gh issue create --repo "$GITHUB_REPOSITORY" --title "$TITLE" --body "$body"
fi
