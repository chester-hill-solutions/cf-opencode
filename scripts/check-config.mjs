#!/usr/bin/env bun
/**
 * Guards against prod/test config drift (audit finding 21).
 *
 * The two Wrangler configs are allowed to differ in identity (name, account,
 * bucket name), compatibility date (the test runtime lags production), and
 * containers (never started in tests). Everything a Worker depends on at
 * runtime — the entrypoint, compatibility flags, DO classes and bindings, R2
 * bindings, exports, and vars — must line up, or a binding added to one file
 * silently goes missing in the other. The exact test-only Lifecycle wrapper
 * is validated before normalizing its one probe out of those comparisons.
 */
import { readFileSync } from "node:fs"
import { LIFECYCLE_TEST_ENTRY, normalizeLifecycleTestBoundary } from "./config-test-boundary.ts"

const PROD = "wrangler.jsonc"
const TEST = "wrangler.test.jsonc"

/** Intentional differences, checked by hand and documented here. */
const ALLOWED_DIFFERENCES = [
  "name",
  "account_id",
  "compatibility_date",
  "containers",
  "observability",
  "r2_buckets[].bucket_name",
]

function parse(path) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1")
  return JSON.parse(source)
}

function names(list, key) {
  return (list ?? []).map((entry) => entry[key]).sort()
}

function compare(label, prod, test, problems) {
  const a = JSON.stringify(prod)
  const b = JSON.stringify(test)
  if (a !== b) problems.push(`${label}\n    prod: ${a}\n    test: ${b}`)
}

const prod = parse(PROD)
const testSource = parse(TEST)
const wrapper = testSource.main === LIFECYCLE_TEST_ENTRY
  ? readFileSync(new URL(`../${LIFECYCLE_TEST_ENTRY}`, import.meta.url), "utf8")
  : ""
const { config: test, problems } = normalizeLifecycleTestBoundary(prod, testSource, wrapper)

compare("main", prod.main, test.main, problems)
compare("compatibility_flags", [...(prod.compatibility_flags ?? [])].sort(), [...(test.compatibility_flags ?? [])].sort(), problems)
compare(
  "durable_objects.bindings",
  names(prod.durable_objects?.bindings, "name"),
  names(test.durable_objects?.bindings, "name"),
  problems,
)
compare(
  "durable_objects.bindings class_name",
  names(prod.durable_objects?.bindings, "class_name"),
  names(test.durable_objects?.bindings, "class_name"),
  problems,
)
compare("r2_buckets bindings", names(prod.r2_buckets, "binding"), names(test.r2_buckets, "binding"), problems)
const rateLimits = (config) =>
  (config.ratelimits ?? [])
    .map((entry) => `${entry.name}:${entry.namespace_id}:${entry.simple?.limit}/${entry.simple?.period}`)
    .sort()
compare("ratelimits", rateLimits(prod), rateLimits(test), problems)
compare("exports", Object.keys(prod.exports ?? {}).sort(), Object.keys(test.exports ?? {}).sort(), problems)
const exportShape = (config) =>
  Object.keys(config.exports ?? {})
    .sort()
    .map((key) => `${key}:${config.exports[key].type}:${config.exports[key].storage ?? "-"}`)
compare("exports shape", exportShape(prod), exportShape(test), problems)
compare("assets.directory", prod.assets?.directory, test.assets?.directory, problems)
compare("build", prod.build, test.build, problems)

// Test-only bindings belong in vitest.config.ts, not in the test Wrangler file.
compare("vars", Object.keys(prod.vars ?? {}).sort(), Object.keys(test.vars ?? {}).sort(), problems)

if (problems.length) {
  console.error(`config drift between ${PROD} and ${TEST}:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(`\nIntentional differences: ${ALLOWED_DIFFERENCES.join(", ")}`)
  process.exit(1)
}

console.log(`configs agree (${PROD} ↔ ${TEST})`)
