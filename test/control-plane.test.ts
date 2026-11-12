import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { ConversationControlPlane } from "../src/conversation/control-plane"
import { ConversationStore } from "../src/state"
import type { makeClient } from "../src/opencode"

type Client = ReturnType<typeof makeClient>

function makeControlPlane(
  runtime: DurableObjectState,
  options: { pendingUpgrade?: () => Promise<boolean>; upstreamCalls?: { count: number } } = {},
) {
  const upstreamCalls = options.upstreamCalls ?? { count: 0 }
  const store = new ConversationStore(runtime.storage)
  return {
    store,
    upstreamCalls,
    control: new ConversationControlPlane({
      storage: runtime.storage,
      store,
      withClient: async <T>(_fn: (client: Client) => Promise<T>): Promise<T> => {
        upstreamCalls.count++
        throw new Error("unexpected upstream call")
      },
      withAdmissionLock: async <T>(task: () => Promise<T>) => task(),
      hasPendingRuntimeUpgrade: options.pendingUpgrade ?? (async () => false),
      scheduleObservation: async () => {},
    }),
  }
}

describe("ConversationControlPlane", () => {
  it("serializes concurrent token creation and preserves the token across service instances", async () => {
    const stub = env.CONVERSATION.getByName("C1:control-plane-token")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const first = makeControlPlane(runtime)
      const second = makeControlPlane(runtime)
      const tokens = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? first.control : second.control).token(),
      ))
      const stored = await runtime.storage.get<string>("controlToken")
      const reloaded = makeControlPlane(runtime).control
      const sameAfterReload = await reloaded.token()

      first.control.clearCache()
      await runtime.storage.delete("controlToken")
      const replaced = await first.control.token()
      return {
        tokens,
        stored,
        sameAfterReload,
        cached: reloaded.cachedToken,
        replaced,
        replacementStored: await runtime.storage.get<string>("controlToken"),
      }
    })

    expect(new Set(result.tokens).size).toBe(1)
    expect(result.tokens[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(result.stored).toBe(result.tokens[0])
    expect(result.sameAfterReload).toBe(result.stored)
    expect(result.cached).toBe(result.stored)
    expect(result.replaced).not.toBe(result.stored)
    expect(result.replacementStored).toBe(result.replaced)
  })

  it("does not call OpenCode for denied permissions, unknown requests, or stale forms", async () => {
    const stub = env.CONVERSATION.getByName("C1:control-plane-stale")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const calls = { count: 0 }
      const denied = makeControlPlane(runtime, {
        pendingUpgrade: async () => true,
        upstreamCalls: calls,
      }).control
      const deniedPermission = await denied.onPermission({
        requestID: "permission-1",
        decision: "reject",
        sessionID: "ses_current",
      })

      const active = makeControlPlane(runtime, { upstreamCalls: calls })
      await active.store.rememberPermission("permission-2", "ses_current")
      await runtime.storage.put("state", {
        phase: "idle",
        sessionID: "ses_current",
        slack: { channel: "C_CURRENT" },
        seen: [],
        pending: {},
      })
      const unknownPermission = await active.control.onPermission({
        requestID: "permission-missing",
        decision: "reject",
      })
      const staleForm = await active.control.onSlackForm({
        sessionID: "ses_old",
        formID: "form-1",
        channel: "C_CURRENT",
        cancel: true,
      })
      return {
        denied: { status: deniedPermission.status, body: await deniedPermission.json() },
        unknown: { status: unknownPermission.status, body: await unknownPermission.json() },
        stale: { status: staleForm.status, body: await staleForm.json() },
        calls: calls.count,
      }
    })

    expect(result.denied).toEqual({ status: 409, body: { error: "runtime upgrade is pending" } })
    expect(result.unknown).toEqual({ status: 404, body: { ok: false, error: "unknown request" } })
    expect(result.stale).toEqual({ status: 409, body: { error: "stale question or wrong channel" } })
    expect(result.calls).toBe(0)
  })
})
