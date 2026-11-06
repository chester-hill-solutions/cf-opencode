import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const componentsDir = join(root, "packages/ui/src/components/ui")
const manifest = JSON.parse(
  readFileSync(join(root, "packages/ui/.chs-ui.json"), "utf8")
) as { components: string[] }
const files = readdirSync(componentsDir)
  .filter((file) => file.endsWith(".tsx"))
  .map((file) => file.replace(/\.tsx$/, ""))
  .sort()
const index = readFileSync(join(root, "packages/ui/src/index.ts"), "utf8")
const theme = readFileSync(join(root, "packages/ui/src/styles/aboiteau.css"), "utf8")

describe("@aboiteau/ui registry", () => {
  test("the manifest lists every vendored CHS component", () => {
    expect([...manifest.components].sort()).toEqual(files)
  })

  test("every vendored component has a public export path", () => {
    for (const file of files) {
      expect(index).toContain(`./components/ui/${file}"`)
    }
  })

  test("the brand accent set is defined for every brand colour", () => {
    for (const accent of ["ultramarine", "vermilion", "yellow", "pink", "paper", "ink"]) {
      expect(theme).toContain(`[data-accent="${accent}"]`)
    }
  })

  test("chart and sidebar primitives receive Aboiteau tokens", () => {
    for (const token of ["--chart-1", "--chart-5", "--sidebar", "--sidebar-ring"]) {
      expect(theme).toContain(`${token}:`)
    }
  })
})
