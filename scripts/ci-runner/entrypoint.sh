#!/usr/bin/env bash
# The runner container's entrypoint (docs/toolchain.md, "CI on the owner's iMac"):
#   registered   exits 0 if this runner's home volume holds a registration
#   forget       deletes that registration from the volume only (for one GitHub no longer lists,
#                such as the archive's after the move of #167); GitHub drops its offline entry
#   configure    registers it, with RUNNER_TOKEN, RUNNER_NAME and REPO_URL from the environment
#   run          runs it, taking jobs labelled `testing-pipeline` (the default)
set -euo pipefail
cd "$HOME/actions-runner"

case "${1:-run}" in
  registered)
    # Newer runners rename their files to .runner_migrated and .credentials_migrated.
    test -f .runner || test -f .runner_migrated
    ;;
  forget)
    rm -f .runner .runner_migrated .credentials .credentials_migrated .credentials_rsaparams
    ;;
  configure)
    : "${RUNNER_TOKEN:?a registration token is needed; scripts/ci-runner/start.sh gets one}"
    : "${RUNNER_NAME:?}" "${REPO_URL:?}"
    ./config.sh --unattended --replace --url "$REPO_URL" --token "$RUNNER_TOKEN" \
      --name "$RUNNER_NAME" --labels testing-pipeline --work _work
    ;;
  run)
    if [ ! -f .runner ] && [ ! -f .runner_migrated ]; then
      echo "This runner is not registered; run scripts/ci-runner/start.sh." >&2
      exit 1
    fi
    # run.sh restarts the runner after it updates itself.
    exec ./run.sh
    ;;
  *)
    echo "usage: ci-runner-entrypoint [registered|forget|configure|run]" >&2
    exit 2
    ;;
esac
