#!/usr/bin/env bash
# Builds CI's runner image, registers each runner the repository does not list yet and starts
# them all (docs/toolchain.md, "CI on the owner's iMac"). Safe to run again. Needs Docker Desktop
# running and `gh` signed in as an admin of the repo; the registration token is used once and
# never written down.
#
# A runner whose volume holds a registration the repository does not list (the archive's, after
# the move of #167, under the same URL) forgets it and registers afresh.
#
#   scripts/ci-runner/start.sh
set -euo pipefail
cd "$(dirname "$0")"
REPO=imDev2023/testing-pipeline

docker compose build
listed="$(gh api "repos/$REPO/actions/runners" --jq '.runners[].name')"
for service in $(docker compose config --services); do
  if docker compose run --rm --no-deps "$service" registered; then
    if grep -qx "imac-$service" <<<"$listed"; then
      echo "$service: registered"
      continue
    fi
    echo "$service: holds a registration $REPO does not list; forgetting it"
    docker compose stop "$service"
    docker compose run --rm --no-deps "$service" forget
  fi
  echo "$service: registering as imac-$service"
  RUNNER_TOKEN="$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)" \
    RUNNER_NAME="imac-$service" \
    docker compose run --rm --no-deps -e RUNNER_TOKEN -e RUNNER_NAME "$service" configure
done
docker compose up -d
docker compose ps
