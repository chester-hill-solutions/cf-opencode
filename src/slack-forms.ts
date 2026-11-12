/**
 * Rendering and parsing for OpenCode `form` questions.
 *
 * The agent can ask a question and block on the answer (`session.form.*`).
 * Permission prompts already had buttons; questions had no Slack surface at
 * all, so a run would sit waiting with nothing to click. These helpers are pure
 * so the card and the `!answer` parser can be tested without Slack/OpenCode.
 */

import { mrkdwnEscape } from "./adapters/slack"

export interface FormOption {
  value: string
  label: string
  description?: string
}

export interface FormField {
  key: string
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external" | string
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  options?: FormOption[]
  minimum?: number | "Infinity" | "-Infinity" | "NaN"
  maximum?: number | "Infinity" | "-Infinity" | "NaN"
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  placeholder?: string
  url?: string
}

export interface Form {
  id: string
  sessionID?: string
  title: string
  fields: FormField[]
}

export type FormValue = string | number | boolean | string[]
export type FormAnswer = Record<string, FormValue>

export function visibleFields(form: Form): FormField[] {
  return form.fields.filter((field) => !field.hidden)
}

function fieldLabel(field: FormField): string {
  return field.title ?? field.key
}

function describeOptions(field: FormField): string {
  const options = field.options ?? []
  if (options.length === 0) return ""
  const rendered = options
    .map((option, index) => `${index + 1}) \`${mrkdwnEscape(option.value)}\` ${mrkdwnEscape(option.label)}`)
    .join(" · ")
  return `\n   options: ${rendered}`
}

/** Human-readable question card, used both for `form.created` and `!answer` with no argument. */
export function describeForm(form: Form): string {
  const fields = visibleFields(form)
  const lines = [`❓ *${mrkdwnEscape(form.title)}*`]
  for (const field of fields) {
    const flags = [field.type, field.required ? "required" : "optional"].join(", ")
    lines.push(`• \`${field.key}\` — *${mrkdwnEscape(fieldLabel(field))}* _(${flags})_`)
    if (field.description) lines.push(`   ${mrkdwnEscape(field.description)}`)
    const options = describeOptions(field)
    if (options) lines.push(options)
  }
  return lines.join("\n")
}

/** How to answer this particular form, appended to the card. */
export function answerHint(form: Form): string {
  const fields = visibleFields(form)
  if (fields.length === 1 && (fields[0]?.options?.length ?? 0) > 0) {
    return "Reply `!answer <option>`, or `!cancel` to skip the question."
  }
  if (fields.length === 1 && fields[0]?.type === "boolean") {
    return "Reply `!answer yes` or `!answer no`, or `!cancel` to skip the question."
  }
  if (fields.length === 1) {
    return `Reply \`!answer <${fields[0]?.key} value>\`, or \`!cancel\` to skip the question.`
  }
  return "Reply `!answer key=value, key=value`, or `!cancel` to skip the question."
}

export interface FormButton {
  text: string
  value: string
  style?: "primary" | "danger"
}

/**
 * Buttons for a form that a single tap can answer: one visible field with
 * options, or one boolean field. Multi-field forms need `!answer key=value`.
 */
export function formButtons(form: Form, limit = 10): FormButton[] {
  const fields = visibleFields(form)
  if (fields.length !== 1) return []
  const field = fields[0]
  if (!field) return []

  if (field.type === "boolean") {
    return [
      { text: "Yes", value: JSON.stringify({ field: field.key, value: true }), style: "primary" },
      { text: "No", value: JSON.stringify({ field: field.key, value: false }), style: "danger" },
    ]
  }
  const options = field.options ?? []
  return options.slice(0, limit).map((option) => ({
    text: truncate(option.label || option.value, 70),
    value: JSON.stringify({ field: field.key, value: option.value }),
  }))
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export type ParseResult = { ok: true; answer: FormAnswer } | { ok: false; error: string }

/**
 * Parse `!answer` input into a `form.reply` answer object.
 *
 * One visible field: the whole input is that field's value (option value, option
 * label, 1-based option number, or free text). Several fields: `key=value` pairs
 * separated by newlines, semicolons or commas.
 */
export function parseFormAnswer(form: Form, input: string): ParseResult {
  const fields = visibleFields(form)
  const text = input.trim()
  if (fields.length === 0) return { ok: false, error: "This question has no answerable fields." }
  if (!text) return { ok: false, error: "Give an answer, e.g. `!answer yes`." }

  if (fields.length === 1) {
    const field = fields[0] as FormField
    const coerced = coerceValue(field, text)
    if (!coerced.ok) return coerced
    return { ok: true, answer: { [field.key]: coerced.value } }
  }

  const answer: FormAnswer = {}
  const parts = splitPairs(text)
  for (const part of parts) {
    const eq = part.indexOf("=")
    if (eq <= 0) {
      return { ok: false, error: `\`${part}\` is not \`key=value\`. Fields: ${fields.map((f) => f.key).join(", ")}.` }
    }
    const key = part.slice(0, eq).trim().toLowerCase()
    const raw = part.slice(eq + 1).trim()
    const field = fields.find((candidate) => candidate.key.toLowerCase() === key)
    if (!field) {
      return { ok: false, error: `Unknown field \`${key}\`. Fields: ${fields.map((f) => f.key).join(", ")}.` }
    }
    if (raw === "") {
      if (field.required) return { ok: false, error: `\`${field.key}\` is required.` }
      continue
    }
    const coerced = coerceValue(field, raw)
    if (!coerced.ok) return coerced
    answer[field.key] = coerced.value
  }

  const missing = fields.filter((field) => field.required && answer[field.key] === undefined)
  if (missing.length > 0) {
    return { ok: false, error: `Missing required: ${missing.map((field) => field.key).join(", ")}.` }
  }
  return { ok: true, answer }
}

function splitPairs(text: string): string[] {
  const separator = text.includes("\n") ? "\n" : text.includes(";") ? ";" : ","
  return text
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean)
}

function coerceValue(field: FormField, raw: string): { ok: true; value: FormValue } | { ok: false; error: string } {
  const value = raw.trim()

  if (field.type === "boolean") {
    const normalised = value.toLowerCase()
    if (["yes", "y", "true", "1"].includes(normalised)) return { ok: true, value: true }
    if (["no", "n", "false", "0"].includes(normalised)) return { ok: true, value: false }
    return { ok: false, error: `\`${field.key}\` expects yes or no.` }
  }

  if (field.type === "number" || field.type === "integer") {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return { ok: false, error: `\`${field.key}\` expects a number.` }
    if (field.type === "integer" && !Number.isInteger(parsed)) {
      return { ok: false, error: `\`${field.key}\` expects a whole number.` }
    }
    if (typeof field.minimum === "number" && parsed < field.minimum) {
      return { ok: false, error: `\`${field.key}\` must be at least ${field.minimum}.` }
    }
    if (typeof field.maximum === "number" && parsed > field.maximum) {
      return { ok: false, error: `\`${field.key}\` must be at most ${field.maximum}.` }
    }
    return { ok: true, value: parsed }
  }

  if (field.type === "multiselect") {
    const parts = value
      .split(/[,;\n]/)
      .map((part) => part.trim())
      .filter(Boolean)
    const resolved: string[] = []
    for (const part of parts) {
      const option = resolveOption(field, part)
      if (!option) return { ok: false, error: `${describeOptionsList(field)}` }
      if (!resolved.includes(option)) resolved.push(option)
    }
    if (resolved.length === 0) return { ok: false, error: `\`${field.key}\` expects one or more options.` }
    if (typeof field.minItems === "number" && resolved.length < field.minItems) {
      return { ok: false, error: `\`${field.key}\` needs at least ${field.minItems} options.` }
    }
    if (typeof field.maxItems === "number" && resolved.length > field.maxItems) {
      return { ok: false, error: `\`${field.key}\` accepts at most ${field.maxItems} options.` }
    }
    return { ok: true, value: resolved }
  }

  if (field.type === "external") {
    return { ok: false, error: `\`${field.key}\` is answered outside Slack${field.url ? `: ${field.url}` : "."}` }
  }

  if ((field.options?.length ?? 0) > 0) {
    const option = resolveOption(field, value)
    if (!option) return { ok: false, error: describeOptionsList(field) }
    return { ok: true, value: option }
  }

  if (typeof field.minLength === "number" && value.length < field.minLength) {
    return { ok: false, error: `\`${field.key}\` needs at least ${field.minLength} characters.` }
  }
  if (typeof field.maxLength === "number" && value.length > field.maxLength) {
    return { ok: false, error: `\`${field.key}\` accepts at most ${field.maxLength} characters.` }
  }
  return { ok: true, value }
}

/** Accept an option's value, its label (case-insensitive), or its 1-based number. */
function resolveOption(field: FormField, raw: string): string | undefined {
  const options = field.options ?? []
  const value = raw.trim()
  const byValue = options.find((option) => option.value === value)
  if (byValue) return byValue.value
  const byLabel = options.find((option) => option.label.toLowerCase() === value.toLowerCase())
  if (byLabel) return byLabel.value
  if (/^\d+$/.test(value)) {
    const option = options[Number(value) - 1]
    if (option) return option.value
  }
  return undefined
}

function describeOptionsList(field: FormField): string {
  const options = (field.options ?? []).map((option) => `\`${option.value}\``).join(", ")
  return `\`${field.key}\` expects one of: ${options}.`
}

/** Short confirmation text after a successful reply/cancel. */
export function describeAnswer(answers: FormAnswer, fields: FormField[]): string {
  const parts = Object.entries(answers).map(([key, value]) => {
    const field = fields.find((candidate) => candidate.key === key)
    const shown = Array.isArray(value) ? value.join(", ") : String(value)
    return `${field?.title ?? key}: \`${mrkdwnEscape(shown)}\``
  })
  return parts.join(" · ")
}
