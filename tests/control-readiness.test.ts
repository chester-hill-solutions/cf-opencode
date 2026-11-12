import { describe, expect, test } from "bun:test"
import { waitFor } from "../control-server"

describe("bounded readiness probes", () => {
  test("retries after a stalled health response and accepts a later success", async () => {
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++
        if (requests === 1) return new Promise<Response>(() => {})
        return new Response("ready")
      },
    })
    try {
      await waitFor(`http://127.0.0.1:${server.port}/health`, 10)
      expect(requests).toBeGreaterThanOrEqual(2)
    } finally {
      server.stop(true)
    }
  })

  test("fails within the retry budget when every health request stalls", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Promise<Response>(() => {})
      },
    })
    const startedAt = performance.now()
    try {
      await expect(waitFor(`http://127.0.0.1:${server.port}/health`, 2)).rejects.toThrow("did not become ready")
      expect(performance.now() - startedAt).toBeLessThan(1500)
    } finally {
      server.stop(true)
    }
  })
})
