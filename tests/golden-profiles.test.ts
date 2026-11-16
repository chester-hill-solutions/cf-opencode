import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import {
  CHS_PROFILES,
  GOLDEN_PROFILES,
  GOLDEN_RULES,
  type GoldenProfileId,
} from "@chester-hill-solutions/ratchet-strap"

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>
}
const ci = manifest.scripts["ci:local"] ?? ""
const quality = manifest.scripts["check:quality"] ?? ""

type Status = "on" | "partial" | "not-applicable"
type Coverage = {
  status: Status
  /** Package scripts that prove the profile in this repository. */
  gates?: string[]
  /** ESLint rule ids that prove the profile in this repository. */
  rules?: string[]
  /** Test files that carry the profile's evidence. */
  evidence?: string[]
  reason?: string
}

/** Every profile must be on, partial with a reason, or explicitly not applicable. */
const PROFILE_COVERAGE: Record<GoldenProfileId, Coverage> = {
  typescript: { status: "on", gates: ["check:strict-types"] },
  react: { status: "on", rules: ["gold/lifecycle-state", "gold/effect-contract"] },
  "react-router": {
    status: "not-applicable",
    reason: "Aboiteau is not a React Router application",
  },
  web: { status: "on", gates: ["check:client-bundle"] },
  ui: {
    status: "partial",
    gates: ["test"],
    evidence: ["tests/ui-kit.test.ts"],
    reason: "the registry and theme contract are tested; page adoption is review-only",
  },
  quality: {
    status: "on",
    gates: ["check:dry", "check:file-size"],
    rules: ["gold/async-sequencing"],
  },
  telemetry: { status: "on", gates: ["check:telemetry"] },
  release: {
    status: "not-applicable",
    reason: "Aboiteau is a private application and is not published",
  },
  vault: {
    status: "partial",
    gates: ["test", "check:lint-ratchet"],
    evidence: [
      "tests/vault.test.ts",
      "tests/archive-crypto.test.ts",
      "tests/archive-policy.test.ts",
      "tests/secret-read-policy.test.ts",
      "test/checkpoint-encryption.test.ts",
    ],
    reason: "ciphertext, tenant keys, secret-read allowlist and baseline rules are tested; no single G1–G13 gate",
  },
}

/** Every open-source default must name its local evidence or an explicit exception. */
const DEFAULT_COVERAGE: Record<string, Coverage> = {
  U1: { status: "on", gates: ["check:quality"] },
  U2: { status: "on", gates: ["check:quality"] },
  U3: { status: "on", gates: ["check:lint-ratchet"] },
  U4: { status: "on", gates: ["check:lint-ratchet"] },
  U5: { status: "partial", rules: ["@typescript-eslint/ban-ts-comment"], reason: "narrow ts exemptions are linted; baseline exemptions are reviewed" },
  U6: { status: "on", gates: ["ci:local"] },
  U7: { status: "partial", gates: ["build:ui"], reason: "the UI build runs, but generated output is not diff-gated" },
  U8: { status: "on", rules: ["gold/mock-passthrough"] },
  U9: { status: "partial", gates: ["check:client-bundle"], reason: "covers client bundles only" },
  U10: { status: "not-applicable", reason: "Aboiteau is a private application" },
  U11: { status: "on", rules: ["gold/mock-passthrough"] },
  U12: { status: "partial", gates: ["check:lint-ratchet"], reason: "suppressed diagnostics count, but no opt-out audit exists" },
}

const runsInCi = (gate: string) =>
  ci.includes(`bun run ${gate}`) || quality.includes(`bun run ${gate}`)

describe("RatchetStrap golden profiles", () => {
  test("the package still exposes twelve defaults and nine profiles", () => {
    expect(GOLDEN_RULES.map((rule) => rule.id)).toEqual([
      "U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8", "U9", "U10", "U11", "U12",
    ])
    expect(Object.keys(GOLDEN_PROFILES).sort()).toEqual([
      "quality", "react", "react-router", "release", "telemetry", "typescript", "ui", "vault", "web",
    ])
    expect([...CHS_PROFILES].sort() as string[]).toEqual(Object.keys(GOLDEN_PROFILES).sort())
  })

  test("every profile is mapped to this repository's evidence or an exception", () => {
    expect(Object.keys(PROFILE_COVERAGE).sort()).toEqual(Object.keys(GOLDEN_PROFILES).sort())
    for (const [id, coverage] of Object.entries(PROFILE_COVERAGE)) {
      expect(["on", "partial", "not-applicable"]).toContain(coverage.status)
      if (coverage.status !== "on") expect(coverage.reason, `${id} needs a reason`).toBeTruthy()
      for (const gate of coverage.gates ?? []) {
        expect(manifest.scripts[gate], `${id} gate ${gate} is missing`).toBeDefined()
        expect(runsInCi(gate), `${id} gate ${gate} is not in ci:local`).toBe(true)
      }
      for (const file of coverage.evidence ?? []) {
        expect(existsSync(new URL(`../${file}`, import.meta.url)), `${id} evidence ${file} is missing`).toBe(true)
      }
    }
  })

  test("every open-source default has local evidence or an exception", () => {
    expect(Object.keys(DEFAULT_COVERAGE).sort()).toEqual(GOLDEN_RULES.map((rule) => rule.id).sort())
    for (const [id, coverage] of Object.entries(DEFAULT_COVERAGE)) {
      if (coverage.status !== "on") expect(coverage.reason, `${id} needs a reason`).toBeTruthy()
      if (coverage.status === "not-applicable") continue
      expect((coverage.gates?.length ?? 0) + (coverage.rules?.length ?? 0)).toBeGreaterThan(0)
    }
  })

  test("the profile rule ids match the catalog so a new rule cannot arrive unowned", () => {
    const ids = Object.fromEntries(
      Object.entries(GOLDEN_PROFILES).map(([id, rules]) => [id, rules.map((rule) => rule.id)])
    )
    expect(ids).toEqual({
      typescript: ["ts.strict", "ts.no-escape"],
      react: ["react.state-machine", "react.effects"],
      "react-router": ["router.loaders", "router.authorization", "router.request-integrity"],
      web: ["web.client-bundle"],
      ui: ["ui.design-system"],
      quality: ["quality.duplication", "quality.file-size", "quality.async-sequencing"],
      telemetry: ["telemetry.boundaries"],
      release: ["release.versioned", "release.adr"],
      vault: [
        "G1", "G2", "G3", "G4", "G5", "G6", "G7",
        "G8", "G9", "G10", "G11", "G12", "G13",
      ],
    })
  })
})
