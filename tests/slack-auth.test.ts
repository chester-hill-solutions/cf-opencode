import { describe, expect, test } from "bun:test"
import { approvalVerdict, fetchChannelMembers } from "../src/slack-auth"

function pageFetch(pages: Array<{ ok?: boolean; members?: string[]; next?: string }>) {
  let index = 0
  return (async () => {
    const page = pages[Math.min(index++, pages.length - 1)]!
    return new Response(
      JSON.stringify({
        ok: page.ok ?? true,
        members: page.members ?? [],
        ...(page.next ? { response_metadata: { next_cursor: page.next } } : {}),
      }),
      { headers: { "content-type": "application/json" } },
    )
  }) as unknown as typeof fetch
}

describe("fetchChannelMembers", () => {
  test("pages until the cursor is empty", async () => {
    const fetchImpl = pageFetch([
      { members: ["U1", "U2"], next: "next" },
      { members: ["U3"] },
    ])
    const members = await fetchChannelMembers("C1", "token", fetchImpl)
    expect([...(members ?? [])].sort()).toEqual(["U1", "U2", "U3"])
  })

  test("returns undefined when membership cannot be proven", async () => {
    expect(await fetchChannelMembers("C1", "", pageFetch([{ members: ["U1"] }]))).toBeUndefined()
    expect(
      await fetchChannelMembers("C1", "token", pageFetch([{ ok: false }])),
    ).toBeUndefined()
  })

  test("does not return a partial set for a channel that is too large", async () => {
    const fetchImpl = pageFetch([{ members: ["U1"], next: "more" }])
    expect(await fetchChannelMembers("C1", "token", fetchImpl, 2)).toBeUndefined()
  })
})

describe("approvalVerdict", () => {
  test("allows any member of the message channel", () => {
    expect(
      approvalVerdict({
        userId: "U1",
        channelId: "C1",
        buttonChannel: "C1",
        members: new Set(["U1", "U2"]),
      }),
    ).toBe("allow")
  })

  test("denies a user outside the channel", () => {
    expect(
      approvalVerdict({ userId: "U9", channelId: "C1", members: new Set(["U1"]) }),
    ).toBe("deny")
  })

  test("rejects a button from another channel", () => {
    expect(
      approvalVerdict({
        userId: "U1",
        channelId: "C1",
        buttonChannel: "C2",
        members: new Set(["U1"]),
      }),
    ).toBe("wrong_channel")
  })

  test("fails closed when the payload or membership is missing", () => {
    expect(approvalVerdict({ channelId: "C1", members: new Set(["U1"]) })).toBe("unverifiable")
    expect(approvalVerdict({ userId: "U1", members: new Set(["U1"]) })).toBe("unverifiable")
    expect(approvalVerdict({ userId: "U1", channelId: "C1" })).toBe("unverifiable")
  })
})
