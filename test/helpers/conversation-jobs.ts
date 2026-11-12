import type { ConversationState } from "../../src/state"

export type ConversationJobID = "turn:observe" | "admission:retry" | "checkpoint:retry" | "recovery:wake" | "legacy:bootstrap"

/** Test-only clock seam: advance named conversation jobs, never every future job. */
export async function makeConversationJobsDue(
  storage: DurableObjectStorage,
  ids: readonly ConversationJobID[],
  options: { queued?: boolean; checkpoint?: boolean } = {},
): Promise<void> {
  const now = Date.now()
  for (const id of ids) {
    storage.sql.exec(
      "UPDATE cf_agents_jobs SET time = ?, running = 0, execution_started_at = NULL WHERE id = ? AND capability = ?",
      now,
      id,
      "conversation-jobs",
    )
  }
  const state = await storage.get<ConversationState>("state")
  if (!state) return
  if (options.queued && state.queued) {
    await storage.put("state", { ...state, queued: { ...state.queued, nextAttemptAt: now } })
  } else if (options.checkpoint && state.checkpointPending) {
    await storage.put("state", { ...state, checkpointRetryAt: now })
  }
}

/** Trigger selected jobs without waiting for a currently blocked job body. */
export async function startConversationJobs(
  instance: { alarm(): Promise<void>; fetch(request: Request): Promise<Response> },
  storage: DurableObjectStorage,
  ids: readonly ConversationJobID[],
  options: { queued?: boolean; checkpoint?: boolean } = {},
): Promise<{ completion: Promise<void> }> {
  await instance.fetch(new Request("https://conversation/health"))
  await makeConversationJobsDue(storage, ids, options)
  const completion = instance.alarm()
  // Keep an early test assertion from turning an expected latch rejection into
  // an unhandled promise; callers still await the original completion later.
  void completion.catch(() => {})
  return { completion }
}

/** Wait until the real named-job handoff has released its durable claim. */
export async function waitForConversationJobs(storage: DurableObjectStorage): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const claims = await storage.get<Record<string, { claimID?: string }>>("conversationJobClaims")
    if (!claims || Object.keys(claims).length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("conversation lifecycle job handoff did not complete within five seconds")
}

/** Drive the real Lifecycle alarm and await its bounded handoff completion. */
export async function driveConversationJobs(
  instance: { alarm(): Promise<void>; fetch(request: Request): Promise<Response> },
  storage: DurableObjectStorage,
  ids: readonly ConversationJobID[],
  options: { queued?: boolean; checkpoint?: boolean } = {},
): Promise<void> {
  const started = await startConversationJobs(instance, storage, ids, options)
  await started.completion
  await waitForConversationJobs(storage)
}
