# OpenCode harness container.
#
# Trust split: the control server runs as root for the synthetic empty Workspace
# prepare and state coordination. Native Stow serving, OpenCode and user-file
# operations run as `agent`. Harness state lives outside the agent workspace.
#
# Hot workspace: stow-s3 serves the native /workspace as a local S3 endpoint.
# Cold storage: the Durable Object streams tar checkpoints to R2.
#
# Pins:
#   base image       — oven/bun:1.3-slim pinned by manifest-list digest
#   @opencode/server — locked to the client contract the Worker is built against
#   STOW_VERSION     — native stow-s3 release used for the local S3 workspace
#
# OpenCode's event-persistent server is installed as an isolated, locked runtime
# package. The control plane remains in the root Bun application.

FROM oven/bun:1.3-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq openssl ripgrep sqlite3 tar util-linux \
    && groupadd --gid 1001 agent \
    && useradd --uid 1001 --gid agent --create-home --shell /bin/bash agent \
    && rm -rf /var/lib/apt/lists/*

ARG STOW_VERSION=0.3.7
ARG TARGETARCH
RUN cd /tmp \
    && curl -fsSL -o "stow-linux-${TARGETARCH}.tar.gz" \
      "https://github.com/chester-hill-solutions/stow-s3/releases/download/v${STOW_VERSION}/stow-linux-${TARGETARCH}.tar.gz" \
    && curl -fsSL -o SHA256SUMS.txt \
      "https://github.com/chester-hill-solutions/stow-s3/releases/download/v${STOW_VERSION}/SHA256SUMS.txt" \
    && grep " stow-linux-${TARGETARCH}.tar.gz$" SHA256SUMS.txt | sha256sum -c - \
    && tar -xzf "stow-linux-${TARGETARCH}.tar.gz" -C /usr/local/bin stow-s3 \
    && chmod +x /usr/local/bin/stow-s3 \
    && rm -f "stow-linux-${TARGETARCH}.tar.gz" SHA256SUMS.txt

WORKDIR /app
COPY control-server.ts entrypoint.sh ./
COPY runtime/opencode/package.json runtime/opencode/bun.lock ./runtime/opencode/
# Install and prune in one layer: a later RUN cannot shrink an earlier layer, and
# Bun hardlinks node_modules to its install cache. Removing the cache here leaves
# only the pruned runtime files. Types, source maps, package docs and Effect's TS
# sources are not read by the server; musl prebuilds are dead on this glibc base.
# This measured 416 MB -> ~217 MB of runtime files with the server still booting.
RUN cd /app/runtime/opencode \
    && bun install --production --frozen-lockfile \
    && cd node_modules \
    && find . -type f \( -name '*.d.ts' -o -name '*.map' -o -name '*.md' \) \
         ! -iname 'license*' ! -iname 'copying*' ! -iname 'notice*' -delete \
    && rm -rf effect/src effect/ai-docs \
    && find . -type d \( -name '*-musl' -o -name '*-musl-*' \) -prune -exec rm -rf {} + \
    && rm -rf /root/.bun/install/cache /root/.bun/install/global
COPY runtime/opencode/server.ts runtime/opencode/options.ts ./runtime/opencode/
COPY src/permissions.ts ./src/permissions.ts
COPY src/control-auth.ts ./src/control-auth.ts
COPY src/tar.ts ./src/tar.ts
COPY src/accounting-policy.ts ./src/accounting-policy.ts
COPY stow-workspace.ts ./stow-workspace.ts
COPY control-lifecycle.ts ./control-lifecycle.ts
RUN chmod +x entrypoint.sh

# State paths are fixed here and exported by entrypoint.sh. They are deliberately
# not under /workspace, so a repo checkout cannot overwrite harness config.
ENV ABOITEAU_STATE_DIR=/var/lib/aboiteau/state \
    ABOITEAU_RUN_DIR=/var/lib/aboiteau/run \
    AGENT_UID=1001 \
    AGENT_GID=1001

RUN mkdir -p /workspace "${ABOITEAU_STATE_DIR}" "${ABOITEAU_RUN_DIR}" \
    && chown -R agent:agent /workspace \
    && chown -R root:agent "${ABOITEAU_STATE_DIR}" \
    && chmod 0770 "${ABOITEAU_STATE_DIR}" \
    && chmod 0700 "${ABOITEAU_RUN_DIR}"

EXPOSE 4000 4001
CMD ["./entrypoint.sh"]
