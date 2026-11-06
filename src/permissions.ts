/**
 * Permission policy shared by the Worker and the container.
 *
 * The container writes these rules into OpenCode's config (last match wins).
 * Reads/edits inside the workspace and web access are allowed; shell commands
 * are allowed only when they match the configured safe list, otherwise they ask
 * through the Slack approval buttons. Destructive commands are denied outright.
 */

export type PermissionEffect = "allow" | "ask" | "deny"

export interface PermissionRule {
  action: string
  resource: string
  effect: PermissionEffect
}

/** Settings-supplied shell patterns. */
export interface PermissionLists {
  allow?: string[]
  ask?: string[]
  deny?: string[]
}

/** Read-only / build commands that do not need a Slack round trip. */
export const SAFE_COMMANDS = [
  "ls",
  "cat",
  "head",
  "tail",
  "rg",
  "find",
  "pwd",
  "jq",
  "wc",
  "file",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "bun test",
  "bun run typecheck",
  "node --version",
] as const

/** Commands that must never run, even with an "always allow". */
export const DENY_COMMANDS = [
  "sudo *",
  "rm -rf *",
  "git push --force*",
  "git reset --hard*",
  "chmod 777 *",
  "curl * | sh",
  "curl * | bash",
  "wget * | sh",
] as const

/**
 * Build the complete rule list for the container config. Order matters: the
 * catch-all asks and configured denials come last so they win.
 */
export function buildPermissionRules(lists: PermissionLists = {}, workspace = "/workspace"): PermissionRule[] {
  return [
    { action: "read", resource: `${workspace}/**`, effect: "allow" },
    { action: "edit", resource: `${workspace}/**`, effect: "allow" },
    { action: "webfetch", resource: "*", effect: "allow" },
    { action: "websearch", resource: "*", effect: "allow" },
    ...(lists.allow ?? []).map((resource) => ({ action: "shell", resource, effect: "allow" as const })),
    { action: "shell", resource: "*", effect: "ask" },
    ...(lists.ask ?? []).map((resource) => ({ action: "shell", resource, effect: "ask" as const })),
    { action: "edit", resource: "/**", effect: "ask" },
    ...(lists.deny ?? []).map((resource) => ({ action: "shell", resource, effect: "deny" as const })),
    { action: "shell", resource: "*169.254.169.254*", effect: "deny" },
    { action: "read", resource: "**/.ssh/**", effect: "deny" },
    { action: "read", resource: "**/.env", effect: "deny" },
  ]
}
