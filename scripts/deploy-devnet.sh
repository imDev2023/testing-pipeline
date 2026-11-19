#!/usr/bin/env bash
# Deploys one of the workspace's programs to devnet from a verified build (docs/toolchain.md,
# "Deploy to devnet"; docs/spec/README.md, "Verified builds" and "Upgrade authority"):
#
#   1. refuses unless the cluster is devnet (by its genesis hash) or a local validator, and,
#      on devnet, unless the worktree is clean and HEAD is a commit on origin/main;
#   2. builds that commit, exported with `git archive` so nothing uncommitted can reach the
#      bytes, with solana-verify (0.5.2 or later) in Docker: the image pinned in
#      fixtures/pins.env for the workspace's `[workspace.metadata.cli] solana`, `--arch v3`;
#   3. deploys it (or upgrades it) paid by wallet.json, with upgrade-authority.json as its
#      upgrade authority, at the address in the program's keypair file;
#   4. stops unless the cluster's program hash equals the build's executable hash and the
#      program's upgrade authority is upgrade-authority.json's key;
#   5. records the program id, the executable hash, the commit, the Docker image, the upgrade
#      authority, the payer and the deploy slot in deployments/devnet.json, moving the
#      program's earlier deploy into its `history`.
#
#   scripts/deploy-devnet.sh <program> [--url devnet|<local validator URL>] [--build-only]
#                            [--record <file>] [--out <dir>]
#
#   <program>      a deployable workspace member, such as tax-amm
#   --url          devnet (the default) or a local validator's RPC URL, for a rehearsal
#   --build-only   build and print the executable hash; send nothing
#   --record       where the record goes; required on a local validator, and on devnet it is
#                  deployments/devnet.json
#   --out          also copy the built program into this directory, so the program's tests
#                  can run on the very bytes deployed (SBF_OUT_DIR=<dir> cargo test -p <program>)
#
# Keys come from $KEYS_DIR (default ~/.config/testing-pipeline/devnet): wallet.json,
# upgrade-authority.json and <program>.json, the program's own keypair. Needs the toolchain
# (source scripts/toolchain-env.sh) and Docker running. Never deploys to mainnet.
# DEPLOY_CHECK_TRIES (default 30, two seconds apart) bounds the wait for the cluster to serve
# the new program after the deploy.
set -euo pipefail
ROOT="${TESTING_PIPELINE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
KEYS_DIR="${KEYS_DIR:-$HOME/.config/testing-pipeline/devnet}"
DEVNET_URL=https://api.devnet.solana.com
DEVNET_GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
MIN_VERIFY_VERSION=0.5.2

usage() {
  echo "Usage: scripts/deploy-devnet.sh <program> [--url devnet|<local validator URL>] [--build-only] [--record <file>] [--out <dir>]" >&2
  exit 2
}
stop() {
  echo "Stopped: $*" >&2
  exit 1
}

program="${1:-}"
[ -n "$program" ] && [ "${program#-}" = "$program" ] || usage
shift
url=devnet
build_only=false
record=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) url="${2:?--url needs a value}"; shift 2 ;;
    --build-only) build_only=true; shift ;;
    --record) record="${2:?--record needs a value}"; shift 2 ;;
    --out) out="${2:?--out needs a value}"; shift 2 ;;
    *) usage ;;
  esac
done

if ! python3 "$ROOT/scripts/workspace-programs.py" | grep -qx "$program"; then
  echo "$program is not a deployable program of the workspace; these are:" >&2
  python3 "$ROOT/scripts/workspace-programs.py" >&2
  exit 2
fi
lib="${program//-/_}"
program_id="$(sed -n 's/^declare_id!("\([1-9A-HJ-NP-Za-km-z]*\)");$/\1/p' "$ROOT/programs/$program/src/lib.rs")"
[ -n "$program_id" ] || stop "no declare_id! address in programs/$program/src/lib.rs"

# 1. The cluster: devnet, or a local validator for a rehearsal. Nothing else, ever.
local_cluster=false
case "$url" in
  devnet) url="$DEVNET_URL" ;;
  http://127.0.0.1:* | http://localhost:* | http://127.0.0.1 | http://localhost) local_cluster=true ;;
  *mainnet* | *testnet*) stop "$url is not devnet: this script deploys only to devnet or a local validator" ;;
  https://*) ;; # another devnet RPC, checked by its genesis hash below
  *) stop "$url is neither devnet nor a local validator: this script deploys only to devnet or a local validator" ;;
esac
if ! $local_cluster && ! $build_only; then
  genesis="$(solana genesis-hash -u "$url")"
  [ "$genesis" = "$DEVNET_GENESIS" ] || stop "$url is not devnet (genesis hash $genesis)"
fi
if $local_cluster && ! $build_only && [ -z "$record" ]; then
  stop "a local validator's deploy is recorded only where --record says, never in deployments/devnet.json"
fi
[ -n "$record" ] || record="$ROOT/deployments/devnet.json"

verify_version="$(solana-verify --version | awk '{print $2}')"
if [ "$(printf '%s\n%s\n' "$MIN_VERIFY_VERSION" "$verify_version" | sort -V | head -1)" != "$MIN_VERIFY_VERSION" ]; then
  stop "solana-verify is $verify_version; verified builds need $MIN_VERIFY_VERSION or later (scripts/install-toolchain.sh verify)"
fi

# The commit: on devnet it must be a commit on main, with nothing uncommitted beside it but
# deployments/devnet.json, whose new records reach main through a PR after the deploys.
if [ -n "$(git -C "$ROOT" status --porcelain -- . ':(exclude)deployments/devnet.json')" ]; then
  if $local_cluster; then
    echo "note: the worktree has uncommitted changes, which the build leaves out" >&2
  else
    stop "the worktree has uncommitted changes; deploy from a clean checkout of main"
  fi
fi
commit="$(git -C "$ROOT" rev-parse HEAD)"
if ! $local_cluster; then
  perl -e 'alarm 120; exec @ARGV' git -C "$ROOT" fetch -q origin main || stop "git fetch origin main failed; try again"
  git -C "$ROOT" merge-base --is-ancestor "$commit" origin/main \
    || stop "HEAD ($commit) is not on origin/main; only a commit on main is deployed"
fi

# 2. The verified build, in Docker, of exactly that commit.
# shellcheck source=../fixtures/pins.env
source "$ROOT/fixtures/pins.env"
: "${VERIFY_IMAGE:?fixtures/pins.env names no VERIFY_IMAGE}" "${VERIFY_SOLANA_VERSION:?fixtures/pins.env names no VERIFY_SOLANA_VERSION}"
workspace_solana="$(python3 -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["workspace"]["metadata"]["cli"]["solana"])' "$ROOT/programs/Cargo.toml")"
if [ "$workspace_solana" != "$VERIFY_SOLANA_VERSION" ]; then
  stop "programs/Cargo.toml pins Solana $workspace_solana, but VERIFY_IMAGE in fixtures/pins.env is for $VERIFY_SOLANA_VERSION; pin the image solana-verify uses for $workspace_solana"
fi
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
git -C "$ROOT" archive "$commit" programs | tar -x -C "$build_dir"
echo "== Verified build of $program at $commit (image $VERIFY_IMAGE)"
solana-verify build "$build_dir/programs" --library-name "$lib" --arch v3 --base-image "$VERIFY_IMAGE"
so="$build_dir/programs/target/deploy/$lib.so"
[ -f "$so" ] || stop "the build wrote no $so"
hash="$(solana-verify get-executable-hash "$so")"
echo "Executable hash: $hash"
if [ -n "$out" ]; then
  mkdir -p "$out"
  cp "$so" "$out/$lib.so"
  echo "Copied to $out/$lib.so"
fi
if $build_only; then
  exit 0
fi

# 3. Deploy: the wallet pays, the upgrade authority is the program's authority.
wallet="$KEYS_DIR/wallet.json"
authority_key="$KEYS_DIR/upgrade-authority.json"
program_key="$KEYS_DIR/$program.json"
for key in "$wallet" "$authority_key" "$program_key"; do
  [ -f "$key" ] || stop "no key $key"
done
[ "$(solana-keygen pubkey "$program_key")" = "$program_id" ] || stop "$program_key is not the key of $program_id"
authority="$(solana-keygen pubkey "$authority_key")"
payer="$(solana-keygen pubkey "$wallet")"
echo "== Deploying $program_id to $url, paid by $payer, upgrade authority $authority"
deploy_flags=()
$local_cluster || deploy_flags+=(--use-rpc)
solana program deploy -u "$url" -k "$wallet" --program-id "$program_key" \
  --upgrade-authority "$authority_key" ${deploy_flags[@]+"${deploy_flags[@]}"} "$so"

# 4. What the cluster now runs, and who may change it. A cluster can answer from a slot before
# the deploy for a few seconds after it, so each read is retried for up to a minute.
retry() {
  local out
  for _ in $(seq 1 "${DEPLOY_CHECK_TRIES:-30}"); do
    if out="$("$@" 2>/dev/null)" && [ -n "$out" ]; then
      echo "$out"
      return 0
    fi
    sleep 2
  done
  "$@"
}
# Right after an upgrade a cluster can still answer with the old bytes, so wait for the new.
for _ in $(seq 1 "${DEPLOY_CHECK_TRIES:-30}"); do
  onchain_hash="$(retry solana-verify get-program-hash -u "$url" "$program_id")"
  [ "$onchain_hash" = "$hash" ] && break
  sleep 2
done
[ "$onchain_hash" = "$hash" ] || stop "the cluster's program hash $onchain_hash does not match the build's $hash"
# Read once the new bytes are served, so the slot and the authority are this deploy's.
show="$(retry solana program show -u "$url" --commitment confirmed "$program_id" --output json)"
onchain_authority="$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["authority"])' "$show")"
slot="$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["lastDeploySlot"])' "$show")"
[ "$onchain_authority" = "$authority" ] \
  || stop "the program's upgrade authority is $onchain_authority, not upgrade-authority.json's $authority"
echo "On-chain hash matches the build: $onchain_hash; upgrade authority $onchain_authority; deployed in slot $slot"

# 5. The record.
cluster_label=devnet
$local_cluster && cluster_label="$url"
python3 - "$record" "$cluster_label" "$program" "$program_id" "$hash" "$commit" "$VERIFY_IMAGE" "$authority" "$payer" "$slot" <<'EOF'
import datetime, json, os, sys

path, cluster, program, program_id, hash_, commit, image, authority, payer, slot = sys.argv[1:]
record = json.load(open(path)) if os.path.exists(path) else {"cluster": cluster, "programs": {}}
if record.get("cluster") != cluster:
    sys.exit(f"{path} records {record.get('cluster')}, not {cluster}")
previous = record["programs"].get(program)
entry = {
    "programId": program_id,
    "executableHash": hash_,
    "commit": commit,
    "dockerImage": image,
    "upgradeAuthority": authority,
    "deployedBy": payer,
    "slot": int(slot),
    "deployedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
# Earlier deploys of the program, newest first: the metadata may still name one of them
# until it is pinned to this deploy.
if previous:
    earlier = {k: v for k, v in previous.items() if k != "history"}
    entry["history"] = [earlier] + previous.get("history", [])
record["programs"][program] = entry
record["programs"] = dict(sorted(record["programs"].items()))
with open(path, "w") as f:
    json.dump(record, f, indent=2)
    f.write("\n")
EOF
echo "Recorded in $record"
