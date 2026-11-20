import type { ConversationStore } from "../state"
import type { ConversationUsage } from "./usage"
import { emitConversationTelemetry } from "./telemetry"

export interface CleanupUsageDeps {
  store: ConversationStore
  usage: Pick<ConversationUsage, "serialize" | "replayLogLocked">
  exclusive<T>(task: () => Promise<T>): Promise<T>
  conversationID: string
  errorMessage(error: unknown): string
}

/**
 * Settle usage before a destructive lifecycle step. A session the runtime no
 * longer has proves there is nothing to replay; refusing cleanup forever would
 * strand the conversation, so that case proceeds and is recorded.
 */
export function withCleanupUsage(
  deps: CleanupUsageDeps,
  cleanup: () => Promise<Response>,
  cleanupAlreadyFenced = false,
): Promise<Response> {
  return deps.usage.serialize(async () => {
    try {
      const state = await deps.store.get()
      if (state.sessionID && !cleanupAlreadyFenced) {
        await deps.usage.replayLogLocked(state.sessionID)
        const refreshed = await deps.store.get()
        const execution = refreshed.usageExecution
        if (execution?.sessionID === state.sessionID &&
          (execution.startedSeq > execution.terminalSeq || execution.latestStepSeq > execution.terminalSeq)) {
          throw new Error("provider execution is not terminal; lifecycle cleanup is unsafe")
        }
      }
    } catch (error) {
      const message = deps.errorMessage(error)
      if (/session not found/i.test(message)) {
        emitConversationTelemetry({
          event: "usage.replay.missing_session",
          conversationID: deps.conversationID,
          result: "skipped",
          reasonCode: "session_missing",
        })
        return deps.exclusive(cleanup)
      }
      await deps.store.patch({ usageError: message }).catch(() => {})
      return Response.json({ ok: false, error: `usage replay failed: ${message}`, retryable: true }, { status: 503 })
    }
    return deps.exclusive(cleanup)
  })
}
