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

# Each file is sourced with export on: a file may switch it off itself (global.env ends with
# `set +a`), which would leave every later setting unexported.
for env_file in "$HOME/.config/env/global.env" "$ROOT/.env"; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
done

if [ ! -x "$NODE" ]; then
  echo "keeper-run.sh: no Node at $NODE; install the version docs/toolchain.md names" >&2
  exit 1
fi
if [ ! -f "$ROOT/apps/keeper/dist/keeper.mjs" ]; then
  echo "keeper-run.sh: the runner is not built; run pnpm keeper:install" >&2
  exit 1
fi
exec "$NODE" "$ROOT/apps/keeper/dist/keeper.mjs" run
