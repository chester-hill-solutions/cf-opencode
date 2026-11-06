import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

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

function filesUnder(dir: string, extensions: string[]): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(path, extensions))
    else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(path)
  }
  return found
}

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

  test("first-party UI avoids single-sided borders", () => {
    const sources = [
      ...filesUnder(join(root, "web"), [".tsx", ".css"]),
      join(root, "packages/ui/src/styles/aboiteau.css"),
    ]
    const declaration =
      /border-(?:top|right|bottom|left)(?:-(?:width|color|style))?\s*:\s*([^;]+)/
    const utility = /\bborder-(?:t|r|b|l)(?:\s|["'`]|$)/
    const utilityWidth = /\bborder-(?:t|r|b|l)-(?!0(?:[;\s]|$))[a-z0-9[]/
    const offenders: string[] = []
    for (const source of sources) {
      const isTsx = source.endsWith(".tsx")
      for (const [lineNumber, line] of readFileSync(source, "utf8").split("\n").entries()) {
        const declared = line.match(declaration)
        const nonZero = declared ? !/^0(?:\s|$)/.test(declared[1].trim()) : false
        if (nonZero || (isTsx && (utility.test(line) || utilityWidth.test(line)))) {
          offenders.push(`${relative(root, source)}:${lineNumber + 1}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
