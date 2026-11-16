import { homedir } from "node:os"

const CONSOLE_SERVER = "https://opencode.ai/console"
const WORKSPACE = "Chester Hill Solutions"
const REQUIRED_LIFETIME_MS = 45 * 60_000
const TARGET_MODEL = "deepseek-v4.1-flash"
const MAX_JSON_BYTES = 1_048_576

export type ActiveConsoleCredential = {
  token: string
  orgID: string
  expiresAt: number
  credentialID: string
  workspace: string
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const safeID = (value: unknown, maximum = 200): value is string => typeof value === "string" && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value)

/** Select the CLI's explicit active device session; never fall back to a legacy API key. */
export function selectActiveConsoleCredential(input: unknown, now: number): ActiveConsoleCredential {
  if (!Number.isSafeInteger(now) || now < 0 || !Array.isArray(input)) throw new Error("invalid credential export or selection time")
  const active = input.filter(value => record(value) && value.integrationID === "opencode" && value.active === true)
  if (active.length !== 1) throw new Error("exactly one active OpenCode credential required")
  const entry: unknown = active[0]
  if (!record(entry) || !safeID(entry.id) || !record(entry.value)) throw new Error("malformed active OpenCode credential")
  const value = entry.value
  if (value.type !== "oauth" || value.methodID !== "device") throw new Error("active OpenCode device OAuth session required")
  if (typeof value.access !== "string" || value.access.length > 16_384 || !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(value.access)) throw new Error("malformed OAuth bearer token")
  if (!Number.isSafeInteger(value.expires) || Number(value.expires) <= now + REQUIRED_LIFETIME_MS || !Number.isFinite(new Date(Number(value.expires)).getTime())) throw new Error("active OAuth session needs more than 45 minutes remaining")
  if (!record(value.metadata) || value.metadata.server !== CONSOLE_SERVER || value.metadata.orgName !== WORKSPACE || !safeID(value.metadata.orgID, 128)) throw new Error("active OAuth session does not match the approved Console workspace")
  return { token: value.access, orgID: value.metadata.orgID, expiresAt: Number(value.expires), credentialID: entry.id, workspace: WORKSPACE }
}

async function boundedText(stream: ReadableStream<Uint8Array> | null, maximum: number): Promise<string> {
  if (!stream) return ""
  const reader = stream.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maximum) throw new Error("credential verification output exceeded its bound")
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder().decode(bytes)
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

async function within<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("credential verification timed out")), milliseconds) })]) }
  finally { if (timer) clearTimeout(timer) }
}

async function exportCredentials(): Promise<unknown> {
  const child = Bun.spawn(["opencode", "auth", "export", "opencode"], { cwd: homedir(), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  try {
    const [code, stdout] = await within(Promise.all([child.exited, boundedText(child.stdout, MAX_JSON_BYTES), boundedText(child.stderr, 16_384)]), 20_000)
    if (code !== 0) throw new Error("credential export failed")
    try { return JSON.parse(stdout) as unknown } catch { throw new Error("credential export was not valid JSON") }
  } catch { throw new Error("OpenCode active credential export failed; no legacy-key fallback attempted") }
  finally { if (child.exitCode === null) { try { child.kill(9) } catch {} } }
}

type VerificationFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
export type ConsoleCredentialLoaderOptions = {
  now?: () => number
  exportCredentials?: () => Promise<unknown>
  fetch?: VerificationFetch
}

async function verifyJSON(url: string, credential: ActiveConsoleCredential, transport: VerificationFetch): Promise<unknown> {
  const response = await transport(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { authorization: "Bearer " + credential.token, "x-org-id": credential.orgID, accept: "application/json" } })
  if (response.status !== 200) { void response.body?.cancel().catch(() => {}); throw new Error("Console credential verification did not return HTTP 200") }
  const text = await boundedText(response.body, MAX_JSON_BYTES)
  try { return JSON.parse(text) as unknown } catch { throw new Error("Console credential verification was not JSON") }
}

/** Export stays in memory; only two authenticated, non-inference GETs are permitted. */
export async function loadActiveConsoleCredential(options: ConsoleCredentialLoaderOptions = {}): Promise<ActiveConsoleCredential> {
  const clock = options.now ?? Date.now
  let exported: unknown
  try { exported = await (options.exportCredentials ?? exportCredentials)() } catch { throw new Error("OpenCode credential export unavailable") }
  const selected = selectActiveConsoleCredential(exported, clock())
  const transport = options.fetch ?? fetch
  try {
    const config = await within(verifyJSON(CONSOLE_SERVER + "/api/v2/config", selected, transport), 15_000)
    if (!record(config)) throw new Error("Console configuration shape unavailable")
    const catalog = await within(verifyJSON("https://opencode.ai/inference/v1/models", selected, transport), 15_000)
    if (record(catalog) && Array.isArray(catalog.data) && catalog.data.every(value => record(value) && typeof value.id === "string") &&
      !catalog.data.some(value => record(value) && value.id === TARGET_MODEL)) throw new Error("approved smoke model is absent from Console catalogue")
  } catch { throw new Error("active Console session verification failed; no credential fallback attempted") }
  // A slow export/check must not consume the promised remaining lifetime.
  return selectActiveConsoleCredential(exported, clock())
}
