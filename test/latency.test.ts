import { expect, it } from "vitest"
import { SELF } from "cloudflare:test"

const API = { authorization: "Bearer test-token" }

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return { p50: at(0.5), p95: at(0.95), min: sorted[0]!, max: sorted[sorted.length - 1]! }
}

async function measure(url: string, headers: Record<string, string> = {}, count = 50): Promise<number[]> {
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    const start = performance.now()
    const res = await SELF.fetch(url, { headers })
    await res.text()
    samples.push(performance.now() - start)
  }
  return samples
}

it("keeps Worker and DO overhead low", async () => {
  const health = stats(await measure("https://harness.test/health"))
  const state = stats(await measure("https://harness.test/api/conversations/latency", API))

  console.log(
    `health p50=${health.p50.toFixed(1)}ms p95=${health.p95.toFixed(1)}ms · ` +
      `DO state p50=${state.p50.toFixed(1)}ms p95=${state.p95.toFixed(1)}ms`,
  )

  expect(health.p95).toBeLessThan(100)
  expect(state.p95).toBeLessThan(150)
})
