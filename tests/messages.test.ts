import { describe, expect, test } from "bun:test"
import {
  failureKey,
  isSettled,
  latestAssistantReply,
  toMillis,
  turnFailure,
  turnMessages,
  type MessageInfo,
} from "../src/messages"

let nextID = 0
const user = (text: string): MessageInfo => ({
  id: `u${++nextID}`,
  type: "user",
  content: [{ type: "text", text }],
})
const assistant = (texts: string[], completed?: boolean, finish?: string): MessageInfo => ({
  id: `a${++nextID}`,
  type: "assistant",
  content: texts.map((text) => ({ type: "text", text })),
  ...(completed ? { time: { created: 1, completed: 2 } } : {}),
  ...(finish ? { finish } : {}),
})

describe("turnMessages", () => {
  test("uses everything after a known baseline assistant", () => {
    const old = assistant(["old"], true)
    const messages = [user("one"), old, user("two"), assistant(["new"])]
    expect(turnMessages(messages, old.id).map((message) => message.id)).toEqual(
      messages.slice(2).map((message) => message.id),
    )
  })

  test("falls back to the latest user when the baseline is gone", () => {
    const messages = [user("one"), assistant(["old"], true), user("two"), assistant(["new"])]
    expect(turnMessages(messages, "missing").map((message) => message.id)).toEqual(
      messages.slice(3).map((message) => message.id),
    )
  })
})

describe("latestAssistantReply", () => {
  test("returns text after the last user message", () => {
    expect(latestAssistantReply([user("one"), assistant(["a"]), user("two"), assistant(["b", "c"])])).toBe("b\n\nc")
  })

  test("ignores non-text parts", () => {
    const messages: MessageInfo[] = [
      user("go"),
      { type: "assistant", content: [{ type: "reasoning", text: "hidden" }, { type: "text", text: "shown" }] },
    ]
    expect(latestAssistantReply(messages)).toBe("shown")
  })

  test("is empty without assistant output", () => {
    expect(latestAssistantReply([user("hi")])).toBe("")
    expect(latestAssistantReply([])).toBe("")
  })

  test("ignores the previous turn when a baseline is known", () => {
    const old = assistant(["old answer"], true)
    const messages = [user("one"), old, user("two"), assistant(["new answer"])]
    expect(latestAssistantReply(messages, old.id)).toBe("new answer")
  })
})

describe("isSettled", () => {
  test("false while the assistant message is still open", () => {
    expect(isSettled([user("go"), assistant(["working"])])).toBe(false)
  })

  test("true when the latest assistant message completed", () => {
    expect(isSettled([user("go"), assistant(["done"], true)])).toBe(true)
  })

  test("uses a terminal finish when present", () => {
    expect(isSettled([{ type: "assistant", content: [], finish: "stop" }])).toBe(true)
  })

  test("false when a new user message has no answer yet", () => {
    const messages = [user("one"), assistant(["first answer"], true), user("two")]
    expect(isSettled(messages)).toBe(false)
  })

  test("false while the turn is still waiting on tools", () => {
    const messages = [user("go"), assistant(["calling a tool"], true, "tool-calls")]
    expect(isSettled(messages)).toBe(false)
  })

  test("true after the final step of a tool-using turn", () => {
    const messages = [
      user("go"),
      assistant(["calling a tool"], true, "tool-calls"),
      assistant(["final answer"], true, "stop"),
    ]
    expect(isSettled(messages)).toBe(true)
  })

  test("does not settle a new turn that has no assistant yet", () => {
    const old = assistant(["first answer"], true)
    const messages = [user("one"), old, user("two")]
    expect(isSettled(messages, old.id)).toBe(false)
  })

  test("does not settle before the new user message reaches the context", () => {
    const old = assistant(["first answer"], true)
    expect(isSettled([user("one"), old], old.id)).toBe(false)
  })

  test("empty history is not settled", () => {
    expect(isSettled([])).toBe(false)
  })
})

describe("turnFailure", () => {
  const idle = (error?: unknown, created?: number): MessageInfo => ({
    type: "idle",
    ...(created ? { time: { created } } : {}),
    ...(error ? { error: error as MessageInfo["error"] } : {}),
  })

  test("reports a provider error on the terminal idle message", () => {
    const messages = [
      user("go"),
      idle({ type: "provider.no-route", message: "Model unavailable: opencode/deepseek-v4.1-flash" }, 20),
    ]
    expect(turnFailure(messages)).toEqual({
      message: "Model unavailable: opencode/deepseek-v4.1-flash",
      at: 20,
    })
  })

  test("accepts a plain string error", () => {
    expect(turnFailure([user("go"), idle("boom", 5)])?.message).toBe("boom")
  })

  test("falls back to the error type and then to a generic message", () => {
    expect(turnFailure([user("go"), idle({ type: "rate_limited" })])?.message).toBe("rate_limited")
    expect(turnFailure([user("go"), idle({})])?.message).toBe("run failed")
    expect(turnFailure([user("go"), idle({ message: "" }, 1)])?.message).toBe("run failed")
  })

  test("ignores an idle message without an error", () => {
    expect(turnFailure([user("go"), idle(undefined, 5)])).toBeUndefined()
  })

  test("ignores a failure from before this run started", () => {
    const runStartedAt = 1_700_000_000_000
    const old = assistant(["previous answer"], true)
    const messages = [user("one"), old, idle({ message: "stale" }, runStartedAt - 10), user("two")]
    expect(turnFailure(messages, old.id, runStartedAt)).toBeUndefined()
  })

  test("reports a failure created during this run", () => {
    const runStartedAt = 1_700_000_000_000
    const old = assistant(["previous answer"], true)
    const messages = [user("one"), old, idle({ message: "fresh" }, runStartedAt + 10), user("two")]
    expect(turnFailure(messages, old.id, runStartedAt)?.message).toBe("fresh")
  })

  test("reports an error attached to a completed assistant step", () => {
    // A failed step still completes, with an empty body, so settlement would
    // otherwise look successful and the user would see nothing.
    const failed: MessageInfo = {
      id: "a-failed",
      type: "assistant",
      content: [],
      finish: "error",
      time: { created: 20, completed: 21 },
      error: { type: "provider.error", message: "Model unavailable: opencode/deepseek-v4.1-flash" },
    }
    expect(isSettled([user("go"), failed])).toBe(true)
    expect(turnFailure([user("go"), failed])).toEqual({
      message: "Model unavailable: opencode/deepseek-v4.1-flash",
      at: 20,
    })
  })

  test("ignores a completed assistant step without an error", () => {
    expect(turnFailure([user("go"), assistant(["done"], true, "stop")])).toBeUndefined()
  })

  test("keys a failure by time and message so a repeat poll is deduped", () => {
    const first = turnFailure([idle({ message: "boom" }, 20)])
    const same = turnFailure([idle({ message: "boom" }, 20)])
    const later = turnFailure([idle({ message: "boom" }, 21)])
    expect(first && same && later).toBeTruthy()
    expect(failureKey(first!)).toBe(failureKey(same!))
    expect(failureKey(first!)).not.toBe(failureKey(later!))
  })

  test("normalises second and millisecond timestamps before comparing", () => {
    expect(toMillis(1_700_000_000)).toBe(1_700_000_000_000)
    expect(toMillis(1_700_000_000_000)).toBe(1_700_000_000_000)
  })

  test("does not treat a seconds-based failure as stale", () => {
    const runStartedAt = Date.parse("2026-11-07T12:00:00.000Z")
    const seconds = Math.floor(runStartedAt / 1000) + 5
    expect(turnFailure([user("go"), idle({ message: "boom" }, seconds)], undefined, runStartedAt)).toEqual({
      message: "boom",
      at: seconds,
    })
  })
})
