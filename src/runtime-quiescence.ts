import type { makeClient } from "./opencode"
import { hashOperatorQuiescence, type OperatorQuiescenceProof } from "./operator-reconciliation"

export type RuntimeQuiescenceClient = Pick<ReturnType<typeof makeClient>, "experimental" | "session" | "permission">

export interface RuntimeQuiescenceInput {
  client: RuntimeQuiescenceClient
  sessionID: string
  /** Must read the authenticated control server's current generation. */
  getRuntimeGeneration: (signal: AbortSignal) => Promise<string>
  signal?: AbortSignal
  /** Test seam for the fixed 10-second upper bound; callers may only lower it. */
  timeoutMs?: number
}

export interface RuntimeQuiescenceResult {
  proof: OperatorQuiescenceProof
  digest: string
  /** Internal evidence for the caller; never log this object or its reasoning content. */
  session: Awaited<ReturnType<RuntimeQuiescenceClient["session"]["get"]>>
  context: Awaited<ReturnType<RuntimeQuiescenceClient["session"]["context"]>>
}

export class RuntimeQuiescenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuntimeQuiescenceError"
  }
}

/**
 * Prove native runtime quiescence. The caller must hold its DO admission,
 * recovery, and usage fences for the entire call; this helper never mutates
 * sessions, permissions, inbox items, forms, providers, or budget state.
 */
export async function proveRuntimeQuiescence(input: RuntimeQuiescenceInput): Promise<RuntimeQuiescenceResult> {
  if (!input.sessionID.trim()) throw new RuntimeQuiescenceError("session id is required")
  const timeoutMs = Math.min(input.timeoutMs ?? 10_000, 10_000)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RuntimeQuiescenceError("invalid quiescence timeout")

  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  if (input.signal?.aborted) controller.abort()
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = controller.signal
  const call = <T>(promise: Promise<T>, operation: string) => waitWithinDeadline(promise, signal, operation)

  try {
    const firstGeneration = await call(input.getRuntimeGeneration(signal), "read runtime generation")
    requireGeneration(firstGeneration)
    await call(input.client.experimental.session.wait({ sessionID: input.sessionID }, { signal }), "wait for session idle")

    const session = await call(input.client.session.get({ sessionID: input.sessionID }, { signal }), "read session")
    if (!session || session.id !== input.sessionID) throw new RuntimeQuiescenceError("session response did not match the requested session")

    const context = await call(input.client.session.context({ sessionID: input.sessionID }, { signal }), "read session context")
    if (!Array.isArray(context)) throw new RuntimeQuiescenceError("session context was unreadable")

    const inbox = await call(input.client.session.inbox.list({ sessionID: input.sessionID }, { signal }), "read session inbox")
    if (!Array.isArray(inbox)) throw new RuntimeQuiescenceError("session inbox was unreadable")
    if (inbox.length > 0) throw new RuntimeQuiescenceError("session inbox is not empty")

    const permissionResponse = await call(
      input.client.permission.request.list({ location: { directory: session.location.directory } }, { signal }),
      "read pending permissions",
    )
    if (!permissionResponse || !Array.isArray(permissionResponse.data)) {
      throw new RuntimeQuiescenceError("pending permissions were unreadable")
    }
    for (const permission of permissionResponse.data) {
      if (!permission || typeof permission.sessionID !== "string") {
        throw new RuntimeQuiescenceError("pending permission record was unreadable")
      }
      if (permission.sessionID === input.sessionID) throw new RuntimeQuiescenceError("session has a pending permission request")
    }

    const forms = await call(input.client.session.form.list({ sessionID: input.sessionID }, { signal }), "read session forms")
    if (!Array.isArray(forms)) throw new RuntimeQuiescenceError("session forms were unreadable")
    for (const form of forms) {
      if (!form || form.sessionID !== input.sessionID || typeof form.id !== "string") {
        throw new RuntimeQuiescenceError("session form record was unreadable")
      }
      const detail = await call(input.client.session.form.get({ sessionID: input.sessionID, formID: form.id }, { signal }), "read form status")
      if (!detail || detail.id !== form.id || detail.sessionID !== input.sessionID || !detail.state ||
        !["pending", "answered", "cancelled"].includes(detail.state.status)) {
        throw new RuntimeQuiescenceError("session form status was unreadable")
      }
      if (detail.state.status === "pending") throw new RuntimeQuiescenceError("session has a pending form")
    }

    const lastGeneration = await call(input.getRuntimeGeneration(signal), "recheck runtime generation")
    requireGeneration(lastGeneration)
    if (firstGeneration !== lastGeneration) throw new RuntimeQuiescenceError("runtime generation changed during quiescence check")

    const contextDigest = await digestRuntimeContext(context)
    const proof: OperatorQuiescenceProof = {
      sessionID: input.sessionID,
      runtimeGeneration: firstGeneration,
      contextDigest,
      waited: true,
      inboxEmpty: true,
      permissionsEmpty: true,
      formsEmpty: true,
    }
    return { proof, digest: await hashOperatorQuiescence(proof), session, context }
  } catch (error) {
    if (signal.aborted) throw new RuntimeQuiescenceError("quiescence check timed out or was cancelled")
    if (error instanceof RuntimeQuiescenceError) throw error
    throw new RuntimeQuiescenceError("native quiescence evidence could not be verified")
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abortFromCaller)
  }
}

function requireGeneration(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new RuntimeQuiescenceError("runtime generation is unavailable")
}

function waitWithinDeadline<T>(promise: Promise<T>, signal: AbortSignal, operation: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new RuntimeQuiescenceError(`${operation} was cancelled`))
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new RuntimeQuiescenceError(`${operation} was cancelled`))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  })
}

export async function digestRuntimeContext(value: unknown): Promise<string> {
  const canonical = canonicalJson(value)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null"
  if (typeof value === "undefined") return "null"
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`
  if (typeof value !== "object") throw new RuntimeQuiescenceError("session context was not valid JSON")
  if (seen.has(value)) throw new RuntimeQuiescenceError("session context was not valid JSON")
  seen.add(value)
  const record = value as Record<string, unknown>
  const fields = Object.keys(record).filter((key) => record[key] !== undefined).sort()
  const result = `{${fields.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(",")}}`
  seen.delete(value)
  return result
}
