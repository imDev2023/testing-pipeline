# syntax=docker/dockerfile:1
# Canary's container image (docs/spec/pipescope-architecture.md, "Canary runner"; CANARY-24):
# the binary alone, serving `POST /run` on port 8080 for the `CanaryContainer` Durable Object in
# `apps/terminal-api`. linux/amd64 keeps the sBPF JIT that Canary was measured with on x86_64.
# The container never reaches the network (`enableInternet = false` in
# apps/terminal-api/src/canaryContainer.ts) and holds no RPC key: every account it reads comes in
# the snapshot `CanaryRun` posts.
#
# Built from `crates/` as its context (wrangler.jsonc's `image_build_context`), so the workspace's
# lock file pins every crate:
#   docker build --platform linux/amd64 -f crates/canary/Dockerfile crates

FROM rust:1.97.1-slim-bookworm AS build
WORKDIR /src
# Not rust-toolchain.toml: the image is that toolchain already, and the file's rustfmt and clippy
# are for development only.
COPY Cargo.toml Cargo.lock ./
COPY canary/Cargo.toml canary/Cargo.toml
COPY canary/src canary/src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p canary --bin canary \
    && cp target/release/canary /canary

# glibc and libgcc, nothing else: no shell, no package manager, no curl.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /canary /usr/local/bin/canary
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/canary", "serve", "--listen", "0.0.0.0:8080"]
