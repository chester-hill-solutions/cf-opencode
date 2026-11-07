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
 * catch-all asks and hard-coded denials come last so they win.
 *
 * `DENY_COMMANDS` and the credential/SSRF denials are appended regardless of
 * settings. An operator may add denials but cannot remove these: a settings
 * save must not be able to turn the safety policy off.
 */
export function buildPermissionRules(
  lists: PermissionLists = {},
  workspace = "/workspace",
  stateRoot = "/var/lib/aboiteau/state",
): PermissionRule[] {
  const shellDenies = [...(lists.deny ?? [])]
  for (const command of DENY_COMMANDS) {
    if (!shellDenies.includes(command)) shellDenies.push(command)
  }
  // The live state root holds OpenCode's config and provider credentials. It
  // must be denied explicitly: the old `.state` patterns below only covered the
  // legacy layout, so allowlisted readers (`cat *`, `rg *`, …) could read it.
  const state = stateRoot.replace(/\/+$/, "") || "/var/lib/aboiteau/state"
  const stateShellDenies = [
    `*${state}*`,
    "*$HOME*",
    "*${HOME}*",
    "*$XDG_CONFIG_HOME*",
    "*${XDG_CONFIG_HOME}*",
    "*$XDG_DATA_HOME*",
    "*${XDG_DATA_HOME}*",
    // `~` expands to the state root, so any tilde path is harness state.
    "*~*",
  ]
  return [
    { action: "read", resource: `${workspace}/**`, effect: "allow" },
    { action: "edit", resource: `${workspace}/**`, effect: "allow" },
    { action: "webfetch", resource: "*", effect: "allow" },
    { action: "websearch", resource: "*", effect: "allow" },
    ...(lists.allow ?? []).map((resource) => ({ action: "shell", resource, effect: "allow" as const })),
    { action: "shell", resource: "*", effect: "ask" },
    ...(lists.ask ?? []).map((resource) => ({ action: "shell", resource, effect: "ask" as const })),
    { action: "edit", resource: "/**", effect: "ask" },
    ...shellDenies.map((resource) => ({ action: "shell", resource, effect: "deny" as const })),
    // Harness state holds the OpenCode config and provider credentials.
    ...stateShellDenies.map((resource) => ({ action: "shell", resource, effect: "deny" as const })),
    { action: "shell", resource: "*169.254.169.254*", effect: "deny" },
    { action: "shell", resource: "*.state*", effect: "deny" },
    { action: "webfetch", resource: "*169.254.169.254*", effect: "deny" },
    { action: "read", resource: "**/.ssh/**", effect: "deny" },
    { action: "edit", resource: "**/.ssh/**", effect: "deny" },
    { action: "read", resource: "**/.env*", effect: "deny" },
    { action: "edit", resource: "**/.env*", effect: "deny" },
    { action: "read", resource: `${workspace}/.state/**`, effect: "deny" },
    { action: "edit", resource: `${workspace}/.state/**`, effect: "deny" },
    { action: "read", resource: "/**/.state/**", effect: "deny" },
    { action: "edit", resource: "/**/.state/**", effect: "deny" },
    { action: "read", resource: `${state}/**`, effect: "deny" },
    { action: "edit", resource: `${state}/**`, effect: "deny" },
  ]
}
