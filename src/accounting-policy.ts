/** Runtime OpenCode settings required for trustworthy foreground usage replay. */
export const ACCOUNTING_POLICY_ID = "foreground-usage-v1"

export const ACCOUNTING_POLICY_CONFIG = {
  experimental: { background_compaction: false },
  agents: { title: { disabled: true } },
} as const

export const ACCOUNTING_POLICY_CONTENT = JSON.stringify(ACCOUNTING_POLICY_CONFIG)

/** A policy gate is not a transport failure and must not recycle active work. */
export class AccountingPolicyError extends Error {
  constructor(message: string) {
    super(`OpenCode accounting policy is not effective: ${message}`)
    this.name = "AccountingPolicyError"
  }
}

type RecordValue = Record<string, unknown>

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function policyError(message: string): Error {
  return new AccountingPolicyError(message)
}

/**
 * Check config.get's ordered entries using the same precedence rules as the
 * v2.2.5 compaction and agent config plugins.
 */
export function assertAccountingPolicy(entries: unknown): void {
  if (!Array.isArray(entries)) throw policyError("config entries are not an array")

  let backgroundCompaction: boolean | undefined
  let titleDisabled: boolean | undefined

  for (const [index, entry] of entries.entries()) {
    if (!record(entry)) throw policyError(`entry ${index} is not an object`)
    if (entry.type === "directory") {
      if (typeof entry.path !== "string") throw policyError(`directory entry ${index} has no path`)
      continue
    }
    if (entry.type !== "document" || !record(entry.info)) {
      throw policyError(`entry ${index} is not a config document or directory`)
    }

    const info = entry.info
    if (Object.hasOwn(info, "experimental")) {
      if (!record(info.experimental)) throw policyError(`document ${index} has malformed experimental config`)
      const enabled = info.experimental.background_compaction
      if (enabled !== undefined && typeof enabled !== "boolean") {
        throw policyError(`document ${index} has malformed background_compaction setting`)
      }
      // Config.latest selects the last document that defines the experimental
      // object; the plugin enables precompute only for literal true.
      backgroundCompaction = enabled === true
    }

    if (Object.hasOwn(info, "agents")) {
      if (!record(info.agents)) throw policyError(`document ${index} has malformed agents config`)
      if (Object.hasOwn(info.agents, "title")) {
        const title = info.agents.title
        if (!record(title)) throw policyError(`document ${index} has malformed title agent config`)
        const disabled = title.disabled
        if (disabled !== undefined && typeof disabled !== "boolean") {
          throw policyError(`document ${index} has malformed title disabled setting`)
        }
        // ConfigAgentPlugin processes documents in order: disabled removes the
        // agent; a later title entry updates/recreates it unless disabled too.
        titleDisabled = disabled === true
      }
    }
  }

  if (backgroundCompaction !== false) {
    throw policyError("experimental.background_compaction is enabled or missing")
  }
  if (titleDisabled !== true) throw policyError("the title agent is enabled or missing its disable rule")
}
