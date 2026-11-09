# Puts this project's Solana toolchain (from scripts/install-toolchain.sh) first on PATH for
# the current shell only, so the machine's default Solana CLI stays as it is elsewhere:
#   source scripts/toolchain-env.sh
#   cargo build-sbf --tools-version "$SBF_TOOLS_VERSION"
# Each Bash tool call is a fresh shell, so agents source it in every call that needs it.

TESTING_PIPELINE_TOOLCHAIN="${TESTING_PIPELINE_TOOLCHAIN:-$HOME/.local/share/testing-pipeline/toolchain}"

# cargo-build-sbf 4.6.0 before Agave's bin, which ships its own older cargo-build-sbf.
export PATH="$TESTING_PIPELINE_TOOLCHAIN/cargo-build-sbf-4.6.0/bin:$TESTING_PIPELINE_TOOLCHAIN/agave-v4.4.1/bin:$PATH"

# Platform tools v1.58, cargo-build-sbf 4.6.0's default, has no Intel macOS build.
if [ "$(uname -sm)" = "Darwin x86_64" ]; then
  export SBF_TOOLS_VERSION=v1.57
else
  export SBF_TOOLS_VERSION=v1.58
fi

# Node 24 for the TypeScript SDK and devnet scripts: Node 26's experimental WebSocket over
# HTTP/2 fails against api.devnet.solana.com from the fifth connection on.
NODE24_BIN="$(find "$HOME/.nvm/versions/node" -maxdepth 1 -name 'v24.*' 2>/dev/null | sort -V | tail -1)"
if [ -n "$NODE24_BIN" ] && [ -x "$NODE24_BIN/bin/node" ]; then
  export PATH="$NODE24_BIN/bin:$PATH"
elif [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 26 ]; then
  echo "toolchain-env: Node 24 not found; Node 26 breaks WebSocket confirmations on public devnet" >&2
fi
unset NODE24_BIN
