import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { assertGoldSet, goldChecksV1, type GoldCheckId } from "@chester-hill-solutions/ratchet-strap"

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  devDependencies: Record<string, string>
  scripts: Record<string, string>
}
const provenance = JSON.parse(
  readFileSync(new URL("../tools/vendor/ratchet-strap-provenance.json", import.meta.url), "utf8")
) as { version: string; artifactSha256: string }

/** Every gold member must name the local gate, baseline and fault/control fixture. */
const gates: Record<GoldCheckId, { script: string; baseline?: string; fixture: string }> = {
  "lint-identities": {
    script: "check:lint-ratchet",
    baseline: "scripts/baselines/lint-ratchet.json",
    fixture: "identities",
  },
  "strict-compiler": {
    script: "check:strict-types",
    baseline: "scripts/baselines/strict-types.json",
    fixture: "strictTypes",
  },
  duplication: {
    script: "check:dry",
    baseline: "scripts/baselines/duplication.json",
    fixture: "duplication",
  },
  "telemetry-boundaries": {
    script: "check:telemetry",
    baseline: "scripts/baselines/telemetry.json",
    fixture: "telemetry",
  },
  "file-size": {
    script: "check:file-size",
    baseline: "scripts/baselines/file-size.json",
    fixture: "fileSize",
  },
  "client-bundle": { script: "check:client-bundle", fixture: "bundle" },
}

describe("RatchetStrap gold set", () => {
  test("the shipped catalog validates", () => {
    expect(() => assertGoldSet()).not.toThrow()
  })

  test("every member maps to one local gate and fixture", () => {
    expect(Object.keys(gates).sort()).toEqual(goldChecksV1.map((check) => check.id).sort())
    for (const check of goldChecksV1) {
      const gate = gates[check.id]
      expect(gate, `missing gate for ${check.id}`).toBeDefined()
      expect(manifest.scripts[gate.script], `${gate.script} is not a script`).toBeDefined()
      if (check.baseline === "ratcheted") {
        expect(gate.baseline, `${check.id} needs a baseline`).toBeDefined()
        expect(existsSync(new URL(`../${gate.baseline}`, import.meta.url)), gate.baseline).toBe(true)
      } else {
        expect(check.baseline).toBe("none")
        expect(gate.baseline).toBeUndefined()
      }
    }
  })

  test("ci:local runs every member before the tests", () => {
    const gate = manifest.scripts["ci:local"] ?? ""
    const quality = manifest.scripts["check:quality"] ?? ""
    expect(gate).not.toBe("")
    expect(quality).not.toBe("")
    for (const check of goldChecksV1) {
      const command = `bun run ${gates[check.id].script}`
      expect(gate.includes(command) || quality.includes(command), command).toBe(true)
    }
    expect(gate.indexOf("check:quality")).toBeLessThan(gate.indexOf("bun run test"))
    expect(gate.indexOf("check:client-bundle")).toBeLessThan(gate.indexOf("bun run test"))
  })

  test("every member has an executable fault/control fixture", () => {
    const fixture = readFileSync(new URL("../tests/fixtures/gold-quality.mjs", import.meta.url), "utf8")
    for (const check of goldChecksV1) {
      expect(fixture).toContain(`  ${gates[check.id].fixture}() {`)
    }
  })

  test("the vendored artifact matches its recorded provenance", () => {
    const dependency = manifest.devDependencies["@chester-hill-solutions/ratchet-strap"] ?? ""
    expect(dependency).not.toBe("")
    expect(dependency).toContain(provenance.version)
    const artifact = readFileSync(new URL(`../${dependency}`, import.meta.url))
    expect(createHash("sha256").update(artifact).digest("hex")).toBe(provenance.artifactSha256)
  })
})
