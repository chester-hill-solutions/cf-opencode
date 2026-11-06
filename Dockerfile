# OpenCode harness container.
#
# Hot workspace: stow-s3 serves /workspace as a local S3 endpoint on :9000.
# Cold storage: the Durable Object streams tar checkpoints to R2.
#
# Pins:
#   OPENCODE_VERSION — must match the client contract the Worker is built against
#   STOW_VERSION     — native stow-s3 release used for the local S3 workspace

FROM oven/bun:1.3

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep sqlite3 tar \
    && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION=2.2.1
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version "${OPENCODE_VERSION}" \
    && mv /root/.opencode/bin/opencode /usr/local/bin/opencode

ARG STOW_VERSION=0.3.3
RUN curl -fsSL -o /usr/local/bin/stow-s3 \
      "https://github.com/chester-hill-solutions/stow-s3/releases/download/v${STOW_VERSION}/stow-s3-linux-amd64" \
    && chmod +x /usr/local/bin/stow-s3

WORKDIR /app
COPY control-server.ts entrypoint.sh ./
COPY src/permissions.ts ./src/permissions.ts
RUN chmod +x entrypoint.sh

ENV HOME=/workspace/.state \
    XDG_DATA_HOME=/workspace/.state/data \
    XDG_CONFIG_HOME=/workspace/.state/config \
    XDG_CACHE_HOME=/workspace/.state/cache \
    STOW_DIR=/workspace/.stow \
    STOW_ACCESS_KEY=stow \
    STOW_SECRET_KEY=stow-secret

EXPOSE 4000 4001 9000
CMD ["./entrypoint.sh"]
