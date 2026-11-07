#!/usr/bin/env bash
set -euo pipefail

# Container-side measurements: cold start, checkpoint size/time, restore time.
#
#   bench/container.sh                 # Apple container
#   RUNTIME=docker bench/container.sh  # Docker-compatible engine
#
# Requires a built image or a working runtime; nothing here touches Cloudflare.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${RUNTIME:-container}"
IMAGE="${IMAGE:-cf-opencode:dev}"
NAME="${NAME:-cf-opencode-bench}"
CONTROL_PORT="${CONTROL_PORT:-4001}"
STOW_PORT="${STOW_PORT:-9000}"
CONTROL_TOKEN="${CONTROL_TOKEN:-bench-control-token}"
CHECKPOINT="/tmp/cf-opencode-checkpoint.tar.gz"

now() { python3 -c 'import time; print(int(time.time() * 1000))'; }

REPO_ENV=(--env "CONTROL_TOKEN=${CONTROL_TOKEN}")
if [ -n "${WORKSPACE_REPO:-}" ]; then REPO_ENV+=(--env "WORKSPACE_REPO=${WORKSPACE_REPO}"); fi
if [ -n "${WORKSPACE_BRANCH:-}" ]; then REPO_ENV+=(--env "WORKSPACE_BRANCH=${WORKSPACE_BRANCH}"); fi

case "$RUNTIME" in
  container)
    command -v container >/dev/null || { echo "Apple container is not installed"; exit 1; }
    container build -t "$IMAGE" "$ROOT"
    container run -d --name "$NAME" "${REPO_ENV[@]}" -p "${CONTROL_PORT}:4001" -p 4000:4000 -p "${STOW_PORT}:9000" "$IMAGE" >/dev/null
    stop() { container stop "$NAME" >/dev/null 2>&1 || true; }
    s3_health() { container exec "$NAME" curl -fsS "http://127.0.0.1:9000/_stow/health"; }
    ;;
  docker)
    command -v docker >/dev/null || { echo "docker is not installed"; exit 1; }
    docker build -t "$IMAGE" "$ROOT"
    docker run -d --name "$NAME" "${REPO_ENV[@]}" -p "${CONTROL_PORT}:4001" -p 4000:4000 -p "${STOW_PORT}:9000" "$IMAGE" >/dev/null
    stop() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
    s3_health() { docker exec "$NAME" curl -fsS "http://127.0.0.1:9000/_stow/health"; }
    ;;
  *)
    echo "RUNTIME must be container or docker" >&2
    exit 1
    ;;
esac

trap stop EXIT

AUTH=(-H "authorization: Bearer ${CONTROL_TOKEN}")

start=$(now)
until curl -fsS "http://127.0.0.1:${CONTROL_PORT}/health" >/dev/null 2>&1; do sleep 0.2; done
echo "cold start (container → control /health): $(( $(now) - start )) ms"

start=$(now)
curl -fsS "${AUTH[@]}" -X POST "http://127.0.0.1:${CONTROL_PORT}/start" >/dev/null
echo "start (stow-s3 + opencode serve): $(( $(now) - start )) ms"

# stow binds loopback inside the container; the host-mapped port cannot reach it.
if s3_health >/dev/null 2>&1; then echo "local S3: healthy (inside container)"; else echo "local S3: unreachable"; fi

HEADERS="/tmp/cf-opencode-checkpoint.headers"
start=$(now)
curl -fsS "${AUTH[@]}" -D "$HEADERS" "http://127.0.0.1:${CONTROL_PORT}/checkpoint" -o "$CHECKPOINT"
echo "checkpoint: $(( $(now) - start )) ms, $(du -h "$CHECKPOINT" | cut -f1)"
fingerprint=$(awk 'tolower($1)=="x-workspace-fingerprint:"{print $2}' "$HEADERS" | tr -d '\r')

# Checkpointing archives the workspace without stopping OpenCode. Restart anyway
# to measure a warm start, then prove an unchanged workspace takes the 204 path.
start=$(now)
curl -fsS "${AUTH[@]}" -X POST "http://127.0.0.1:${CONTROL_PORT}/start" >/dev/null
echo "restart after checkpoint: $(( $(now) - start )) ms"
if [ -n "$fingerprint" ]; then
  start=$(now)
  code=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "http://127.0.0.1:${CONTROL_PORT}/checkpoint?since=${fingerprint}")
  echo "checkpoint (unchanged): ${code} in $(( $(now) - start )) ms"
fi

start=$(now)
curl -fsS "${AUTH[@]}" -X POST --data-binary "@${CHECKPOINT}" "http://127.0.0.1:${CONTROL_PORT}/restore" >/dev/null
echo "restore: $(( $(now) - start )) ms"
