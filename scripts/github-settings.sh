#!/usr/bin/env bash
# Two repository settings for the owner to run, because auto mode refuses outward GitHub
# writes (CLAUDE.md), from "Tax AMM: Pipeline's strategy template in our repo, with CI and a
# local demo run" (#58):
#
#   1. CI's `gate` job becomes a required check on `main`, through a repository ruleset.
#      Repository admins may bypass it, so a history rewrite can still be force-pushed;
#      sessions never bypass it to merge a pull request whose CI is red.
#   2. Private vulnerability reporting is switched on: it is the contact in every program's
#      security.txt and metadata (docs/spec/tax-amm.md, "Custom actions and metadata").
#
#   bash scripts/github-settings.sh
#
# Both need the repository to be public (on GitHub Free). Safe to run again.
set -euo pipefail
R=imDev2023/testing-pipeline
RULESET="CI gate on main"
GITHUB_ACTIONS_APP=15368   # only GitHub Actions may report the required check
ADMIN_ROLE=5               # the repository admin role, for the bypass

visibility="$(gh repo view "$R" --json visibility --jq .visibility)"
if [ "$visibility" != PUBLIC ]; then
  echo "$R is $visibility. Both settings need it public: make it public first, then run this again." >&2
  exit 1
fi

echo "== Private vulnerability reporting"
gh api --method PUT "repos/$R/private-vulnerability-reporting" --silent
gh api "repos/$R/private-vulnerability-reporting" --jq '"   enabled: \(.enabled)"'

echo "== Ruleset \"$RULESET\": the gate job required on main"
body="$(cat <<EOF
{
  "name": "$RULESET",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [{ "context": "gate", "integration_id": $GITHUB_ACTIONS_APP }]
      }
    }
  ],
  "bypass_actors": [{ "actor_id": $ADMIN_ROLE, "actor_type": "RepositoryRole", "bypass_mode": "always" }]
}
EOF
)"
id="$(gh api "repos/$R/rulesets" --jq ".[] | select(.name == \"$RULESET\") | .id")"
if [ -n "$id" ]; then
  gh api --method PUT "repos/$R/rulesets/$id" --input - --silent <<<"$body"
else
  gh api --method POST "repos/$R/rulesets" --input - --silent <<<"$body"
fi
gh api "repos/$R/rules/branches/main" \
  --jq '.[] | select(.type == "required_status_checks") | "   required on main: \([.parameters.required_status_checks[].context] | join(", "))"'
