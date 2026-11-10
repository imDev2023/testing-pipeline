#!/usr/bin/env bash
# Installs the Solana toolchain Pipeline and this project build with, side by side with the
# Solana CLI the machine already uses. Nothing goes into ~/.cargo/bin or into agave-install's
# active_release, so other projects keep their own versions. Safe to run again.
# What it installs and why: docs/toolchain.md.
set -euo pipefail

ROOT="${TESTING_PIPELINE_TOOLCHAIN:-$HOME/.local/share/testing-pipeline/toolchain}"
RUST_VERSION=1.97.1
CARGO_BUILD_SBF_VERSION=4.6.0
AGAVE_VERSION=v4.4.1

case "$(uname -sm)" in
  "Darwin x86_64")
    AGAVE_TARGET=x86_64-apple-darwin
    AGAVE_SHA256=2ae847d320d4be7c2a732c7821e570f7927cadaf385fb94b2853841c0d6a5b18
    # Platform tools v1.58, cargo-build-sbf 4.6.0's default, has no Intel macOS build.
    SBF_TOOLS_VERSION=v1.57
    ;;
  "Darwin arm64")
    AGAVE_TARGET=aarch64-apple-darwin
    AGAVE_SHA256=e60d66468977f6a5b5f17523ea3a1846ececfa7cc657efa0b9af279bd58db369
    SBF_TOOLS_VERSION=v1.58
    ;;
  "Linux x86_64")
    AGAVE_TARGET=x86_64-unknown-linux-gnu
    AGAVE_SHA256=5b0f0fc7e4eedace05f6455de00aa1f2f3d1642068f1e8d50760ba49112c3941
    SBF_TOOLS_VERSION=v1.58
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

echo "== Rust $RUST_VERSION (Pipeline's rust-toolchain.toml)"
rustup toolchain list | grep -q "^$RUST_VERSION-" || rustup toolchain install "$RUST_VERSION" --profile minimal --component rustfmt,clippy

echo "== cargo-build-sbf $CARGO_BUILD_SBF_VERSION"
CBS="$ROOT/cargo-build-sbf-$CARGO_BUILD_SBF_VERSION"
if ! "$CBS/bin/cargo-build-sbf" --version 2>/dev/null | grep -q "^cargo-build-sbf $CARGO_BUILD_SBF_VERSION$"; then
  build_dir="$(mktemp -d)"
  CARGO_TARGET_DIR="$build_dir" cargo "+$RUST_VERSION" install cargo-build-sbf \
    --version "$CARGO_BUILD_SBF_VERSION" --locked --root "$CBS"
  rm -rf "$build_dir"
fi

echo "== platform tools $SBF_TOOLS_VERSION"
if [ ! -x "$HOME/.cache/solana/$SBF_TOOLS_VERSION/platform-tools/rust/bin/rustc" ]; then
  (cd "$ROOT" && "$CBS/bin/cargo-build-sbf" --install-only --tools-version "$SBF_TOOLS_VERSION")
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

echo "== Agave $AGAVE_VERSION CLI ($AGAVE_TARGET)"
AGAVE="$ROOT/agave-$AGAVE_VERSION"
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

solana_link_after="$(rustup toolchain list -v | awk '$1 == "solana" { print $NF }')"
if [ -n "$solana_link_before" ] && [ "$solana_link_after" != "$solana_link_before" ]; then
  echo "== restoring rustup's solana toolchain link"
  if [ -n "$solana_link_after" ]; then rustup toolchain uninstall solana; fi
  rustup toolchain link solana "$solana_link_before"
fi

echo
echo "Installed in $ROOT:"
"$CBS/bin/cargo-build-sbf" --version | head -1
"$AGAVE/bin/solana" --version
"$AGAVE/bin/solana-test-validator" --version
echo "Platform tools: $SBF_TOOLS_VERSION"
echo "Use it in a shell with: source scripts/toolchain-env.sh"
