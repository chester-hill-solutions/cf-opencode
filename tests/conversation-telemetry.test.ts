import { describe, expect, test } from "bun:test"

const { emitConversationTelemetry } = await import("../src/conversation/telemetry")

describe("conversation lifecycle telemetry", () => {
  test("builds the versioned envelope with only stable transition fields", () => {
    let emitted: unknown
    emitConversationTelemetry({
      event: "turn.settled",
      conversationID: "conv_123",
      sessionID: "ses_456",
      turnID: "turn_789",
      jobID: "turn:observe",
      runtimeGeneration: 4,
      attempt: 2,
      result: "succeeded",
      durationMs: 125,
      reasonCode: "completed",
      // Runtime callers may be untyped; these must never pass through.
      prompt: "private prompt",
      token: "secret",
      payload: { authorization: "secret" },
    } as never, (event) => { emitted = event })

    expect(emitted).toMatchObject({
      schemaVersion: 1,
      event: "turn.settled",
      component: "turns",
      conversationID: "conv_123",
      sessionID: "ses_456",
      turnID: "turn_789",
      jobID: "turn:observe",
      runtimeGeneration: 4,
      attempt: 2,
      result: "succeeded",
      durationMs: 125,
      reasonCode: "completed",
    })
    expect((emitted as Record<string, unknown>).at).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(emitted).not.toHaveProperty("prompt")
    expect(emitted).not.toHaveProperty("token")
    expect(emitted).not.toHaveProperty("payload")
    expect(emitted).not.toHaveProperty("traceId")
  })

  test("drops unsafe identifiers and free-form values instead of logging them", () => {
    let emitted: unknown
    emitConversationTelemetry({
      event: "checkpoint.failed",
      conversationID: "prompt:private content",
      jobID: "Bearer secret",
      reasonCode: "failed: user prompt was private",
      result: "failed",
      durationMs: Number.POSITIVE_INFINITY,
      attempt: -1,
    } as never, (event) => { emitted = event })

    expect(emitted).toMatchObject({ event: "checkpoint.failed", component: "checkpoints", result: "failed" })
    expect(emitted).not.toHaveProperty("conversationID")
    expect(emitted).not.toHaveProperty("jobID")
    expect(emitted).not.toHaveProperty("reasonCode")
    expect(emitted).not.toHaveProperty("durationMs")
    expect(emitted).not.toHaveProperty("attempt")
  })

  test("includes only a valid trace ID returned by the optional getter", () => {
    let emitted: unknown
    emitConversationTelemetry({ event: "admission.started" }, (event) => { emitted = event }, () => "a".repeat(32))
    expect(emitted).toMatchObject({ traceId: "a".repeat(32) })

    emitConversationTelemetry({ event: "admission.started" }, (event) => { emitted = event }, () => "Bearer private")
    expect(emitted).not.toHaveProperty("traceId")
  })

  test("swallows trace getter and sink failures", () => {
    expect(() => emitConversationTelemetry({ event: "lease.failed" }, () => {
      throw new Error("test sink failed")
    }, () => { throw new Error("trace provider unavailable") })).not.toThrow()

    let emitted: unknown
    expect(() => emitConversationTelemetry({ event: "container.stopped" }, (event) => {
      emitted = event
    }, () => { throw new Error("trace provider unavailable") })).not.toThrow()
    expect(emitted).toMatchObject({ event: "container.stopped", component: "runtime" })
    expect(emitted).not.toHaveProperty("traceId")
  })
})
