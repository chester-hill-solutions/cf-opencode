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
      bytes: 2048,
      count: 3,
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
      bytes: 2048,
      count: 3,
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
      bytes: Number.POSITIVE_INFINITY,
      count: -1,
      attempt: -1,
    } as never, (event) => { emitted = event })

    expect(emitted).toMatchObject({ event: "checkpoint.failed", component: "checkpoints", result: "failed" })
    expect(emitted).not.toHaveProperty("conversationID")
    expect(emitted).not.toHaveProperty("jobID")
    expect(emitted).not.toHaveProperty("reasonCode")
    expect(emitted).not.toHaveProperty("durationMs")
    expect(emitted).not.toHaveProperty("bytes")
    expect(emitted).not.toHaveProperty("count")
    expect(emitted).not.toHaveProperty("attempt")
  })

  test("includes only a valid trace ID returned by the optional getter", () => {
    let emitted: unknown
    emitConversationTelemetry({ event: "admission.started" }, (event) => { emitted = event }, () => "a".repeat(32))
    expect(emitted).toMatchObject({ traceId: "a".repeat(32) })

    emitConversationTelemetry({ event: "admission.started" }, (event) => { emitted = event }, () => "Bearer private")
    expect(emitted).not.toHaveProperty("traceId")
  })

  test("types lease and permission outcomes while dropping request data", () => {
    let emitted: unknown
    emitConversationTelemetry({
      event: "lease.renewed",
      conversationID: "conv_456",
      result: "renewed",
      reasonCode: "acquire_or_refresh",
      requestID: "private-request-id",
    } as never, (event) => { emitted = event })
    expect(emitted).toMatchObject({
      event: "lease.renewed",
      component: "leases",
      conversationID: "conv_456",
      result: "renewed",
      reasonCode: "acquire_or_refresh",
    })
    expect(emitted).not.toHaveProperty("requestID")

    emitConversationTelemetry({
      event: "permission.reply.blocked",
      conversationID: "conv_456",
      result: "blocked",
      reasonCode: "unknown_request",
      requestID: "private-request-id",
    } as never, (event) => { emitted = event })
    expect(emitted).toMatchObject({
      event: "permission.reply.blocked",
      component: "permissions",
      result: "blocked",
      reasonCode: "unknown_request",
    })
    expect(emitted).not.toHaveProperty("requestID")
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
