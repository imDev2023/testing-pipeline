#!/usr/bin/env bash
# The buy wall AMM's pre-deploy check, which scripts/deploy-devnet.sh runs on the very bytes it
# is about to deploy: it lets the deploy go ahead only if the release gate has passed this build
# (its executable hash) on this cluster, against the build deployed there now and covering every
# market there now (docs/spec/pool4-for-solana.md, "A release gate"; POOL4-43, POOL4-54).
#
#   programs/buy-wall-amm/scripts/pre-deploy.sh --url <cluster URL> --so <buy_wall_amm.so> --program <program id>
#
# Run the gate first, on the build deploy-devnet.sh makes (its --build-only --out <dir>):
#
#   cd programs && cargo run -p buy-wall-gate -- run --cluster devnet --candidate <dir>/buy_wall_amm.so
#
# BUY_WALL_GATE_RECORDS names another folder of records (a local validator's rehearsal keeps
# its records out of the repo); by default they are deployments/release-gate/buy-wall-amm/.
# Needs the toolchain on PATH (source scripts/toolchain-env.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

url="" so="" program=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) url="${2:?--url needs a value}" ;;
    --so) so="${2:?--so needs a value}" ;;
    --program) program="${2:?--program needs a value}" ;;
    *) echo "pre-deploy.sh: unexpected argument $1" >&2; exit 2 ;;
  esac
  shift 2
done
[ -n "$url" ] && [ -n "$so" ] && [ -n "$program" ] || { echo "pre-deploy.sh: --url, --so and --program are required" >&2; exit 2; }

verify=(verify-record --cluster "$url" --candidate "$so" --program "$program")
[ -n "${BUY_WALL_GATE_RECORDS:-}" ] && verify+=(--records "$BUY_WALL_GATE_RECORDS")
if ! (cd "$ROOT/programs" && cargo run --quiet -p buy-wall-gate -- "${verify[@]}"); then
  # The build deploy-devnet.sh made is gone once it stops, so name the steps that keep one.
  echo "pre-deploy.sh: refused: the release gate has not passed this build against this cluster; run:" >&2
  echo "  scripts/deploy-devnet.sh buy-wall-amm --build-only --out <dir>" >&2
  echo "  (cd programs && cargo run -p buy-wall-gate -- run --cluster <cluster> --candidate <dir>/buy_wall_amm.so)" >&2
  exit 1
fi
