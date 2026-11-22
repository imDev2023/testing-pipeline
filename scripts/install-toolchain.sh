#!/usr/bin/env bash
# Installs the Solana toolchain Pipeline and this project build with, side by side with the
# Solana CLI the machine already uses. Nothing goes into ~/.cargo/bin or into agave-install's
# active_release, so other projects keep their own versions. Safe to run again.
# What it installs and why: docs/toolchain.md.
#
#   scripts/install-toolchain.sh [solana] [agave] [kani] [verify]    # default: solana and kani
#
# `solana` is Rust, cargo-build-sbf, the platform tools and the Agave CLI; `agave` is the Agave
# CLI alone, for the daily router pin check, which only dumps the router; `kani` is Rust and
# the Kani model checker for the maths proofs; `verify` is solana-verify, for the Docker
# verified builds a devnet deploy needs (docs/toolchain.md, "Deploy to devnet"), which CI does
# not run. CI installs each part in the job that needs it.
set -euo pipefail

ROOT="${TESTING_PIPELINE_TOOLCHAIN:-$HOME/.local/share/testing-pipeline/toolchain}"
RUST_VERSION=1.97.1
CARGO_BUILD_SBF_VERSION=4.6.0
AGAVE_VERSION=v4.4.1
KANI_VERSION=0.67.0
SOLANA_VERIFY_VERSION=0.5.2

PARTS="${*:-solana kani}"
for part in $PARTS; do
  case "$part" in
    solana | agave | kani | verify) ;;
    *) echo "unknown part: $part (expected solana, agave, kani or verify)" >&2; exit 2 ;;
  esac
done
want() { [[ " $PARTS " == *" $1 "* ]]; }

case "$(uname -sm)" in
  "Darwin x86_64")
    AGAVE_TARGET=x86_64-apple-darwin
    AGAVE_SHA256=2ae847d320d4be7c2a732c7821e570f7927cadaf385fb94b2853841c0d6a5b18
    # Platform tools v1.58, cargo-build-sbf 4.6.0's default, has no Intel macOS build.
    SBF_TOOLS_VERSION=v1.57
    SBF_TOOLS_ASSET=platform-tools-osx-x86_64.tar.bz2
    SBF_TOOLS_SHA256=e6f6231b149e64ad6cc12605d0f993405ce55862aa44406c023563159f8c3caf
    ;;
  "Darwin arm64")
    AGAVE_TARGET=aarch64-apple-darwin
    AGAVE_SHA256=e60d66468977f6a5b5f17523ea3a1846ececfa7cc657efa0b9af279bd58db369
    SBF_TOOLS_VERSION=v1.58
    SBF_TOOLS_ASSET=platform-tools-osx-aarch64.tar.bz2
    SBF_TOOLS_SHA256=17a89dae89936f045789d484140fd19a7bd992d4522d4ab0e9adeae565e35d12
    ;;
  "Linux x86_64")
    AGAVE_TARGET=x86_64-unknown-linux-gnu
    AGAVE_SHA256=5b0f0fc7e4eedace05f6455de00aa1f2f3d1642068f1e8d50760ba49112c3941
    SBF_TOOLS_VERSION=v1.58
    SBF_TOOLS_ASSET=platform-tools-linux-x86_64.tar.bz2
    SBF_TOOLS_SHA256=7b82eb420b5aebd1e5590db0ae25c523eca06724d4238ae02139690535636c37
    ;;
  *)
    echo "unsupported host: $(uname -sm)" >&2
    exit 1
    ;;
esac

mkdir -p "$ROOT"

# cargo-build-sbf relinks rustup's toolchains named *solana*; remember the machine's own
# `solana` link (used by agave-install's cargo-build-sbf) so it can be put back.
solana_link_before="$(rustup toolchain list -v | awk '$1 == "solana" { print $NF }')"

if want solana || want kani || want verify; then
  echo "== Rust $RUST_VERSION (Pipeline's rust-toolchain.toml)"
  rustup toolchain list | grep -q "^$RUST_VERSION-" || rustup toolchain install "$RUST_VERSION" --profile minimal --component rustfmt,clippy
fi

CBS="$ROOT/cargo-build-sbf-$CARGO_BUILD_SBF_VERSION"
AGAVE="$ROOT/agave-$AGAVE_VERSION"
KANI="$ROOT/kani-$KANI_VERSION"
VERIFY="$ROOT/solana-verify-$SOLANA_VERIFY_VERSION"

install_solana() {
  echo "== cargo-build-sbf $CARGO_BUILD_SBF_VERSION"
  if ! "$CBS/bin/cargo-build-sbf" --version 2>/dev/null | grep -q "^cargo-build-sbf $CARGO_BUILD_SBF_VERSION$"; then
    build_dir="$(mktemp -d)"
    CARGO_TARGET_DIR="$build_dir" cargo "+$RUST_VERSION" install cargo-build-sbf \
      --version "$CARGO_BUILD_SBF_VERSION" --locked --root "$CBS"
    rm -rf "$build_dir"
  fi

  echo "== platform tools $SBF_TOOLS_VERSION"
  # Downloaded here, from the release's file URL, into the folder cargo-build-sbf looks in.
  # `cargo-build-sbf --install-only` asks GitHub's REST API for the release first, without a
  # token, and on GitHub's shared runners that is rate limited: on 2026-11-20 the first cold
  # install there failed with "Failed to parse Github response: error decoding response body".
  tools_dir="${SOLANA_PLATFORM_TOOLS_DIR:-$HOME/.cache/solana}/$SBF_TOOLS_VERSION"
  if [ ! -x "$tools_dir/platform-tools/rust/bin/rustc" ]; then
    mkdir -p "$tools_dir"
    staging="$(mktemp -d "$tools_dir/.staging.XXXXXX")"
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 10 -o "$staging/$SBF_TOOLS_ASSET" \
      "https://github.com/anza-xyz/platform-tools/releases/download/$SBF_TOOLS_VERSION/$SBF_TOOLS_ASSET"
    echo "$SBF_TOOLS_SHA256  $staging/$SBF_TOOLS_ASSET" | shasum -a 256 -c -
    mkdir "$staging/platform-tools"
    tar -xjf "$staging/$SBF_TOOLS_ASSET" -C "$staging/platform-tools"
    rm -rf "$tools_dir/platform-tools"
    mv "$staging/platform-tools" "$tools_dir/platform-tools"
    rm -rf "$staging"
  fi

  # cargo-build-sbf reads the platform tools version only from --tools-version, and Pipeline's
  # own scripts and strategy template call a bare `cargo build-sbf`. Where 4.6.0's default
  # has no build for this host, toolchain-env.sh puts this wrapper first on PATH; it adds
  # --tools-version unless the caller passed one.
  if [ "$SBF_TOOLS_VERSION" != v1.58 ]; then
    echo "== cargo-build-sbf wrapper (platform tools $SBF_TOOLS_VERSION by default)"
    mkdir -p "$ROOT/shims"
    cat > "$ROOT/shims/cargo-build-sbf" <<EOF
#!/usr/bin/env bash
# Written by testing-pipeline's scripts/install-toolchain.sh: runs cargo-build-sbf
# $CARGO_BUILD_SBF_VERSION with platform tools $SBF_TOOLS_VERSION unless --tools-version is given.
real="$CBS/bin/cargo-build-sbf"
for arg in "\$@"; do
  case "\$arg" in --tools-version|--tools-version=*) exec "\$real" "\$@" ;; esac
done
# \`cargo build-sbf\` runs this as \`cargo-build-sbf build-sbf ...\`; keep that first.
if [ "\${1:-}" = build-sbf ]; then
  shift
  exec "\$real" build-sbf --tools-version "$SBF_TOOLS_VERSION" "\$@"
fi
exec "\$real" --tools-version "$SBF_TOOLS_VERSION" "\$@"
EOF
    chmod +x "$ROOT/shims/cargo-build-sbf"
  fi

  install_agave

  solana_link_after="$(rustup toolchain list -v | awk '$1 == "solana" { print $NF }')"
  if [ -n "$solana_link_before" ] && [ "$solana_link_after" != "$solana_link_before" ]; then
    echo "== restoring rustup's solana toolchain link"
    if [ -n "$solana_link_after" ]; then rustup toolchain uninstall solana; fi
    rustup toolchain link solana "$solana_link_before"
  fi
}

install_agave() {
  echo "== Agave $AGAVE_VERSION CLI ($AGAVE_TARGET)"
  if ! "$AGAVE/bin/solana" --version 2>/dev/null | grep -q "^solana-cli ${AGAVE_VERSION#v} "; then
    download_dir="$(mktemp -d)"
    tarball="$download_dir/solana-release.tar.bz2"
    curl -sSfL --retry 3 -o "$tarball" \
      "https://github.com/anza-xyz/agave/releases/download/$AGAVE_VERSION/solana-release-$AGAVE_TARGET.tar.bz2"
    echo "$AGAVE_SHA256  $tarball" | shasum -a 256 -c -
    tar -xjf "$tarball" -C "$download_dir"
    rm -rf "$AGAVE"
    mv "$download_dir/solana-release" "$AGAVE"
    rm -rf "$download_dir"
  fi
}

# Kani's own files go to ~/.kani/kani-$KANI_VERSION, and `cargo kani setup` adds the nightly
# Rust it compiles with as a rustup toolchain of its own; neither changes a default.
install_kani() {
  echo "== Kani $KANI_VERSION"
  if ! "$KANI/bin/cargo-kani" --version 2>/dev/null | grep -q " $KANI_VERSION$"; then
    build_dir="$(mktemp -d)"
    CARGO_TARGET_DIR="$build_dir" cargo "+$RUST_VERSION" install kani-verifier \
      --version "$KANI_VERSION" --locked --root "$KANI"
    rm -rf "$build_dir"
  fi
  # The setup's last step links its rustup toolchain; an interrupted setup (GitHub downloads
  # are flaky on the owner's network), or a cache that restored ~/.kani without the toolchain
  # it links to, leaves no working compiler there, and running the setup again finishes it.
  if [ ! -x "$HOME/.kani/kani-$KANI_VERSION/toolchain/bin/rustc" ]; then
    PATH="$KANI/bin:$PATH" cargo kani setup
  fi
}

# The machine keeps the solana-verify it already has (0.4.9 in ~/.avm/bin, too old for --arch);
# this one goes beside it and toolchain-env.sh puts it first.
install_verify() {
  echo "== solana-verify $SOLANA_VERIFY_VERSION"
  if ! "$VERIFY/bin/solana-verify" --version 2>/dev/null | grep -q " $SOLANA_VERIFY_VERSION$"; then
    build_dir="$(mktemp -d)"
    CARGO_TARGET_DIR="$build_dir" cargo "+$RUST_VERSION" install solana-verify \
      --version "$SOLANA_VERIFY_VERSION" --locked --root "$VERIFY"
    rm -rf "$build_dir"
  fi
}

if want solana; then install_solana; elif want agave; then install_agave; fi
if want kani; then install_kani; fi
if want verify; then install_verify; fi

echo
echo "Installed in $ROOT:"
if want solana; then
  "$CBS/bin/cargo-build-sbf" --version | head -1
  "$AGAVE/bin/solana" --version
  "$AGAVE/bin/solana-test-validator" --version
  echo "Platform tools: $SBF_TOOLS_VERSION"
elif want agave; then
  "$AGAVE/bin/solana" --version
fi
if want kani; then
  PATH="$KANI/bin:$PATH" cargo kani --version
fi
if want verify; then
  "$VERIFY/bin/solana-verify" --version
fi
echo "Use it in a shell with: source scripts/toolchain-env.sh"
