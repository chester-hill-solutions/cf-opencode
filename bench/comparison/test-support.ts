import { TaskJournal, type JournalStore, type TaskReceipt } from "./baseline/journal"

export class MemoryStore implements JournalStore {
  private value: TaskReceipt | null = null
  private pending = Promise.resolve()
  async read() { await this.pending; return structuredClone(this.value) }
  async change<T>(update: (current: TaskReceipt | null) => { next: TaskReceipt; result: T }): Promise<T> {
    const before = this.pending
    let release = () => {}
    this.pending = new Promise<void>(resolve => { release = resolve })
    await before
    try { const { next, result } = update(structuredClone(this.value)); this.value = structuredClone(next); return result }
    finally { release() }
  }
}

export const identity = { id: "attempt-0001", taskID: "L1", protocolSHA256: "a".repeat(64), condition: "cold" as const, repetition: 1, configSHA256: "b".repeat(64) }
export async function running() {
  const journal = new TaskJournal(new MemoryStore())
  await journal.admit(identity); await journal.transition("preparing", "ready"); await journal.transition("ready", "running")
  return journal
}
export function latch() {
  let release = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
