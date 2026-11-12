import { describe, expect, test } from "bun:test"
import { accountSeedContainsStow } from "../control-server"

describe("account seed member boundary", () => {
  test.each([
    ["top-level Stow directory", "./stow/registry/workspace.json\n"],
    ["dot-prefixed root", ".//stow/identity.json\n"],
    ["repeated dot root", "././stow/registry/id.json\n"],
    ["backslash root spelling", ".\\stow\\identity.json\n"],
    ["top-level Stow file", "stow\n"],
  ])("rejects %s", (_label, members) => {
    expect(accountSeedContainsStow(members)).toBe(true)
  })

  test.each([
    ["Stow-like setting name", "./stow-settings.json\n"],
    ["nested Stow directory", "./config/stow/credentials.json\n"],
    ["nested workspace folder", "./workspace/stow/manifest.json\n"],
    ["initialization marker", "./initialized\n"],
    ["empty root member", "./\n"],
  ])("allows %s", (_label, members) => {
    expect(accountSeedContainsStow(members)).toBe(false)
  })
})
