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
CHECKPOINT="/tmp/cf-opencode-checkpoint.tar.gz"

now() { python3 -c 'import time; print(int(time.time() * 1000))'; }

case "$RUNTIME" in
  container)
    command -v container >/dev/null || { echo "Apple container is not installed"; exit 1; }
    container build -t "$IMAGE" "$ROOT"
    container run -d --name "$NAME" -p "${CONTROL_PORT}:4001" -p 4000:4000 -p "${STOW_PORT}:9000" "$IMAGE" >/dev/null
    stop() { container stop "$NAME" >/dev/null 2>&1 || true; }
    ;;
  docker)
    command -v docker >/dev/null || { echo "docker is not installed"; exit 1; }
    docker build -t "$IMAGE" "$ROOT"
    docker run -d --name "$NAME" -p "${CONTROL_PORT}:4001" -p 4000:4000 -p "${STOW_PORT}:9000" "$IMAGE" >/dev/null
    stop() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
    ;;
  *)
    echo "RUNTIME must be container or docker" >&2
    exit 1
    ;;
esac

trap stop EXIT

start=$(now)
until curl -fsS "http://127.0.0.1:${CONTROL_PORT}/health" >/dev/null 2>&1; do sleep 0.2; done
echo "cold start (container → control /health): $(( $(now) - start )) ms"

start=$(now)
curl -fsS -X POST "http://127.0.0.1:${CONTROL_PORT}/start" >/dev/null
echo "start (stow-s3 + opencode serve): $(( $(now) - start )) ms"

curl -fsS "http://127.0.0.1:${STOW_PORT}/_stow/health" >/dev/null && echo "local S3: healthy"

start=$(now)
curl -fsS "http://127.0.0.1:${CONTROL_PORT}/checkpoint" -o "$CHECKPOINT"
echo "checkpoint: $(( $(now) - start )) ms, $(du -h "$CHECKPOINT" | cut -f1)"

start=$(now)
curl -fsS -X POST --data-binary "@${CHECKPOINT}" "http://127.0.0.1:${CONTROL_PORT}/restore" >/dev/null
echo "restore: $(( $(now) - start )) ms"
