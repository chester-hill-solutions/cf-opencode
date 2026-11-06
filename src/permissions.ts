/**
 * "Smart allow" permission policy for the containerised OpenCode.
 *
 * Rules are written into the container's opencode config (last match wins).
 * Reads/edits inside the workspace and web access are allowed; shell commands
 * are allowed only when they match the safe list, otherwise they ask through
 * the Slack approval buttons. Destructive commands are denied outright.
 */

export type PermissionEffect = "allow" | "ask" | "deny"

export interface PermissionRule {
  action: string
  resource: string
  effect: PermissionEffect
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

export function smartAllowRules(workspace = "/workspace"): PermissionRule[] {
  return [
    { action: "read", resource: `${workspace}/**`, effect: "allow" },
    { action: "edit", resource: `${workspace}/**`, effect: "allow" },
    { action: "webfetch", resource: "*", effect: "allow" },
    { action: "websearch", resource: "*", effect: "allow" },
    ...SAFE_COMMANDS.map((command) => ({ action: "shell", resource: `${command} *`, effect: "allow" as const })),
    { action: "shell", resource: "*", effect: "ask" },
    { action: "edit", resource: "/**", effect: "ask" },
    ...DENY_COMMANDS.map((command) => ({ action: "shell", resource: command, effect: "deny" as const })),
    { action: "shell", resource: "*169.254.169.254*", effect: "deny" },
    { action: "read", resource: "**/.ssh/**", effect: "deny" },
    { action: "read", resource: "**/.env", effect: "deny" },
  ]
}

/**
 * Whether a shell command is safe to run without asking. Conservative: any
 * shell metacharacter, redirection or unknown binary makes it ask.
 */
export function isSafeShellCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  if (/[;&|`$<>\n]/.test(trimmed)) return false
  if (/\b(sudo|rm|mv|cp|chmod|chown|dd|mkfs|shutdown|reboot)\b/.test(trimmed)) return false

  const normalized = trimmed.replace(/\s+/g, " ")
  return SAFE_COMMANDS.some(
    (safe) => normalized === safe || normalized.startsWith(`${safe} `),
  )
}
