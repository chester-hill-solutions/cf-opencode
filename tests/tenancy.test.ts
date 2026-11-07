import { describe, expect, test } from "bun:test"
import {
  accountStateKey,
  agentKeyPrefix,
  conversationKey,
  parseConversationKey,
  resolveAgentForChannel,
  validAgentRef,
  type TenancyDatabase,
} from "../src/tenancy"

const AGENT = { tenantID: "tenant-1", agentID: "agent-1" }

function fakeDatabase(row: unknown) {
  const calls: Array<{ query: string; values: unknown[] }> = []
  const db: TenancyDatabase = {
    prepare(query) {
      return {
        bind(...values) {
          calls.push({ query, values })
          return { first: async <T>() => row as T | null }
        },
      }
    },
  }
  return { db, calls }
}

describe("conversation namespacing", () => {
  test("puts an agent prefix in front of the legacy key", () => {
    expect(agentKeyPrefix(AGENT)).toBe("tenant:tenant-1:agent:agent-1:")
    expect(conversationKey(AGENT, "C1:123.456")).toBe(
      "tenant:tenant-1:agent:agent-1:C1:123.456",
    )
  })

  test("round-trips a namespaced key and leaves legacy keys alone", () => {
    const key = conversationKey(AGENT, "C1:dm")
    expect(parseConversationKey(key)).toEqual(AGENT)
    expect(parseConversationKey("C1:dm")).toBeUndefined()
    expect(parseConversationKey(undefined)).toBeUndefined()
  })

  test("rejects malformed or unsafe ids", () => {
    expect(() =>
      conversationKey({ tenantID: "tenant/../x", agentID: "a" }, "C1:dm"),
    ).toThrow(/invalid/)
    expect(parseConversationKey("tenant:a:agent:b:C1")).toEqual({
      tenantID: "a",
      agentID: "b",
    })
    expect(parseConversationKey("tenant::agent:b:C1")).toBeUndefined()
    expect(parseConversationKey("tenant:a:agent::C1")).toBeUndefined()
    expect(validAgentRef({ tenantID: "", agentID: "a" })).toBe(false)
  })

  test("keeps namespaced account seeds separate from the legacy one", () => {
    expect(accountStateKey(AGENT)).toBe(
      "tenants/tenant-1/agents/agent-1/account/state.tar.gz",
    )
    expect(accountStateKey(undefined)).toBe("account/state.tar.gz")
  })
})

describe("channel resolution", () => {
  test("binds the Slack team and channel as parameters", async () => {
    const { db, calls } = fakeDatabase({ tenant_id: "tenant-1", agent_id: "agent-1" })
    const agent = await resolveAgentForChannel({ TENANCY: db }, "T1", "C1")
    expect(agent).toEqual(AGENT)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.query).toContain("channel_bindings")
    expect(calls[0]!.values).toEqual(["T1", "C1"])
  })

  test("stays legacy when D1 or the binding is absent", async () => {
    expect(await resolveAgentForChannel({}, "T1", "C1")).toBeUndefined()
    const { db } = fakeDatabase(null)
    expect(await resolveAgentForChannel({ TENANCY: db }, "T1", "C1")).toBeUndefined()
    expect(await resolveAgentForChannel({ TENANCY: db }, undefined, "C1")).toBeUndefined()
  })

  test("ignores a row with an unsafe id", async () => {
    const { db } = fakeDatabase({ tenant_id: "../evil", agent_id: "agent-1" })
    expect(await resolveAgentForChannel({ TENANCY: db }, "T1", "C1")).toBeUndefined()
  })
})
