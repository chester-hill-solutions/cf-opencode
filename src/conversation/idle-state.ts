/** Durable close intent. No prompts, credentials, or financial authority. */
export interface ContainerIdleRecord {
  version: 1
  id: string
  generation: string
  dueAt: number
  phase: "waiting" | "closing"
  /** When the intent first appeared, so a repeated use cannot postpone it forever. */
  createdAt?: number
}

const IDLE_KEYS = ["version", "id", "generation", "dueAt", "phase", "createdAt"]

function isIdleOption(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value))
}

function isIdleTime(raw: Record<string, unknown>): boolean {
  return typeof raw.dueAt === "number" && Number.isSafeInteger(raw.dueAt) && raw.dueAt >= 0 &&
    isIdleOption(raw.createdAt)
}

function isIdleBody(raw: Record<string, unknown>): boolean {
  return raw.version === 1 && typeof raw.id === "string" && raw.id.length > 0 &&
    typeof raw.generation === "string" && raw.generation.length > 0 &&
    isIdleTime(raw) &&
    (raw.phase === "waiting" || raw.phase === "closing")
}

export function isContainerIdleRecord(value: unknown): value is ContainerIdleRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).every((key) => IDLE_KEYS.includes(key)) &&
    isIdleBody(value as Record<string, unknown>)
}
