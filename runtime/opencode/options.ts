import { isAbsolute, relative, resolve, sep, join } from "node:path"
import type { ServerOptions } from "@opencode/server/options"

export type RuntimeEnvironment = Record<string, string | undefined>

export interface RuntimePaths {
  home: string
  data: string
  config: string
  cache: string
  state: string
  log: string
  bin: string
  repos: string
  tmp: string
}

function requiredAbsolute(env: RuntimeEnvironment, name: string): string {
  const value = env[name]
  if (!value || !isAbsolute(value)) throw new Error("OpenCode runtime paths must be explicit absolute paths")
  return resolve(value)
}

function inside(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target))
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

/** Resolve all durable OpenCode locations without consulting host defaults. */
export function runtimePaths(env: RuntimeEnvironment): RuntimePaths {
  const home = requiredAbsolute(env, "HOME")
  const xdgData = requiredAbsolute(env, "XDG_DATA_HOME")
  const xdgConfig = requiredAbsolute(env, "XDG_CONFIG_HOME")
  const xdgCache = requiredAbsolute(env, "XDG_CACHE_HOME")
  const xdgState = requiredAbsolute(env, "XDG_STATE_HOME")
  const tmpdir = env.TMPDIR ? requiredAbsolute(env, "TMPDIR") : "/tmp"

  if (home === "/" || ![xdgData, xdgConfig, xdgCache, xdgState].every((path) => inside(home, path))) {
    throw new Error("OpenCode persistent paths must stay under the trusted HOME")
  }

  const data = join(xdgData, "opencode")
  const cache = join(xdgCache, "opencode")
  return {
    home,
    data,
    config: join(xdgConfig, "opencode"),
    cache,
    state: join(xdgState, "opencode"),
    log: join(data, "log"),
    bin: join(cache, "bin"),
    repos: join(data, "repos"),
    tmp: join(tmpdir, "opencode"),
  }
}

function truthy(value?: string): boolean {
  return value === "1" || value?.toLowerCase() === "true"
}

function databasePath(data: string, env: RuntimeEnvironment, channel: string): string {
  const filename = env.OPENCODE_DB ?? (
    ["latest", "dev", "beta", "next", "prod"].includes(channel) ||
    env.OPENCODE_DISABLE_CHANNEL_DB === "1" || env.OPENCODE_DISABLE_CHANNEL_DB === "true"
      ? "opencode.db"
      : `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`
  )
  if (filename === ":memory:") return filename
  const resolved = resolve(data, filename)
  if (!inside(data, resolved)) throw new Error("OpenCode database path must stay under XDG_DATA_HOME")
  return resolved
}

/** Build the same server options as the CLI, with durable events fixed on. */
export function serverOptions(
  env: RuntimeEnvironment,
  paths: RuntimePaths,
  version: string,
): ServerOptions {
  const password = env.OPENCODE_PASSWORD ?? env.OPENCODE_SERVER_PASSWORD
  if (!password) throw new Error("OpenCode server password is required")
  if (env.OPENCODE_PASSWORD && env.OPENCODE_SERVER_PASSWORD && env.OPENCODE_PASSWORD !== env.OPENCODE_SERVER_PASSWORD) {
    throw new Error("OpenCode server password environment is inconsistent")
  }

  const port = Number(env.OPENCODE_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("OpenCode loopback port is invalid")
  const channel = env.OPENCODE_CHANNEL ?? "latest"

  return {
    app: { name: env.OPENCODE_CLIENT ?? "opencode", version, channel },
    hostname: "127.0.0.1",
    port,
    password,
    events: { persist: true },
    database: { path: databasePath(paths.data, env, channel) },
    pty: { handoff: undefined },
    models: {
      url: env.OPENCODE_MODELS_URL,
      file: env.OPENCODE_MODELS_PATH,
      fetch: !truthy(env.OPENCODE_DISABLE_MODELS_FETCH),
    },
    config: {
      directory: env.OPENCODE_CONFIG_DIR,
      project: !truthy(env.OPENCODE_CONFIG_PROJECT_DISABLE ?? env.OPENCODE_DISABLE_PROJECT_CONFIG),
      claude: !(truthy(env.OPENCODE_DISABLE_CLAUDE_CODE) || truthy(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS)),
      file: env.OPENCODE_CONFIG,
      content: env.OPENCODE_CONFIG_CONTENT,
    },
    windows: { gitbash: env.OPENCODE_GIT_BASH_PATH },
    fs: {
      filewatcher: !truthy(env.OPENCODE_FILEWATCHER_DISABLE ?? env.OPENCODE_DISABLE_FILEWATCHER),
      fff: env.OPENCODE_DISABLE_FFF === undefined ? true : !truthy(env.OPENCODE_DISABLE_FFF),
    },
  }
}
