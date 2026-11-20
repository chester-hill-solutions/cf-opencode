import { logEvent } from "../log"

/**
 * One `lease:renew` step. Kept out of the Durable Object so the adopt, release
 * and renew decisions can be tested without a container.
 */
export interface LeaseRenewalPorts {
  status(): Promise<unknown | undefined>
  ensureHeld(): Promise<void>
  releaseUnused(): Promise<boolean>
  maintain(): Promise<void>
  nativeEnabled(): boolean
  containerRunning: boolean | undefined
  /** A held lease whose holder has no close intent can still become idle. */
  beforeRenew?(): Promise<void>
}

export async function renewConversationLease(
  ports: LeaseRenewalPorts,
  reason: string | undefined,
): Promise<undefined> {
  const existing = await ports.status()
  logEvent("lease.renew.step", {
    reason: reason ?? null,
    containerRunning: ports.containerRunning ?? null,
    hasLease: existing !== undefined,
  })
  if (existing === undefined) {
    // Old native containers may predate the durable lease intent.
    if (reason === "adopt-running-lease" && ports.nativeEnabled() && ports.containerRunning) await ports.ensureHeld()
    return undefined
  }
  // The platform already stopped the binding, so nothing can hold the slot.
  if (ports.containerRunning === false) {
    await ports.releaseUnused()
    return undefined
  }
  // A lease adopted after a restart belongs to a container this instance has
  // never used, so no close intent may exist; renewing alone would pin the slot
  // for as long as the container lives.
  await ports.beforeRenew?.()
  await ports.maintain()
  return undefined
}
