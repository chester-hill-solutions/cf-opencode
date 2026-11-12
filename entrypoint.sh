#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${WORKSPACE:-/workspace}"
STATE_ROOT="${ABOITEAU_STATE_DIR:-/var/lib/aboiteau/state}"
RUN_DIR="${ABOITEAU_RUN_DIR:-/var/lib/aboiteau/run}"
AGENT_UID="${AGENT_UID:-1001}"
AGENT_GID="${AGENT_GID:-1001}"

# Harness state is outside the workspace: OpenCode writes it as the agent user
# through the group, while the repo cannot touch it.
export HOME="$STATE_ROOT"
export XDG_DATA_HOME="$STATE_ROOT/data"
export XDG_CONFIG_HOME="$STATE_ROOT/config"
export XDG_CACHE_HOME="$STATE_ROOT/cache"

mkdir -p "$WORKSPACE" "$HOME" "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$RUN_DIR"

# Workspace: owned outright by the agent. Native workspace metadata is created
# only after the control server has verified that this path is fresh or restored.
chown -R "$AGENT_UID:$AGENT_GID" "$WORKSPACE"

# State: the top-level directory is root-owned and only the agent group can
# enter it. Its contents belong to the agent because OpenCode owns its database.
chown root:"$AGENT_GID" "$STATE_ROOT"
chmod 0770 "$STATE_ROOT"
find "$STATE_ROOT" -mindepth 1 -exec chown "$AGENT_UID:$AGENT_GID" {} +
find "$STATE_ROOT" -mindepth 1 -type d -exec chmod 0770 {} +
find "$STATE_ROOT" -mindepth 1 -type f -exec chmod 0660 {} +
chmod 0700 "$RUN_DIR"

# The control server restores the R2 checkpoint (or clones the configured repo)
# and writes the OpenCode config from the DO's /configure call before starting.
exec bun /app/control-server.ts
