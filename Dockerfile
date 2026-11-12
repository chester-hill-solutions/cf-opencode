# OpenCode harness container.
#
# Trust split: the control server runs as root; OpenCode, stow-s3 and every
# process that touches user files run as the unprivileged `agent` user. Harness
# state lives in /var/lib/aboiteau/state, outside the agent's workspace.
#
# Hot workspace: stow-s3 serves /workspace as a local S3 endpoint on :9000.
# Cold storage: the Durable Object streams tar checkpoints to R2.
#
# Pins:
#   base image       — oven/bun:1.3 pinned by manifest-list digest
#   @opencode/server — locked to the client contract the Worker is built against
#   STOW_VERSION     — native stow-s3 release used for the local S3 workspace
#
# OpenCode's event-persistent server is installed as an isolated, locked runtime
# package. The control plane remains in the root Bun application.

FROM oven/bun:1.3@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

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
RUN cd /app/runtime/opencode && bun install --production --frozen-lockfile
COPY runtime/opencode/server.ts runtime/opencode/options.ts ./runtime/opencode/
COPY src/permissions.ts ./src/permissions.ts
COPY src/control-auth.ts ./src/control-auth.ts
COPY src/tar.ts ./src/tar.ts
COPY src/accounting-policy.ts ./src/accounting-policy.ts
RUN chmod +x entrypoint.sh

# State paths are fixed here and exported by entrypoint.sh. They are deliberately
# not under /workspace, so a repo checkout cannot overwrite harness config.
ENV ABOITEAU_STATE_DIR=/var/lib/aboiteau/state \
    ABOITEAU_RUN_DIR=/var/lib/aboiteau/run \
    AGENT_UID=1001 \
    AGENT_GID=1001 \
    STOW_ACCESS_KEY=stow \
    STOW_SECRET_KEY=stow-secret

RUN mkdir -p /workspace "${ABOITEAU_STATE_DIR}" "${ABOITEAU_RUN_DIR}" \
    && chown -R agent:agent /workspace \
    && chown -R root:agent "${ABOITEAU_STATE_DIR}" \
    && chmod 0770 "${ABOITEAU_STATE_DIR}" \
    && chmod 0700 "${ABOITEAU_RUN_DIR}"

EXPOSE 4000 4001 9000
CMD ["./entrypoint.sh"]
