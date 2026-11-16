import { visibleFields, type Form } from "./slack-forms"

/**
 * Caller-facing pending interactions (R1-4a D4).
 *
 * Permissions already live in state as request ids; questions live in the
 * runtime until answered. The projection is pure so the HTTP route, and later
 * the MCP `questions` tool, describe them the same way.
 */

export interface PendingQuestion {
  id: string
  kind: "permission" | "question"
  prompt: string
  options: string[]
  /** Turn that is blocked on this answer, when one is active. */
  turnID?: string
}

/** The three decisions the existing permission route already accepts. */
export const PERMISSION_OPTIONS = ["once", "always", "reject"] as const

export interface PendingInteractionSummary {
  id: string
  action: string
  resources: string[]
}

function permissionPrompt(permission: PendingInteractionSummary): string {
  const resources = permission.resources.filter(Boolean)
  return resources.length
    ? `${permission.action}: ${resources.join(", ")}`
    : permission.action
}

function formOptions(form: Form): string[] {
  const options = visibleFields(form).flatMap((field) => field.options?.map((option) => option.value) ?? [])
  // A free-text question has no enumerated answer; naming its fields is more
  // useful to a caller than reporting an empty option list.
  return options.length ? options : visibleFields(form).map((field) => field.key)
}

export function projectQuestions(input: {
  forms?: Form[]
  permissions?: PendingInteractionSummary[]
  turnID?: string
}): PendingQuestion[] {
  const turn = input.turnID ? { turnID: input.turnID } : {}
  const forms = (input.forms ?? []).map((form) => ({
    id: form.id,
    kind: "question" as const,
    prompt: form.title,
    options: formOptions(form),
    ...turn,
  }))
  const permissions = (input.permissions ?? []).map((permission) => ({
    id: permission.id,
    kind: "permission" as const,
    prompt: permissionPrompt(permission),
    options: [...PERMISSION_OPTIONS],
    ...turn,
  }))
  // A form id and a permission id are both runtime-owned UUIDs; a duplicate
  // would mean the same interaction was reported twice, so keep the first.
  const seen = new Set<string>()
  return [...forms, ...permissions].filter((question) => {
    if (seen.has(question.id)) return false
    seen.add(question.id)
    return true
  })
}
