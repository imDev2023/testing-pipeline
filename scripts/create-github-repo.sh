#!/usr/bin/env bash
# Creates imDev2023/testing-pipeline (private), pushes main, and adds the labels wayfinder and the relay use.
set -euo pipefail
cd "/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/testing-pipeline"

gh repo create imDev2023/testing-pipeline --private \
  --description "Products on MetalLegBob's Pipeline router for Solana: a terminal with safety checks, a containment hook, a tax AMM, Pool4 for Solana and a lending pool" \
  --source . --remote origin --push

R=imDev2023/testing-pipeline
gh label create "wayfinder:map"       --repo $R --color 5319e7 --description "The wayfinder map: one issue indexing the decisions of an effort"
gh label create "wayfinder:research"  --repo $R --color 0e8a16 --description "Wayfinder ticket resolved by a research agent (AFK)"
gh label create "wayfinder:grilling"  --repo $R --color d93f0b --description "Wayfinder ticket resolved by conversation with the owner (HITL)"
gh label create "wayfinder:prototype" --repo $R --color 1d76db --description "Wayfinder ticket resolved by a rough artifact to react to (HITL)"
gh label create "wayfinder:task"      --repo $R --color fbca04 --description "Wayfinder ticket for manual work that unblocks a decision"
gh label create "build"               --repo $R --color 2ea043 --description "Build ticket from the spec, run one per session"
gh label create "relay:running"       --repo $R --color 1D76DB --description "A relay session is working on this"
gh label create "relay:blocked"       --repo $R --color B60205 --description "The relay stopped on this; see the latest comment"

echo "done: https://github.com/$R"
