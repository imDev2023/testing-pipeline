# The keeper runner for anyone's machine (apps/keeper/README.md, "Docker"): the bundled runner
# on Node 24 (docs/toolchain.md), nothing else. The key is never in the image: it is mounted
# read-only at KEEPER_KEYPAIR's path when the container runs.
#
#   pnpm --filter keeper image       builds dist/keeper.mjs, then this image
FROM node:24.4.1-bookworm-slim@sha256:36ae19f59c91f3303c7a648f07493fe14c4bd91320ac8d898416327bacf1bbfa
WORKDIR /app
COPY dist/keeper.mjs /app/keeper.mjs
ENV NODE_ENV=production \
    KEEPER_KEYPAIR=/keys/keeper.json
USER node
ENTRYPOINT ["node", "/app/keeper.mjs"]
CMD ["run"]
