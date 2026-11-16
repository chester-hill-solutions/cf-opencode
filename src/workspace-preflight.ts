export interface WorkspacePreflight {
  schemaVersion: 1
  mode: "read_only"
  status: "blocked" | "needs_verification"
  repository: { kind: "git" | "none" | "unavailable"; head: string | null; branch: string | null; dirty: boolean | null }
  tools: Array<{ name: string; available: boolean }>
  project: { packageManager: "bun" | "npm" | "pnpm" | "yarn" | null; manifests: string[]; scripts: string[]; guidance: string[]; dependencies: "present" | "missing" | "unknown" }
  suggestions: Array<{ purpose: "setup" | "check"; argv: string[]; requiresApproval: true }>
  findings: Array<{ code: string; severity: "blocker" | "warning" | "info"; message: string }>
  verification: { setup: "not_run"; checks: "not_run" }
}

const scriptName = /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/
export function parseWorkspacePreflight(value: unknown): WorkspacePreflight {
  const object = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid workspace preflight")
    return input as Record<string, unknown>
  }
  const text = (input: unknown, max = 240): string => {
    if (typeof input !== "string" || !input || input.length > max || /[\x00-\x1f\x7f]/.test(input)) {
      throw new Error("invalid workspace preflight string")
    }
    return input
  }
  const choice = <T extends string>(input: unknown, choices: readonly T[]): T => {
    if (!choices.includes(input as T)) throw new Error("invalid workspace preflight choice")
    return input as T
  }
  const list = (input: unknown, max = 64): unknown[] => {
    if (!Array.isArray(input) || input.length > max) throw new Error("invalid workspace preflight list")
    return input
  }
  const names = (input: unknown, pattern: RegExp): string[] => list(input).map(item => {
    const name = text(item, 80)
    if (!pattern.test(name)) throw new Error("invalid workspace preflight name")
    return name
  })
  const body = object(value), repo = object(body.repository), project = object(body.project), verification = object(body.verification)
  if (body.schemaVersion !== 1 || body.mode !== "read_only" || verification.setup !== "not_run" || verification.checks !== "not_run") throw new Error("workspace preflight must remain unverified and read only")
  const head = repo.head === null ? null : text(repo.head, 64)
  const branch = repo.branch === null ? null : text(repo.branch, 200)
  if ((head !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) || (branch !== null && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) || (repo.dirty !== null && typeof repo.dirty !== "boolean")) throw new Error("invalid workspace repository metadata")
  const scripts = names(project.scripts, scriptName)
  const packageManager = project.packageManager === null ? null : choice(project.packageManager, ["bun", "npm", "pnpm", "yarn"] as const)
  const findings = list(body.findings).map(item => {
    const entry = object(item), code = text(entry.code, 64)
    if (!/^[a-z][a-z0-9_]*$/.test(code)) throw new Error("invalid preflight code")
    return { code, severity: choice(entry.severity, ["blocker", "warning", "info"] as const), message: text(entry.message) }
  })
  const status = choice(body.status, ["blocked", "needs_verification"] as const)
  if ((status === "blocked") !== findings.some(item => item.severity === "blocker")) throw new Error("inconsistent workspace preflight status")
  return {
    schemaVersion: 1, mode: "read_only", status,
    repository: { kind: choice(repo.kind, ["git", "none", "unavailable"] as const), head, branch, dirty: repo.dirty },
    tools: list(body.tools, 16).map(item => {
      const tool = object(item), name = text(tool.name, 32)
      if (!/^[a-z][a-z0-9-]*$/.test(name) || typeof tool.available !== "boolean") throw new Error("invalid workspace tool")
      return { name, available: tool.available }
    }),
    project: { packageManager, scripts, manifests: names(project.manifests, /^[A-Za-z][A-Za-z0-9._-]*$/), guidance: names(project.guidance, /^[A-Za-z][A-Za-z0-9._-]*$/), dependencies: choice(project.dependencies, ["present", "missing", "unknown"] as const) },
    suggestions: list(body.suggestions, 16).map(item => {
      const entry = object(item), purpose = choice(entry.purpose, ["setup", "check"] as const), argv = list(entry.argv, 6).map(arg => text(arg, 80))
      if (entry.requiresApproval !== true || !packageManager || argv[0] !== packageManager) throw new Error("unsafe workspace suggestion")
      const setup = new Set(["bun install --frozen-lockfile", "npm ci", "pnpm install --frozen-lockfile", "yarn install --immutable", "yarn install --frozen-lockfile"])
      if (purpose === "setup" ? !setup.has(argv.join(" ")) : argv.length !== 3 || argv[1] !== "run" || !scriptName.test(argv[2]) || !scripts.includes(argv[2])) throw new Error("unsafe workspace suggestion")
      return { purpose, argv, requiresApproval: true }
    }),
    findings, verification: { setup: "not_run", checks: "not_run" },
  }
}
