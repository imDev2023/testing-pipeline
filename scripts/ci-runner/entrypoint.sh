#!/usr/bin/env bash
# The runner container's entrypoint (docs/toolchain.md, "CI on the owner's iMac"):
#   registered   exits 0 if this runner's home volume holds a registration
#   configure    registers it, with RUNNER_TOKEN, RUNNER_NAME and REPO_URL from the environment
#   run          runs it, taking jobs labelled `testing-pipeline` (the default)
set -euo pipefail
cd "$HOME/actions-runner"

case "${1:-run}" in
  registered)
    test -f .runner
    ;;
  configure)
    : "${RUNNER_TOKEN:?a registration token is needed; scripts/ci-runner/start.sh gets one}"
    : "${RUNNER_NAME:?}" "${REPO_URL:?}"
    ./config.sh --unattended --replace --url "$REPO_URL" --token "$RUNNER_TOKEN" \
      --name "$RUNNER_NAME" --labels testing-pipeline --work _work
    ;;
  run)
    if [ ! -f .runner ]; then
      echo "This runner is not registered; run scripts/ci-runner/start.sh." >&2
      exit 1
    fi
    # run.sh restarts the runner after it updates itself.
    exec ./run.sh
    ;;
  *)
    echo "usage: ci-runner-entrypoint [registered|configure|run]" >&2
    exit 2
    ;;
esac
