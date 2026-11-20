import { describe, expect, test } from "bun:test"
import { renewConversationLease, type LeaseRenewalPorts } from "../src/conversation/lease-renewal"

function ports(
  options: { held?: boolean; containerRunning?: boolean; nativeEnabled?: boolean; closeHook?: boolean } = {},
): LeaseRenewalPorts & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async status() {
      calls.push("status")
      return options.held ? { desired: "held" } : undefined
    },
    async ensureHeld() { calls.push("ensureHeld") },
    async releaseUnused() { calls.push("releaseUnused"); return true },
    async maintain() { calls.push("maintain") },
    nativeEnabled: () => options.nativeEnabled ?? true,
    containerRunning: options.containerRunning,
    beforeRenew: options.closeHook ? async () => { calls.push("beforeRenew") } : undefined,
  }
}

describe("renewConversationLease", () => {
  test("adopts a running container that predates the lease intent", async () => {
    const unit = ports({ containerRunning: true })
    await renewConversationLease(unit, "adopt-running-lease")
    expect(unit.calls).toEqual(["status", "ensureHeld"])
  })

  test("does not adopt for any other wake, a stopped container, or no native lease", async () => {
    for (const overrides of [
      { containerRunning: true, nativeEnabled: false },
      { containerRunning: false },
      { containerRunning: undefined },
    ]) {
      const unit = ports(overrides)
      await renewConversationLease(unit, "adopt-running-lease")
      expect(unit.calls).toEqual(["status"])
    }
    const quiet = ports({ containerRunning: true })
    await renewConversationLease(quiet, "lease-renew")
    expect(quiet.calls).toEqual(["status"])
  })

  test("releases a held lease whose binding already stopped instead of renewing", async () => {
    const unit = ports({ held: true, containerRunning: false, closeHook: true })
    await renewConversationLease(unit, "lease-renew")
    expect(unit.calls).toEqual(["status", "releaseUnused"])
  })

  test("gives a held lease a close hook before renewing it", async () => {
    const unit = ports({ held: true, containerRunning: true, closeHook: true })
    await renewConversationLease(unit, "lease-renew")
    expect(unit.calls).toEqual(["status", "beforeRenew", "maintain"])
  })
})
