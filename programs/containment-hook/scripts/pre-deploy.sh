#!/usr/bin/env bash
# The containment hook's pre-deploy check, which scripts/deploy-devnet.sh runs on the very
# bytes it is about to deploy: its release gate (hardening findings H011, H002 and R2T-01 to
# R2T-06, #74). It copies every account the hook owns on the cluster, every config with the
# accounts its binding names, the contained mints' Token-2022 accounts, the hook deployed
# there and the tax AMM its home markets run on (scripts/gate_snapshot.py), then lets the
# deploy go ahead only if the census adds up and the new build serves every config the
# deployed build wrote: a fresh mint binds, each token still contained buys, sells, has a buy
# into an account whose owner can change, a direct Execute and a wallet-to-wallet transfer
# refused, pays and sweeps its fee account where the fee is in the token, and unlocks by its
# goal and at its deadline, and each unlocked one stays unlocked
# (programs/containment-hook/tests/release_gate.rs). On devnet, known by its genesis hash, the
# gate also refuses a hook built for another tax AMM than deployments/devnet.json records
# (H072) and a census that misses a config the committed fixture or the demo record holds.
# What the gate read is written to release-gate.json beside the copy, and when it passes on
# devnet also to deployments/release-gate/containment-hook/devnet.json, for the deploy's
# record PR.
#
#   programs/containment-hook/scripts/pre-deploy.sh --url <cluster URL> --so <containment_hook.so> --program <program id>
#
# HOOK_GATE_DIR keeps the copy in a folder of your choosing, which must be empty or new (by
# default a fresh temporary one); the copy goes in its snapshot/ folder and the report beside
# it. HOOK_GATE_ALLOW_EMPTY and HOOK_GATE_ALLOW_FEWER, each set to the reason, let the gate
# pass a deployed hook with no config, or a devnet census missing recorded configs; the report
# records the reason. Needs the toolchain on PATH (source scripts/toolchain-env.sh), python3,
# and an RPC that serves getProgramAccounts on the hook (the public devnet RPC does).
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
if [ -d "$dir" ] && [ -n "$(ls -A "$dir")" ]; then
  echo "pre-deploy.sh: $dir is not empty; the gate copies the cluster into an empty or new folder, so nothing stale is read" >&2
  exit 2
fi
mkdir -p "$dir"
snapshot="$dir/snapshot"
# An RPC or transport error stops the copy, and with it the deploy; it never reads as "not deployed".
python3 -I "$ROOT/programs/containment-hook/scripts/gate_snapshot.py" --url "$url" --program "$program" --out "$snapshot"
manifest() { python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")' "$snapshot/manifest.json" "$1"; }
deployed="" tax_amm=""
if [ "$(manifest deployed)" = "True" ]; then
  deployed="$snapshot/deployed.so"
  # Present when the cluster holds a binding, whose home market names the tax AMM.
  if [ -f "$snapshot/tax_amm_deployed.so" ]; then
    tax_amm="$snapshot/tax_amm_deployed.so"
  fi
else
  echo "pre-deploy.sh: $program is not deployed on $url yet, so the gate checks the new build alone"
fi

report="$dir/release-gate.json"
if ! (cd "$ROOT/programs" && HOOK_GATE_SNAPSHOT="$snapshot" HOOK_GATE_CANDIDATE="$so" HOOK_GATE_PROGRAM="$program" \
  HOOK_GATE_TAX_AMM="$tax_amm" HOOK_GATE_DEPLOYED="$deployed" HOOK_GATE_REPORT="$report" \
  cargo test --quiet -p containment-hook --test release_gate -- --ignored --nocapture); then
  echo "pre-deploy.sh: refused: the new build strands a contained token on $url, or the copy does not add up (copied to $snapshot; what it read is in $report)" >&2
  exit 1
fi
# Devnet by its genesis hash, whatever RPC served it (R2T-04).
if [ "$(manifest genesis_hash)" = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" ]; then
  record="$ROOT/deployments/release-gate/containment-hook/devnet.json"
  mkdir -p "$(dirname "$record")"
  cp "$report" "$record"
  report="$record"
fi
echo "pre-deploy.sh: the release gate passed; what it read is in $report"
