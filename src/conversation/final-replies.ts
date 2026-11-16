import { chunkText } from "../adapters/slack"
import type { ConversationStore, ConversationState, SlackTarget } from "../state"

const PREFIX = "finalReply:"
interface FinalReply {
  schemaVersion: 1; id: string; sessionID: string; runStartedAt: number | null; turnBaseline: string | null
  reservationID: string | null; reservationDate: string | null; target: SlackTarget; text: string
  status: "pending" | "delivered"; nextChunk: number; attempts: number; nextAttemptAt: number; createdAt: number
}
interface Options {
  storage: DurableObjectStorage; store: ConversationStore
  schedule(at: number): Promise<void>
  send(target: SlackTarget, text: string): Promise<void>
}
function parse(value: unknown): FinalReply {
  const row = value as FinalReply
  if (!row || row.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(row.id) || typeof row.sessionID !== "string" ||
    !row.target || typeof row.target.channel !== "string" || (row.target.replyTs !== undefined && typeof row.target.replyTs !== "string") ||
    typeof row.text !== "string" || new TextEncoder().encode(row.text).byteLength > 96 * 1024 || !["pending", "delivered"].includes(row.status) ||
    !Number.isSafeInteger(row.nextChunk) || row.nextChunk < 0 || !Number.isSafeInteger(row.attempts) || row.attempts < 0 ||
    !Number.isSafeInteger(row.nextAttemptAt) || !Number.isSafeInteger(row.createdAt) ||
    (row.runStartedAt !== null && !Number.isFinite(row.runStartedAt)) || (row.turnBaseline !== null && typeof row.turnBaseline !== "string") ||
    (row.reservationID !== null && typeof row.reservationID !== "string") || (row.reservationDate !== null && typeof row.reservationDate !== "string")) throw new Error("Final reply state is unavailable")
  return row
}
function sameOwner(state: ConversationState, row: Pick<FinalReply, "sessionID" | "runStartedAt" | "turnBaseline">): boolean {
  return state.sessionID === row.sessionID && (state.runStartedAt ?? null) === row.runStartedAt && (state.turnBaseline ?? null) === row.turnBaseline
}

/** Final public text only. Delivery owns no provider execution or accounting work. */
export class ConversationFinalReplies {
  constructor(private readonly options: Options) {}
  private async rows(): Promise<FinalReply[]> { return [...(await this.options.storage.list({ prefix: PREFIX })).values()].map(parse) }
  async hasPending(): Promise<boolean> { return (await this.rows()).some(row => row.status === "pending") }
  async nextAt(): Promise<number | undefined> {
    const times = (await this.rows()).filter(row => row.status === "pending").map(row => row.nextAttemptAt)
    return times.length ? Math.min(...times) : undefined
  }
  async prepare(state: ConversationState, text: string, assistantID?: string): Promise<void> {
    if (!text || !state.slack || !state.sessionID) return
    const target = { ...state.slack }
    if (new TextEncoder().encode(text).byteLength > 96 * 1024) throw new Error("Final reply exceeds durable delivery limit")
    const owner = { sessionID: state.sessionID, runStartedAt: state.runStartedAt ?? null, turnBaseline: state.turnBaseline ?? null }
    const id = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([owner, assistantID ?? null]))))].map(byte => byte.toString(16).padStart(2, "0")).join("")
    await this.options.storage.transaction(async txn => {
      if (!sameOwner(await this.options.store.get(), owner)) throw new Error("Final reply belongs to a stale turn")
      const prior = await txn.get(PREFIX + id)
      if (prior) {
        const row = parse(prior)
        if (row.text !== text || JSON.stringify(row.target) !== JSON.stringify(state.slack)) throw new Error("Final reply identity changed")
        if (row.status === "pending") await this.options.schedule(row.nextAttemptAt)
        return
      }
      const rows = await this.rows()
      if (rows.filter(row => row.status === "pending").length >= 20) throw new Error("Final reply delivery backlog requires operator attention")
      // Keep bounded recent acknowledgements; never prune unacknowledged replies.
      for (const old of rows.filter(row => row.status === "delivered").sort((a, b) => b.createdAt - a.createdAt).slice(19)) await txn.delete(PREFIX + old.id)
      const row: FinalReply = { schemaVersion: 1, id, ...owner,
        reservationID: state.budgetReservation?.reservationID ?? null, reservationDate: state.budgetReservation?.date ?? null,
        target, text, status: "pending", nextChunk: 0, attempts: 0, createdAt: Date.now(), nextAttemptAt: Date.now() }
      await txn.put(PREFIX + id, row)
      // The wake is durable before releasing accounting ownership. It waits for
      // the matching hold to clear, including a crash immediately after release.
      await this.options.schedule(row.nextAttemptAt)
    })
  }
  async deliver(): Promise<{ rescheduleAt: number } | undefined> {
    let earliest = Infinity, sent = 0
    for (let row of (await this.rows()).sort((a, b) => a.createdAt - b.createdAt)) {
      if (row.status !== "pending") continue
      const hold = (await this.options.store.get()).budgetReservation
      if ((row.reservationID && hold?.reservationID === row.reservationID && hold.date === row.reservationDate) || row.nextAttemptAt > Date.now() || sent >= 4) {
        earliest = Math.min(earliest, Math.max(Date.now() + 1000, row.nextAttemptAt)); continue
      }
      const chunks = chunkText(row.text)
      try {
        while (row.nextChunk < chunks.length && sent < 4) {
          sent++
          await this.options.send(row.target, chunks[row.nextChunk]!)
          const updated = await this.options.storage.transaction(async txn => {
            const raw = await txn.get(PREFIX + row.id)
            if (!raw) return undefined // Never resurrect state after authorized cleanup.
            const current = parse(raw)
            if (current.status !== "pending" || current.nextChunk !== row.nextChunk) return current
            const next: FinalReply = { ...current, nextChunk: current.nextChunk + 1, attempts: 0, nextAttemptAt: Date.now(),
              status: current.nextChunk + 1 === chunks.length ? "delivered" : "pending" }
            await txn.put(PREFIX + next.id, next)
            if (next.status === "delivered" && sameOwner(await this.options.store.get(), next)) await this.options.store.patch({ lastSlackReply: next.text })
            return next
          })
          if (!updated) break
          row = updated
        }
      } catch {
        // A lost Slack/storage acknowledgement can repeat the unacknowledged
        // chunk. Confirmed chunks are retained; no model/accounting work repeats.
        const raw = await this.options.storage.get(PREFIX + row.id)
        if (raw) {
          row = parse(raw)
          if (row.status === "pending") {
            row = { ...row, attempts: Math.min(32, row.attempts + 1), nextAttemptAt: Date.now() + Math.min(300000, 5000 * 2 ** Math.min(row.attempts, 6)) }
            await this.options.storage.put(PREFIX + row.id, row)
          }
        }
      }
      if (row.status === "pending") earliest = Math.min(earliest, Math.max(Date.now() + 1000, row.nextAttemptAt))
    }
    return Number.isFinite(earliest) ? { rescheduleAt: earliest } : undefined
  }
  async clear(): Promise<void> { for (const key of (await this.options.storage.list({ prefix: PREFIX })).keys()) await this.options.storage.delete(key) }
}
