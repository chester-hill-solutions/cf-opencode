import { FROZEN_PROTOCOL_SHA256 } from "./freeze.generated"
import { SMOKE_SCOPE } from "./smoke-scope"
import { taskAttemptID } from "./task-request"

export type SmokeCall = {
  attemptID: string
  status: "pending" | "complete" | "unknown"
  inputTokens: number | null
  outputTokens: number | null
  estimatedUSD: number | null
  upstreamStatus?: number
}

const forwarded = ["messages", "tools", "tool_choice", "parallel_tool_calls"] as const
const accepted = new Set<string>(["model", "stream", ...forwarded, "max_tokens", "max_completion_tokens", "temperature", "stream_options"])
const roles = new Set(["system", "developer", "user", "assistant", "tool"])
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

function jsonCopy(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(jsonCopy)
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonCopy(child)]))
  throw new Error("smoke body must contain JSON values")
}

function validMessage(value: unknown): boolean {
  if (!record(value) || typeof value.role !== "string" || !roles.has(value.role)) return false
  const content = value.content
  const toolCalls = value.tool_calls
  if (toolCalls !== undefined && (!Array.isArray(toolCalls) || toolCalls.some(call => !record(call) || call.type !== "function" || typeof call.id !== "string" || !call.id || !record(call.function) || typeof call.function.name !== "string" || !call.function.name || typeof call.function.arguments !== "string"))) return false
  if (value.role === "tool" && (typeof value.tool_call_id !== "string" || !value.tool_call_id)) return false
  return typeof content === "string" || (Array.isArray(content) && content.every(part => record(part) && typeof part.type === "string")) ||
    (value.role === "assistant" && (content === null || content === undefined) && Array.isArray(toolCalls) && toolCalls.length > 0)
}

/** Only the fixed paid model and ordinary chat inputs cross the common dispatcher. */
export function normalizeSmokeBody(value: unknown): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !accepted.has(key))) throw new Error("unsupported smoke provider field")
  if (value.model !== SMOKE_SCOPE.model || value.stream !== true) throw new Error("fixed streaming smoke model required")
  if (!Array.isArray(value.messages) || value.messages.length === 0 || !value.messages.every(validMessage)) throw new Error("invalid smoke messages")
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.some(tool => !record(tool) || tool.type !== "function" || !record(tool.function) || typeof tool.function.name !== "string" || !tool.function.name || (tool.function.parameters !== undefined && !record(tool.function.parameters))))) throw new Error("invalid smoke tools")
  if (value.parallel_tool_calls !== undefined && typeof value.parallel_tool_calls !== "boolean") throw new Error("invalid parallel tool setting")
  if (value.tool_choice !== undefined) {
    const choice = value.tool_choice
    if (!(typeof choice === "string" && ["auto", "none", "required"].includes(choice)) &&
      !(record(choice) && choice.type === "function" && record(choice.function) && typeof choice.function.name === "string" && choice.function.name.length > 0)) throw new Error("invalid smoke tool choice")
  }
  const body: Record<string, unknown> = { model: SMOKE_SCOPE.model, stream: true }
  for (const key of forwarded) if (value[key] !== undefined) body[key] = jsonCopy(value[key])
  return { ...body, max_tokens: SMOKE_SCOPE.maxOutputTokens, temperature: SMOKE_SCOPE.temperature, stream_options: { include_usage: true } }
}

export function allowedSmokeAttempt(attemptID: string): boolean {
  return SMOKE_SCOPE.tasks.some(task => {
    const baseline = taskAttemptID(task, "cold", 1, FROZEN_PROTOCOL_SHA256)
    return attemptID === baseline || attemptID === "aboiteau-" + baseline
  })
}

/** Called inside the dispatcher's transaction before reserving a pending call. */
export function smokeAdmissionAllowed(calls: SmokeCall[], attemptID: string): boolean {
  if (!allowedSmokeAttempt(attemptID) || !Array.isArray(calls) || calls.length >= SMOKE_SCOPE.maxCallsTotal) return false
  let total = 0
  const counts = new Map<string, number>()
  for (const call of calls) {
    if (!record(call) || !allowedSmokeAttempt(call.attemptID) || call.status !== "complete" ||
      !Number.isSafeInteger(call.inputTokens) || Number(call.inputTokens) < 0 || !Number.isSafeInteger(call.outputTokens) || Number(call.outputTokens) < 0 ||
      typeof call.estimatedUSD !== "number" || !Number.isFinite(call.estimatedUSD) || call.estimatedUSD < 0) return false
    const count = (counts.get(call.attemptID) ?? 0) + 1
    if (count > SMOKE_SCOPE.maxCallsPerAttempt) return false
    counts.set(call.attemptID, count)
    // Use the higher of recorded and token-derived estimates; malformed lower
    // estimates cannot reopen the gate or spend the reserve buffer.
    const tokenCost = (Number(call.inputTokens) * SMOKE_SCOPE.inputUSDPerMillion + Number(call.outputTokens) * SMOKE_SCOPE.outputUSDPerMillion) / 1_000_000
    total += Math.max(call.estimatedUSD, tokenCost)
    if (!Number.isFinite(total) || total >= SMOKE_SCOPE.providerBudgetUSD - 0.25) return false
  }
  return (counts.get(attemptID) ?? 0) < SMOKE_SCOPE.maxCallsPerAttempt
}
