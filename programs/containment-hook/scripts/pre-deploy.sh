#!/usr/bin/env bash
# The containment hook's pre-deploy check, which scripts/deploy-devnet.sh runs on the very
# bytes it is about to deploy: its release gate (hardening finding H011, #74). It copies every
# hook config on the cluster with the accounts its binding names, the hook deployed there and
# the tax AMM its home markets run on, then lets the deploy go ahead only if the new build
# serves every config the deployed build wrote: each token still contained buys, sells, has a
# wallet-to-wallet transfer refused and unlocks at its deadline, and each unlocked one stays
# unlocked (programs/containment-hook/tests/release_gate.rs). On devnet the gate also refuses
# a hook built for another tax AMM than deployments/devnet.json records (H072). What the gate
# read is written to release-gate.json in the copy's folder, and when it passes on devnet also
# to deployments/release-gate/containment-hook/devnet.json, for the deploy's record PR.
#
#   programs/containment-hook/scripts/pre-deploy.sh --url <cluster URL> --so <containment_hook.so> --program <program id>
#
# HOOK_GATE_DIR keeps the copy in a folder of your choosing (by default a fresh temporary
# one). Needs the toolchain on PATH (source scripts/toolchain-env.sh), python3, and an RPC
# that serves getProgramAccounts (the public devnet RPC does).
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

dir="${HOOK_GATE_DIR:-$(mktemp -d)}"
mkdir -p "$dir"
snapshot=(python3 -I "$ROOT/programs/containment-hook/scripts/gate_snapshot.py" --url "$url" --program "$program" --out "$dir")
deployed="" tax_amm=""
if solana program show --url "$url" "$program" >/dev/null 2>&1; then
  "${snapshot[@]}" --deployed
  deployed="$dir/deployed.so"
  # Present when the cluster holds a binding, whose home market names the tax AMM.
  if [ -f "$dir/tax_amm_deployed.so" ]; then
    tax_amm="$dir/tax_amm_deployed.so"
  fi
else
  echo "pre-deploy.sh: $program is not deployed on $url yet, so the gate checks the new build alone"
  "${snapshot[@]}"
fi

report="$dir/release-gate.json"
if ! (cd "$ROOT/programs" && HOOK_GATE_SNAPSHOT="$dir" HOOK_GATE_CANDIDATE="$so" \
  HOOK_GATE_TAX_AMM="$tax_amm" HOOK_GATE_DEPLOYED="$deployed" HOOK_GATE_REPORT="$report" \
  cargo test --quiet -p containment-hook --test release_gate -- --ignored --nocapture); then
  echo "pre-deploy.sh: refused: the new build strands a contained token on $url (copied to $dir; what it read is in $report)" >&2
  exit 1
fi
case "$url" in
  devnet|https://api.devnet.solana.com*)
    record="$ROOT/deployments/release-gate/containment-hook/devnet.json"
    mkdir -p "$(dirname "$record")"
    cp "$report" "$record"
    report="$record"
    ;;
esac
echo "pre-deploy.sh: the release gate passed; what it read is in $report"
