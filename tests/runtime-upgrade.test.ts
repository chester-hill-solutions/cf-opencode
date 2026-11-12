import { describe, expect, test } from "bun:test"
import {
  parseRuntimeUpgradePending,
  RuntimeUpgradeError,
  verifyRestoredRuntimeUpgrade,
  type RuntimeUpgradeClient,
  type RuntimeUpgradePending,
} from "../src/runtime-upgrade"
import { digestRuntimeContext } from "../src/runtime-quiescence"

const context = [{ id: "msg_1", role: "assistant", content: [{ type: "text", text: "hello" }] }]
const digest = await digestRuntimeContext(context)
const targetImage = `registry.example/runtime@sha256:${"a".repeat(64)}`

function pending(overrides: Partial<RuntimeUpgradePending> = {}): RuntimeUpgradePending {
  return {
    planID: "plan_1",
    conversationID: "conv_1",
    sessionID: "ses_1",
    contextDigest: digest,
    sourceGeneration: "gen_old",
    targetImage,
    checkpointManifest: {
      workspace: { key: "workspaces/conv_1/workspace-1.tar.gz", size: 100, encrypted: true },
      state: { key: "workspaces/conv_1/state-1.tar.gz", size: 50, encrypted: true },
      createdAt: 1,
    },
    startedAt: 2,
    ...overrides,
  }
}

function client(options: { session?: unknown; context?: unknown; fail?: boolean; hang?: boolean } = {}): RuntimeUpgradeClient {
  return {
    get: async () => {
      if (options.fail) throw new Error("session read failed")
      if (options.hang) return new Promise(() => {})
      return options.session ?? { id: "ses_1" }
    },
    context: async () => {
      if (options.fail) throw new Error("context read failed")
      return options.context ?? context
    },
  } as unknown as RuntimeUpgradeClient
}

describe("runtime upgrade restore barrier", () => {
  test("validates and completes when original session and history survive", async () => {
    const intent = pending()
    expect(parseRuntimeUpgradePending(intent)).toEqual(intent)
    const receipt = await verifyRestoredRuntimeUpgrade({
      pending: intent,
      client: client(),
      actualTargetImage: targetImage,
      eventPersistence: true,
      currentGeneration: "gen_new",
      completedAt: 99,
    })
    expect(receipt).toMatchObject({ planID: "plan_1", sessionID: "ses_1", targetGeneration: "gen_new", completedAt: 99 })
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(receipt.checkpointManifest.state)).toBe(true)
  })

  test.each([
    ["malformed digest", pending({ contextDigest: "bad" })],
    ["missing state archive", pending({ checkpointManifest: { workspace: { key: "w", size: 1, encrypted: true }, createdAt: 1 } as RuntimeUpgradePending["checkpointManifest"] })],
    ["unpinned image", pending({ targetImage: "registry.example/runtime:latest" })],
    ["empty id", pending({ sessionID: " " })],
  ])("rejects malformed intent: %s", async (_label, intent) => {
    await expect(verifyRestoredRuntimeUpgrade({
      pending: intent,
      client: client(),
      actualTargetImage: targetImage,
      eventPersistence: true,
      currentGeneration: "gen_new",
    })).rejects.toBeInstanceOf(RuntimeUpgradeError)
  })

  test.each([
    ["wrong session", { session: { id: "ses_other" } }, targetImage, true, "gen_new"],
    ["mutated history", { context: [{ ...context[0], id: "msg_changed" }] }, targetImage, true, "gen_new"],
    ["event persistence missing", {}, targetImage, false, "gen_new"],
    ["different image", {}, `registry.example/other@sha256:${"b".repeat(64)}`, true, "gen_new"],
    ["same generation", {}, targetImage, true, "gen_old"],
  ] as const)("fails closed for %s", async (_label, options, image, persistence, generation) => {
    await expect(verifyRestoredRuntimeUpgrade({
      pending: pending(), client: client(options), actualTargetImage: image,
      eventPersistence: persistence, currentGeneration: generation,
    })).rejects.toBeInstanceOf(RuntimeUpgradeError)
  })

  test("bounds native reads with the abort deadline", async () => {
    await expect(verifyRestoredRuntimeUpgrade({
      pending: pending(), client: client({ hang: true }), actualTargetImage: targetImage,
      eventPersistence: true, currentGeneration: "gen_new", timeoutMs: 5,
    })).rejects.toThrow("timed out or was cancelled")
  })
})
