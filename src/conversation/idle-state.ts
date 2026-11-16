/** Durable close intent. No prompts, credentials, or financial authority. */
export interface ContainerIdleRecord {
  version: 1
  id: string
  generation: string
  dueAt: number
  phase: "waiting" | "closing"
}

export function isContainerIdleRecord(value: unknown): value is ContainerIdleRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return Object.keys(raw).every((key) => ["version", "id", "generation", "dueAt", "phase"].includes(key)) &&
    raw.version === 1 && typeof raw.id === "string" && raw.id.length > 0 &&
    typeof raw.generation === "string" && raw.generation.length > 0 &&
    typeof raw.dueAt === "number" && Number.isSafeInteger(raw.dueAt) && raw.dueAt >= 0 &&
    (raw.phase === "waiting" || raw.phase === "closing")
}
