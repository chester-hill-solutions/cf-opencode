import { tasks } from "../protocol"
import { parseModelConfig, type ModelConfig } from "./task-model"
import { sha256, type TaskIdentity } from "./journal"

export type TaskRequest = { id: string; taskID: string; protocolSHA256: string; condition: "cold" | "warm"; repetition: number }
export type TaskConfig = { model: ModelConfig; protocolSHA256: string; spendBudgetUSD: number; deadlineMs: number }

export const taskConfigDigest = (config: TaskConfig, credential: string) => sha256(JSON.stringify(config) + "\n" + credential)

export async function assertTaskConfiguration(identity: TaskIdentity, config: TaskConfig, credential: string, expectedSHA: string): Promise<void> {
  if (identity.protocolSHA256 !== expectedSHA || identity.configSHA256 !== await taskConfigDigest(config, credential)) throw new Error("attempt configuration changed; automatic resume refused")
}

export async function readTaskBody(request: Request, timeoutMs = 5000): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > 4096) throw new Error("task request limit")
  const reader = request.body?.getReader()
  if (!reader) throw new Error("body required")
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("task body deadline")), timeoutMs) })
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), deadline])
      if (part.done) break
      size += part.value.byteLength
      if (size > 4096) throw new Error("task request limit")
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return JSON.parse(new TextDecoder().decode(bytes))
  } finally {
    if (timer) clearTimeout(timer)
    void reader.cancel().catch(() => {}); reader.releaseLock()
  }
}

export function taskAttemptID(taskID: string, condition: "cold" | "warm", repetition: number, protocolSHA256: string): string {
  return `r0-23-${protocolSHA256.slice(0, 12)}-${taskID.toLowerCase()}-${condition}-${repetition}`
}

export function parseTaskRequest(value: unknown, expectedSHA: string): TaskRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task request required")
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(",") !== "condition,id,protocolSHA256,repetition,taskID") throw new Error("unexpected task request field")
  if (typeof row.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,79}$/.test(row.id)) throw new Error("invalid attempt id")
  if (typeof row.taskID !== "string" || !tasks.some(task => task.id === row.taskID)) throw new Error("unknown frozen task")
  if (!/^[a-f0-9]{64}$/.test(expectedSHA) || row.protocolSHA256 !== expectedSHA) throw new Error("frozen protocol mismatch")
  if ((row.condition !== "cold" && row.condition !== "warm") || !Number.isInteger(row.repetition) || Number(row.repetition) < 1 || Number(row.repetition) > 3) throw new Error("invalid trial identity")
  if (row.id !== taskAttemptID(row.taskID, row.condition, Number(row.repetition), expectedSHA)) throw new Error("attempt id must identify its frozen trial cell")
  return { id: row.id, taskID: row.taskID, protocolSHA256: expectedSHA, condition: row.condition, repetition: Number(row.repetition) }
}

/** Absent/empty configuration keeps the task endpoint disabled. No default model or spend. */
export function parseTaskConfig(serialized: string, expectedSHA: string): TaskConfig {
  const row: unknown = JSON.parse(serialized)
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("task configuration required")
  const value = row as Record<string, unknown>
  if (Object.keys(value).sort().join(",") !== "deadlineMs,enabled,model,protocolSHA256,spendBudgetUSD") throw new Error("unsupported task configuration")
  if (value.enabled !== true || value.protocolSHA256 !== expectedSHA) throw new Error("task execution not enabled for this frozen protocol")
  if (typeof value.spendBudgetUSD !== "number" || !Number.isFinite(value.spendBudgetUSD) || value.spendBudgetUSD <= 0) throw new Error("numeric spend budget required")
  if (!Number.isInteger(value.deadlineMs) || Number(value.deadlineMs) < 1000 || Number(value.deadlineMs) > 900_000) throw new Error("invalid observation deadline")
  return { model: parseModelConfig(value.model), protocolSHA256: expectedSHA, spendBudgetUSD: value.spendBudgetUSD, deadlineMs: Number(value.deadlineMs) }
}
