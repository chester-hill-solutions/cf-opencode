import { describe, expect, test } from "bun:test"
import { assertAccountingPolicy } from "../src/accounting-policy"

const document = (info: Record<string, unknown>) => ({ type: "document", info })

describe("assertAccountingPolicy", () => {
  test("accepts the runtime policy after a project override", () => {
    expect(() =>
      assertAccountingPolicy([
        document({
          experimental: { background_compaction: true },
          agents: { title: { disabled: false } },
        }),
        document({
          experimental: { background_compaction: false },
          agents: { title: { disabled: true } },
        }),
      ]),
    ).not.toThrow()
  })

  test("rejects a later managed config that re-enables detached usage", () => {
    expect(() =>
      assertAccountingPolicy([
        document({
          experimental: { background_compaction: false },
          agents: { title: { disabled: true } },
        }),
        document({
          experimental: { background_compaction: true },
          agents: { title: { disabled: false } },
        }),
      ]),
    ).toThrow("background_compaction is enabled")
  })

  test("rejects a later title-agent configuration that re-enables generation", () => {
    expect(() =>
      assertAccountingPolicy([
        document({
          experimental: { background_compaction: false },
          agents: { title: { disabled: true } },
        }),
        document({ agents: { title: { disabled: false } } }),
      ]),
    ).toThrow("title agent is enabled")
  })

  test("rejects missing policy and malformed config entries", () => {
    expect(() => assertAccountingPolicy([])).toThrow("enabled or missing")
    expect(() => assertAccountingPolicy([{ type: "document", info: null }])).toThrow("config document")
    expect(() =>
      assertAccountingPolicy([
        document({
          experimental: { background_compaction: false },
          agents: { title: { disabled: true } },
        }),
        { type: "directory" },
      ]),
    ).toThrow("directory entry")
  })
})
