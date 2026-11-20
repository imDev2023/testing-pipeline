#!/usr/bin/env bash
# Starts the keeper runner for its launchd agent (apps/keeper/README.md; docs/spec/keeper-runner.md,
# "Running it"). launchd has no direnv, so this loads what the project's .envrc would: the
# owner's shared keys (ALCHEMY_API_KEY, which the RPC default is built from) and the project's
# .env (Aviary's RPC_URL once it exists), then runs the built runner on the Node version
# docs/toolchain.md names. `pnpm keeper:install` builds the runner and writes the agent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# docs/toolchain.md, "Versions": Node 24.4.1 from nvm.
NODE="$HOME/.nvm/versions/node/v24.4.1/bin/node"

set -a
# shellcheck disable=SC1091
[ -f "$HOME/.config/env/global.env" ] && source "$HOME/.config/env/global.env"
# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && source "$ROOT/.env"
set +a

if [ ! -x "$NODE" ]; then
  echo "keeper-run.sh: no Node at $NODE; install the version docs/toolchain.md names" >&2
  exit 1
fi
if [ ! -f "$ROOT/apps/keeper/dist/keeper.mjs" ]; then
  echo "keeper-run.sh: the runner is not built; run pnpm keeper:install" >&2
  exit 1
fi
exec "$NODE" "$ROOT/apps/keeper/dist/keeper.mjs" run
