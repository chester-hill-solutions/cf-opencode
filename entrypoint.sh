#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${WORKSPACE:-/workspace}"
mkdir -p "$WORKSPACE" "$HOME" "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

# The control server restores the R2 checkpoint (or clones WORKSPACE_REPO on a
# first boot) before starting OpenCode, so the workspace is untouched here.

# Smart-allow permissions (kept in sync with workers/src/permissions.ts).
cat > "$XDG_CONFIG_HOME/opencode/opencode.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "{env:OPENCODE_MODEL}",
  "permissions": [
    { "action": "read", "resource": "/workspace/**", "effect": "allow" },
    { "action": "edit", "resource": "/workspace/**", "effect": "allow" },
    { "action": "webfetch", "resource": "*", "effect": "allow" },
    { "action": "websearch", "resource": "*", "effect": "allow" },
    { "action": "shell", "resource": "ls *", "effect": "allow" },
    { "action": "shell", "resource": "cat *", "effect": "allow" },
    { "action": "shell", "resource": "head *", "effect": "allow" },
    { "action": "shell", "resource": "tail *", "effect": "allow" },
    { "action": "shell", "resource": "rg *", "effect": "allow" },
    { "action": "shell", "resource": "find *", "effect": "allow" },
    { "action": "shell", "resource": "pwd", "effect": "allow" },
    { "action": "shell", "resource": "jq *", "effect": "allow" },
    { "action": "shell", "resource": "wc *", "effect": "allow" },
    { "action": "shell", "resource": "file *", "effect": "allow" },
    { "action": "shell", "resource": "git status *", "effect": "allow" },
    { "action": "shell", "resource": "git diff *", "effect": "allow" },
    { "action": "shell", "resource": "git log *", "effect": "allow" },
    { "action": "shell", "resource": "git show *", "effect": "allow" },
    { "action": "shell", "resource": "git branch *", "effect": "allow" },
    { "action": "shell", "resource": "bun test *", "effect": "allow" },
    { "action": "shell", "resource": "bun run typecheck *", "effect": "allow" },
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "edit", "resource": "/**", "effect": "ask" },
    { "action": "shell", "resource": "sudo *", "effect": "deny" },
    { "action": "shell", "resource": "rm -rf *", "effect": "deny" },
    { "action": "shell", "resource": "git push --force*", "effect": "deny" },
    { "action": "shell", "resource": "git reset --hard*", "effect": "deny" },
    { "action": "shell", "resource": "chmod 777 *", "effect": "deny" },
    { "action": "read", "resource": "**/.ssh/**", "effect": "deny" },
    { "action": "read", "resource": "**/.env", "effect": "deny" }
  ]
}
JSON

exec bun /app/control-server.ts
