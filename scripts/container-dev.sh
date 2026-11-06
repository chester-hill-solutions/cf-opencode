#!/usr/bin/env bash
set -euo pipefail

# Build and run the harness container with Apple's `container` (no Docker).
#
#   scripts/container-dev.sh build
#   scripts/container-dev.sh run
#   scripts/container-dev.sh stop
#
# Requires macOS 26+ on Apple silicon, `container` installed and started.
# Install: https://github.com/apple/container/releases

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-opencode-harness:dev}"
NAME="${NAME:-opencode-harness}"
MODEL="${OPENCODE_MODEL:-opencode/deepseek-v4.1-flash}"
REPO="${WORKSPACE_REPO:-https://github.com/chester-hill-solutions/opencode-slack}"

if ! command -v container >/dev/null 2>&1; then
  echo "Apple container is not installed: https://github.com/apple/container/releases" >&2
  exit 1
fi

case "${1:-}" in
  build)
    container build -t "$IMAGE" "$ROOT"
    ;;
  run)
    container run --rm --name "$NAME" \
      -p 4000:4000 -p 4001:4001 -p 9000:9000 \
      -e "OPENCODE_MODEL=$MODEL" \
      -e "WORKSPACE_REPO=$REPO" \
      "$IMAGE"
    ;;
  stop)
    container stop "$NAME"
    ;;
  *)
    echo "usage: $0 build|run|stop" >&2
    exit 1
    ;;
esac
