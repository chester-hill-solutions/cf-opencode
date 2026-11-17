# syntax=docker/dockerfile:1.7.1
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

FROM --platform=$BUILDPLATFORM golang:1.25.6-bookworm@sha256:f4490d7b261d73af4543c46ac6597d7d101b6e1755bcdd8c5159fda7046b6b3e AS stow-builder
WORKDIR /src
ADD --checksum=sha256:387c91bcf9f9a4ac2691fbf980885ccfb88e6eaf7b3732681e75a2eca2b1adc8 https://codeload.github.com/chester-hill-solutions/stow-s3/tar.gz/3bb3e890bbe56f11dd783c2ccfb9bd2813156919 /tmp/stow-source.tar.gz
RUN tar -xzf /tmp/stow-source.tar.gz --strip-components=1 \
      --wildcards '*/go.mod' '*/go.sum' '*/cmd/*' '*/internal/*' '*/pkg/*' \
    && rm /tmp/stow-source.tar.gz
COPY patches/stow/metadata-refusal_test.go internal/s3api/metadata_refusal_test.go
# Verify that the regression reaches the original silent-success bug, rather
# than treating a compilation or environment error as an expected failing test.
RUN if GOMAXPROCS=2 go test -p 2 ./internal/s3api -run '^TestSDKUnsupportedObjectMetadataRefusedBeforeMutation$' > /tmp/baseline.log 2>&1; then \
      cat /tmp/baseline.log; exit 1; \
    else cat /tmp/baseline.log; grep -F 'want typed 501 NotImplemented, got <nil>' /tmp/baseline.log; fi
COPY patches/stow/metadata-refusal.patch /tmp/stow-metadata.patch
RUN git apply --check /tmp/stow-metadata.patch \
    && git apply /tmp/stow-metadata.patch \
    && GOMAXPROCS=2 go test -p 2 ./internal/s3api
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} GOMAXPROCS=2 \
    go build -p 2 -buildvcs=false -trimpath -ldflags '-s -w' -o /out/stow-s3 ./cmd/stow-s3

FROM oven/bun:1.3-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq openssl ripgrep sqlite3 tar util-linux \
      python3 python3-openpyxl csvkit unzip zip xz-utils less file tree \
    && groupadd --gid 1001 agent \
    && useradd --uid 1001 --gid agent --create-home --shell /bin/bash agent \
    && rm -rf /var/lib/apt/lists/*

ARG STOW_VERSION=0.4.0
COPY --from=stow-builder /out/stow-s3 /usr/local/bin/stow-s3

WORKDIR /app
COPY control-server.ts entrypoint.sh ./
COPY workspace-preflight.ts ./workspace-preflight.ts
COPY workspace-repository.ts ./workspace-repository.ts
COPY workspace-check-snapshot.ts ./workspace-check-snapshot.ts
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
COPY src/workspace-preflight.ts ./src/workspace-preflight.ts
COPY src/workspace-repository.ts ./src/workspace-repository.ts
COPY src/workspace-check-snapshot.ts ./src/workspace-check-snapshot.ts
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
