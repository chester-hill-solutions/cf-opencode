import { describe, expect, test } from "bun:test"
import { buildAgentCommand } from "../control-server"

describe("agent privilege drop", () => {
  test("wraps a command with setpriv for the configured agent id", () => {
    expect(buildAgentCommand(["opencode", "serve"], 1001, 1001)).toEqual([
      "setpriv",
      "--reuid",
      "1001",
      "--regid",
      "1001",
      "--init-groups",
      "--",
      "opencode",
      "serve",
    ])
  })
})
