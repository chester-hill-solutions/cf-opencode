#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${WORKSPACE:-/workspace}"
mkdir -p "$WORKSPACE" "$HOME" "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

# The control server restores the R2 checkpoint (or clones the configured repo)
# and writes the OpenCode config from the DO's /configure call before starting.
exec bun /app/control-server.ts
