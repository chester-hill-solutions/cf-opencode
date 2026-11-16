import { renderMemory, type MemoryEntry, type MemoryScope } from "../memory"
import { SOUL } from "../soul"

/**
 * The harness side of memory: one stored copy in the Settings DO, read by every
 * conversation and written by the commands. It answers cold — no runtime, no
 * model — because knowing what the team said must never depend on a container.
 */

export interface MemoryContext {
  team: MemoryEntry[]
  user: MemoryEntry[]
}

export type MemoryWrite =
  | { ok: true; entry: MemoryEntry }
  | { ok: false; error: string }

export interface MemoryServices {
  context(user?: string): Promise<MemoryContext>
  remember(scope: MemoryScope, text: string, user?: string): Promise<MemoryWrite>
  forget(scope: MemoryScope, index: number, user?: string): Promise<MemoryWrite>
}

interface Stub {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>
}

const MEMORY_URL = "https://settings/memory"

export function memoryServices(settings: () => Stub): MemoryServices {
  return {
    async context(user) {
      const query = user ? `?user=${encodeURIComponent(user)}` : ""
      const response = await settings().fetch(`${MEMORY_URL}${query}`)
      if (!response.ok) throw new Error("memory is unavailable")
      const body = await response.json() as { team?: MemoryEntry[]; user?: MemoryEntry[] }
      return { team: body.team ?? [], user: body.user ?? [] }
    },
    remember(scope, text, user) {
      return write(settings, { action: "remember", scope, text, ...(user ? { user, by: user } : {}) })
    },
    forget(scope, index, user) {
      return write(settings, { action: "forget", scope, index, ...(user ? { user } : {}) })
    },
  }
}

async function write(settings: () => Stub, body: Record<string, unknown>): Promise<MemoryWrite> {
  const response = await settings().fetch(MEMORY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => undefined) as { entry?: MemoryEntry; error?: string } | undefined
  if (!response.ok || !payload?.entry) return { ok: false, error: payload?.error ?? "memory write failed" }
  return { ok: true, entry: payload.entry }
}

/**
 * The prompt block: soul first, then team memory, then this person's. Soul is
 * the only part allowed to instruct; everything below it is quoted data.
 */
export function renderMemoryContext(memory: MemoryContext | undefined): string {
  if (!memory) return ""
  return [
    `<soul>\n${SOUL}\n</soul>`,
    renderMemory("team", memory.team),
    renderMemory("user", memory.user),
  ].filter((block) => block.length > 0).join("\n\n")
}
