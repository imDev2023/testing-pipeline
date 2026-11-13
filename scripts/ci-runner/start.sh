#!/usr/bin/env bash
# Builds CI's runner image, registers each runner the first time and starts them all
# (docs/toolchain.md, "CI on the owner's iMac"). Safe to run again. Needs Docker Desktop
# running and `gh` signed in as an admin of the repo; the registration token is used once and
# never written down.
#
#   scripts/ci-runner/start.sh
set -euo pipefail
cd "$(dirname "$0")"
REPO=imDev2023/testing-pipeline

docker compose build
for service in $(docker compose config --services); do
  if docker compose run --rm --no-deps "$service" registered; then
    echo "$service: registered"
    continue
  fi
  echo "$service: registering as imac-$service"
  RUNNER_TOKEN="$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)" \
    RUNNER_NAME="imac-$service" \
    docker compose run --rm --no-deps -e RUNNER_TOKEN -e RUNNER_NAME "$service" configure
done
docker compose up -d
docker compose ps
