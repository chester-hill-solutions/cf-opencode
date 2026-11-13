export const LIFECYCLE_TEST_ENTRY = "./test/fixtures/worker.ts"

type Binding = { name: string; class_name: string; [key: string]: unknown }
type Export = { type: string; storage?: string; [key: string]: unknown }
interface RuntimeConfig {
  main?: string
  durable_objects?: { bindings?: Binding[]; [key: string]: unknown }
  exports?: Record<string, Export>
  [key: string]: unknown
}

const WRAPPER_LINES = [
  'export { default } from "../../src/index"',
  'export { Conversation } from "../../src/conversation"',
  'export { Settings } from "../../src/settings-do"',
  'export { LifecycleProbe } from "./lifecycle-host"',
]

/** Permit only the test-only bridge; all runtime config comparisons still run. */
export function normalizeLifecycleTestBoundary(
  production: RuntimeConfig,
  test: RuntimeConfig,
  wrapperSource = "",
): { config: RuntimeConfig; problems: string[] } {
  const problems: string[] = []
  const isProbe = (binding: Binding) => binding.name === "LIFECYCLE_PROBE" || binding.class_name === "LifecycleProbe"
  if (production.durable_objects?.bindings?.some(isProbe) || production.exports?.LifecycleProbe) {
    problems.push("LifecycleProbe must never be exported or bound in production")
  }
  if (test.main !== LIFECYCLE_TEST_ENTRY) return { config: test, problems }

  const lines = wrapperSource.split("\n").map((line) => line.trim()).filter(Boolean)
  if (production.main !== "src/index.ts" || JSON.stringify(lines) !== JSON.stringify(WRAPPER_LINES)) {
    problems.push("test entry must only re-export the production Worker and the allowlisted LifecycleProbe")
  }
  const probes = test.durable_objects?.bindings?.filter(isProbe) ?? []
  const probe = probes[0]
  if (probes.length !== 1 || probe?.name !== "LIFECYCLE_PROBE" || probe.class_name !== "LifecycleProbe" ||
    Object.keys(probe).sort().join(",") !== "class_name,name") {
    problems.push("test LifecycleProbe binding must be exactly the local LIFECYCLE_PROBE class binding")
  }
  const exported = test.exports?.LifecycleProbe
  if (!exported || exported.type !== "durable-object" || exported.storage !== "sqlite" ||
    Object.keys(exported).sort().join(",") !== "storage,type") {
    problems.push("test LifecycleProbe export must be exactly a SQLite Durable Object")
  }
  const { LifecycleProbe: _probe, ...runtimeExports } = test.exports ?? {}
  return {
    config: {
      ...test,
      main: production.main,
      durable_objects: {
        ...test.durable_objects,
        bindings: test.durable_objects?.bindings?.filter((binding) => !isProbe(binding)),
      },
      exports: runtimeExports,
    },
    problems,
  }
}
