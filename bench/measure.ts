#!/usr/bin/env bun
/**
 * Measurement client for a deployed harness.
 *
 *   HARNESS_URL=https://cf-opencode.<account>.workers.dev \
 *   API_TOKEN=… bun run bench/measure.ts [conversation]
 *
 * Measures Worker overhead (/health), SSE connect, and a full turn
 * (message → first assistant event → settled). Turn numbers include model
 * latency and cold start; the overhead metrics are the harness's own cost.
 */

const base = process.env.HARNESS_URL
const token = process.env.API_TOKEN
const key = process.argv[2] ?? "bench"
const skipTurn = process.env.BENCH_TURN === "0"

const headers = { authorization: `Bearer ${token}` }

function stats(samples: number[]): { p50: number; p95: number; min: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return { p50: at(0.5), p95: at(0.95), min: sorted[0]!, max: sorted[sorted.length - 1]! }
}

const ms = (value: number) => `${value.toFixed(1)} ms`

async function healthSamples(count = 50): Promise<number[]> {
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    const start = performance.now()
    const res = await fetch(`${base}/health`)
    if (!res.ok) throw new Error(`/health ${res.status}`)
    samples.push(performance.now() - start)
  }
  return samples
}

async function sseConnectSamples(count = 5): Promise<number[]> {
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    const start = performance.now()
    const res = await fetch(`${base}/api/conversations/${key}/events`, { headers })
    if (!res.ok || !res.body) throw new Error(`/events ${res.status}`)
    const reader = res.body.getReader()
    await reader.read() // ": connected"
    samples.push(performance.now() - start)
    await reader.cancel()
  }
  return samples
}

async function turn(text: string): Promise<{ first: number; settled: number }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  const start = performance.now()
  try {
    const sse = await fetch(`${base}/api/conversations/${key}/events`, {
      headers,
      signal: controller.signal,
    })
    if (!sse.body) throw new Error("no SSE body")

    const posted = fetch(`${base}/api/conversations/${key}/messages`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    })

    const reader = sse.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let first: number | undefined

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const event = frame
          .split("\n")
          .find((line) => line.startsWith("event: "))
          ?.slice(7)
        if (event === "assistant" && first === undefined) first = performance.now() - start
        if (event === "settled") {
          await posted.catch(() => {})
          return { first: first ?? performance.now() - start, settled: performance.now() - start }
        }
      }
    }
    await posted.catch(() => {})
    throw new Error("stream ended before settled")
  } finally {
    clearTimeout(timeout)
  }
}

export interface IdleCloseMeasureOptions {
  base: string
  key: string
  headers: Record<string, string>
  samples?: number
  closeTimeoutMs?: number
  requestTimeoutMs?: number
  pollIntervalMs?: number
  fetcher?: IdleBenchmarkFetch
}

export type IdleBenchmarkFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>

export interface IdleCloseSample {
  warmMs: number
  coldMs: number
  coldDeltaMs: number
}

interface IdleSummary {
  p50: number
  min: number
  max: number
  p95?: number
}

function idleSummary(samples: number[]): IdleSummary {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return {
    p50: at(0.5),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    ...(sorted.length >= 20 ? { p95: at(0.95) } : {}),
  }
}

async function readContext(
  options: IdleCloseMeasureOptions,
  fetcher: IdleBenchmarkFetch,
): Promise<{ elapsedMs: number; sessionID: string }> {
  const url = `${options.base}/api/conversations/${encodeURIComponent(options.key)}/context`
  const timeoutMs = options.requestTimeoutMs ?? 30_000
  const signal = AbortSignal.timeout(timeoutMs)
  const start = performance.now()
  let response: Response
  try {
    response = await fetcher(url, { headers: options.headers, signal })
  } catch {
    throw new Error(signal.aborted ? `context request timed out after ${timeoutMs} ms` : "context request failed")
  }
  if (response.status === 404) throw new Error("context returned 404; the isolated benchmark conversation has no existing session")
  if (!response.ok) throw new Error(`context returned ${response.status}`)

  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new Error("context returned invalid JSON")
  }
  const sessionID = value && typeof value === "object" && "sessionID" in value
    ? (value as { sessionID?: unknown }).sessionID
    : undefined
  if (typeof sessionID !== "string" || !sessionID) throw new Error("context response is missing sessionID")
  return { elapsedMs: performance.now() - start, sessionID }
}

async function readContainerRunning(
  options: IdleCloseMeasureOptions,
  fetcher: IdleBenchmarkFetch,
  signal?: AbortSignal,
): Promise<boolean> {
  const url = `${options.base}/api/conversations/${encodeURIComponent(options.key)}/debug`
  const timeoutMs = options.requestTimeoutMs ?? 30_000
  const requestSignal = signal ?? AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetcher(url, { headers: options.headers, signal: requestSignal })
  } catch {
    throw new Error(requestSignal.aborted ? `passive debug request timed out after ${timeoutMs} ms` : "passive debug request failed")
  }
  if (!response.ok) throw new Error(`passive debug returned ${response.status}`)
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new Error("passive debug returned invalid JSON")
  }
  const containerRunning = value && typeof value === "object" && "containerRunning" in value
    ? (value as { containerRunning?: unknown }).containerRunning
    : undefined
  if (typeof containerRunning !== "boolean") {
    throw new Error("passive debug response is missing boolean containerRunning; idle close cannot be proven")
  }
  return containerRunning
}

async function waitForContainerClose(options: IdleCloseMeasureOptions, fetcher: IdleBenchmarkFetch): Promise<void> {
  const deadline = Date.now() + (options.closeTimeoutMs ?? 120_000)
  for (;;) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new Error(`timed out after ${options.closeTimeoutMs ?? 120_000} ms waiting for container close proof`)
    }
    let running: boolean
    try {
      running = await readContainerRunning(options, fetcher, AbortSignal.timeout(remainingMs))
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${options.closeTimeoutMs ?? 120_000} ms waiting for container close proof`)
      }
      throw error
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${options.closeTimeoutMs ?? 120_000} ms waiting for container close proof`)
    }
    if (!running) return
    await new Promise((resolve) => setTimeout(resolve, Math.min(options.pollIntervalMs ?? 1_000, Math.max(1, deadline - Date.now()))))
  }
}

/** Measure warm context and proven idle-close/cold-reopen timings without prompting. */
export async function measureIdleCloseReopen(options: IdleCloseMeasureOptions): Promise<{
  samples: IdleCloseSample[]
  warm: IdleSummary
  cold: IdleSummary
  delta: IdleSummary
}> {
  const samplesCount = options.samples ?? 3
  if (!Number.isInteger(samplesCount) || samplesCount < 1) throw new Error("idle sample count must be a positive integer")
  const fetcher = options.fetcher ?? (fetch as IdleBenchmarkFetch)
  const samples: IdleCloseSample[] = []
  let expectedSessionID: string | undefined

  for (let i = 0; i < samplesCount; i++) {
    // The first context call can start the runtime, so keep it outside timing.
    const warmup = await readContext(options, fetcher)
    expectedSessionID ??= warmup.sessionID
    if (warmup.sessionID !== expectedSessionID) {
      throw new Error("warm-up returned a different sessionID; same-session measurement is not possible")
    }
    if (!(await readContainerRunning(options, fetcher))) {
      throw new Error("container was not running after context warm-up; warm runtime start could not be confirmed")
    }
    const warm = await readContext(options, fetcher)
    if (warm.sessionID !== expectedSessionID) {
      throw new Error("timed warm context returned a different sessionID")
    }
    await waitForContainerClose(options, fetcher)
    const cold = await readContext(options, fetcher)
    if (cold.sessionID !== expectedSessionID) {
      throw new Error("cold reopen returned a different sessionID; same-session restore was not proven")
    }
    if (!(await readContainerRunning(options, fetcher))) {
      throw new Error("container was not running after cold context; runtime reopen could not be confirmed")
    }
    samples.push({ warmMs: warm.elapsedMs, coldMs: cold.elapsedMs, coldDeltaMs: cold.elapsedMs - warm.elapsedMs })
  }

  return {
    samples,
    warm: idleSummary(samples.map((sample) => sample.warmMs)),
    cold: idleSummary(samples.map((sample) => sample.coldMs)),
    delta: idleSummary(samples.map((sample) => sample.coldDeltaMs)),
  }
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

async function main(): Promise<void> {
  if (!base || !token) {
    console.error("Set HARNESS_URL and API_TOKEN (and optionally a conversation key).")
    process.exitCode = 1
    return
  }

  if (process.env.BENCH_IDLE === "1") {
    if (!process.argv[2]) {
      console.error("BENCH_IDLE=1 requires an explicit isolated conversation key with an existing session.")
      process.exitCode = 1
      return
    }
    try {
      const result = await measureIdleCloseReopen({
        base,
        key,
        headers,
        samples: positiveIntegerEnv("BENCH_IDLE_SAMPLES", 3),
        closeTimeoutMs: positiveIntegerEnv("BENCH_IDLE_CLOSE_TIMEOUT_MS", 120_000),
        requestTimeoutMs: positiveIntegerEnv("BENCH_IDLE_REQUEST_TIMEOUT_MS", 30_000),
        pollIntervalMs: positiveIntegerEnv("BENCH_IDLE_POLL_MS", 1_000),
      })
      const print = (label: string, summary: IdleSummary) => {
        const p95 = summary.p95 === undefined ? "" : `  p95 ${ms(summary.p95)}`
        console.log(`${label.padEnd(15)} p50 ${ms(summary.p50)}${p95}  min ${ms(summary.min)}  max ${ms(summary.max)}`)
      }
      console.log(`idle close/reopen: ${base}  conversation: ${key}`)
      console.log(`raw samples     ${JSON.stringify(result.samples)}`)
      print("warm context", result.warm)
      print("cold reopen", result.cold)
      print("cold - warm", result.delta)
    } catch (error) {
      console.error(error instanceof Error ? error.message : "idle benchmark failed")
      process.exitCode = 1
    }
    return
  }

  const health = stats(await healthSamples())
  const connect = stats(await sseConnectSamples())

  console.log(`harness: ${base}  conversation: ${key}`)
  console.log(`/health        p50 ${ms(health.p50)}  p95 ${ms(health.p95)}  min ${ms(health.min)}  max ${ms(health.max)}`)
  console.log(`SSE connect    p50 ${ms(connect.p50)}  p95 ${ms(connect.p95)}`)

  if (skipTurn) {
    console.log("turn           skipped (BENCH_TURN=0)")
  } else {
    const result = await turn("Reply with exactly: ok")
    console.log(`turn           first assistant ${ms(result.first)}  settled ${ms(result.settled)}`)
  }

  // SSE connections can keep the event loop alive after cancel.
  process.exit(0)
}

if (import.meta.main) await main()
