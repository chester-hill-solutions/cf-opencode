import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { runtimePaths, serverOptions } from "./options.ts"

// Validate and create the trusted paths before importing Effect or OpenCode:
// their module initialization reads global paths from the environment.
const paths = runtimePaths(process.env)
for (const path of Object.values(paths)) mkdirSync(path, { recursive: true, mode: 0o700 })
for (const path of [paths.data, paths.config, paths.cache, paths.state, paths.log, paths.bin, paths.repos]) {
  if (resolve(path) !== paths.home && !resolve(path).startsWith(`${paths.home}/`)) {
    throw new Error("OpenCode persistent path escaped trusted HOME")
  }
}
if (process.env.XDG_DATA_HOME) process.env.XDG_DATA_HOME = resolve(process.env.XDG_DATA_HOME)

const [{ Effect, Schema }, { NodeServices }, { LayerNode }, { Global }, { AppProcess }, { PersistentPty }, { ServerProcess }] = await Promise.all([
  import("effect"),
  import("@effect/platform-node"),
  import("@opencode/util/effect/layer-node"),
  import("@opencode/util/global"),
  import("@opencode/util/process"),
  import("@opencode/schema/persistent-pty"),
  import("@opencode/server/process"),
])
const serverPackage = await import("@opencode/server/package.json" as string, { with: { type: "json" } })
const version = serverPackage.version

const channel = process.env.OPENCODE_CHANNEL ?? "latest"
const inheritedHandoff = process.env.OPENCODE_PTY_HANDOFF
delete process.env.OPENCODE_PTY_HANDOFF
let handoff
if (inheritedHandoff !== undefined) {
  try {
    handoff = Schema.decodeUnknownSync(Schema.fromJsonString(PersistentPty.Handoff))(inheritedHandoff)
  } catch {
    console.warn("Ignoring invalid PTY restart handoff; persistent terminals will start fresh")
  }
}

const options = {
  ...serverOptions(process.env, paths, version),
  pty: { handoff },
}

const runtimeLayer = LayerNode.compile(LayerNode.group([Global.node, AppProcess.node]), {
  replacements: [Global.node.replace(Global.layerWith({
    home: paths.home,
    data: paths.data,
    config: paths.config,
    cache: paths.cache,
    state: paths.state,
    log: paths.log,
    bin: paths.bin,
    repos: paths.repos,
    tmp: paths.tmp,
  }))],
})

const controller = new AbortController()
let signalCount = 0
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    signalCount++
    if (signalCount === 1) controller.abort()
    else process.exit(1)
  })
}

const program = Effect.scoped(Effect.gen(function* () {
  const global = yield* Global.Service
  const globals = [global.home, global.data, global.config, global.cache, global.state, global.log, global.bin, global.repos]
  if (globals.some((path) => resolve(path) !== paths.home && !resolve(path).startsWith(`${paths.home}/`))) {
    throw new Error("OpenCode global path escaped trusted HOME")
  }
  const server = yield* ServerProcess.start({ ...options, app: { ...options.app, channel } })
  console.log("OpenCode server ready", JSON.stringify({ hostname: server.address.hostname, port: server.address.port, eventPersistence: true }))
  yield* Effect.never
}))

try {
  const executable = program.pipe(Effect.provide(runtimeLayer), Effect.provide(NodeServices.layer)) as import("effect").Effect.Effect<void, unknown, never>
  await Effect.runPromise(executable, { signal: controller.signal })
} catch (error) {
  if (!controller.signal.aborted) {
    console.error("OpenCode evented runtime failed", error instanceof Error ? error.message : "unknown error")
    process.exitCode = 1
  }
}
