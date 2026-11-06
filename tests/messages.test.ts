import { describe, expect, test } from "bun:test"
import { isSettled, latestAssistantReply, type MessageInfo } from "../src/messages"

const user = (text: string): MessageInfo => ({ type: "user", content: [{ type: "text", text }] })
const assistant = (texts: string[], completed?: boolean): MessageInfo => ({
  type: "assistant",
  content: texts.map((text) => ({ type: "text", text })),
  ...(completed ? { time: { created: 1, completed: 2 } } : {}),
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
})

describe("isSettled", () => {
  test("false while the assistant message is still open", () => {
    expect(isSettled([user("go"), assistant(["working"])])).toBe(false)
  })

  test("true when the latest assistant message completed", () => {
    expect(isSettled([user("go"), assistant(["done"], true)])).toBe(true)
  })

  test("uses finish when present", () => {
    expect(isSettled([{ type: "assistant", content: [], finish: "stop" }])).toBe(true)
  })
})
