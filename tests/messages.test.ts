import { describe, expect, test } from "bun:test"
import { isSettled, latestAssistantReply, turnMessages, type MessageInfo } from "../src/messages"

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
