#!/usr/bin/env bash
# The tax AMM's pre-deploy check, which scripts/deploy-devnet.sh runs on the very bytes it is
# about to deploy: its release gate (hardening finding H038, #67). It copies every tax market
# on the cluster and the program deployed there, then lets the deploy go ahead only if the new
# build reads every market and quotes it each way at the spec's price, exactly as the
# deployed build does, so the upgrade strands none (programs/tax-amm/tests/release_gate.rs).
# On devnet it records what it read in deployments/release-gate/tax-amm/devnet.json, for the
# deploy's record PR; elsewhere in the copy's folder only.
#
#   programs/tax-amm/scripts/pre-deploy.sh --url <cluster URL> --so <tax_amm.so> --program <program id>
#
# TAX_AMM_GATE_DIR keeps the copy in a folder of your choosing (by default a fresh temporary
# one). Needs the toolchain on PATH (source scripts/toolchain-env.sh) and python3.
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
so="$(cd "$(dirname "$so")" && pwd)/$(basename "$so")"

dir="${TAX_AMM_GATE_DIR:-$(mktemp -d)}"
mkdir -p "$dir"
snapshot=(python3 -I "$ROOT/programs/tax-amm/scripts/gate_snapshot.py" --url "$url" --program "$program" --out "$dir")
deployed=""
if solana program show --url "$url" "$program" >/dev/null 2>&1; then
  "${snapshot[@]}" --deployed
  deployed="$dir/deployed.so"
else
  echo "pre-deploy.sh: $program is not deployed on $url yet, so the gate checks the new build alone"
  "${snapshot[@]}"
fi

report="$dir/release-gate.json"
case "$url" in
  devnet|https://api.devnet.solana.com*) report="$ROOT/deployments/release-gate/tax-amm/devnet.json" ;;
esac
mkdir -p "$(dirname "$report")"
if ! (cd "$ROOT/programs" && TAX_AMM_GATE_SNAPSHOT="$dir" TAX_AMM_GATE_CANDIDATE="$so" \
  TAX_AMM_GATE_DEPLOYED="$deployed" TAX_AMM_GATE_REPORT="$report" \
  cargo test --quiet -p tax-amm --test release_gate -- --ignored --nocapture); then
  echo "pre-deploy.sh: refused: the new build strands or reprices a tax market on $url (copied to $dir)" >&2
  exit 1
fi
echo "pre-deploy.sh: the release gate passed; what it read is in $report"
