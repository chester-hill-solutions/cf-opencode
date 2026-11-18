/**
 * Recycle the container so the next call starts the current image.
 *
 * Moved out of the Durable Object so the class keeps room for newer
 * operations. Every step is a callback into an existing collaborator; this
 * module owns only the order and the refusals.
 */
export interface RecycleDeps {
  withLock: <T>(task: () => Promise<T>) => Promise<T>
  upgradesPending: () => Promise<boolean>
  blocked: () => Promise<Response | undefined>
  stopStream: () => Promise<boolean>
  withUsageLifecycle: (task: () => Promise<Response>) => Promise<Response>
  capture: () => Promise<unknown | null>
  stop: () => Promise<boolean>
  releaseLease: () => Promise<boolean>
  clearSnapshot: () => Promise<unknown>
}

const failure = (error: string) => Response.json({ ok: false, error }, { status: 503 })

export function recycleRoute(deps: RecycleDeps): Promise<Response> {
  return deps.withLock(async () => {
    if (await deps.upgradesPending()) {
      return Response.json({ error: "runtime upgrade is pending; resume it before recycling" }, { status: 409 })
    }
    const blocked = await deps.blocked()
    if (blocked) return blocked
    if (!await deps.stopStream()) return failure("runtime stream did not drain; not recycling")
    return deps.withUsageLifecycle(async () => {
      // R2 checkpoints are portable across image versions. Capture the current
      // runtime under exclusive ownership before stopping it.
      if (!await deps.capture()) return failure("checkpoint failed; not recycling")
      if (!await deps.stop()) return failure("container stop was not confirmed; not recycling")
      if (!await deps.releaseLease()) return failure("container lease release is pending; not recycling")
      await deps.clearSnapshot()
      return Response.json({ ok: true })
    })
  })
}
