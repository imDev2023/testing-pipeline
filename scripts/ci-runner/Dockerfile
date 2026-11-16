# A GitHub Actions runner for this repo's CI, on the owner's iMac (docs/toolchain.md, "CI on
# the owner's iMac"). It is Ubuntu 24.04 with what ci.yml's jobs take from GitHub's
# ubuntu-24.04 image: a C toolchain, git, jq, Python with venv, Node 24 and rustup. The
# Solana toolchain, Kani and Z3 are installed by the jobs themselves and stay in the runner's
# home volume between jobs.
FROM ubuntu:24.04@sha256:2198e4c65076e9cb0b3d695219df667c0e3b0072da64ca3c2648aca17dcecaf5

ARG RUNNER_VERSION=2.338.2
ARG RUNNER_SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
ARG NODE_VERSION=24.22.3
ARG RUST_VERSION=1.97.1

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev libudev-dev clang cmake \
      ca-certificates curl git jq sudo unzip xz-utils bzip2 zstd \
      python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/*

# Node 24, checked against nodejs.org's checksum list.
RUN cd /tmp \
 && curl -sSfLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && curl -sSfLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
 && grep " node-v${NODE_VERSION}-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c - \
 && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1 \
 && rm -f node-v*.tar.xz SHASUMS256.txt

# The jobs run as `runner`, with passwordless sudo as on GitHub's runners.
RUN useradd --create-home --uid 1001 --shell /bin/bash runner \
 && echo "runner ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/runner \
 && chmod 0440 /etc/sudoers.d/runner

# GitHub's runner, checked against the release's published digest.
WORKDIR /home/runner/actions-runner
RUN curl -sSfL -o runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
 && echo "${RUNNER_SHA256}  runner.tar.gz" | sha256sum -c - \
 && tar -xzf runner.tar.gz && rm runner.tar.gz \
 && ./bin/installdependencies.sh \
 && rm -rf /var/lib/apt/lists/* \
 && chown -R runner:runner /home/runner

COPY entrypoint.sh /usr/local/bin/ci-runner-entrypoint
USER runner
ENV PATH=/home/runner/.cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
      --default-toolchain "${RUST_VERSION}" --component rustfmt,clippy

ENTRYPOINT ["/usr/local/bin/ci-runner-entrypoint"]
CMD ["run"]
