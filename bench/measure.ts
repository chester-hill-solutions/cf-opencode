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

if (!base || !token) {
  console.error("Set HARNESS_URL and API_TOKEN (and optionally a conversation key).")
  process.exit(1)
}

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

const health = stats(await healthSamples())
const connect = stats(await sseConnectSamples())
const result = await turn("Reply with exactly: ok")

console.log(`harness: ${base}  conversation: ${key}`)
console.log(`/health        p50 ${ms(health.p50)}  p95 ${ms(health.p95)}  min ${ms(health.min)}  max ${ms(health.max)}`)
console.log(`SSE connect    p50 ${ms(connect.p50)}  p95 ${ms(connect.p95)}`)
console.log(`turn           first assistant ${ms(result.first)}  settled ${ms(result.settled)}`)
