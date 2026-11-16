import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import { client, CliError } from "../tools/cli/client"

/**
 * R1-4c conformance: the reference client's own code, unchanged, against the
 * real Worker routes. The unit test pins request shapes against a fake server;
 * this one proves the shapes are the ones the service actually serves.
 */

const realFetch = globalThis.fetch

beforeAll(() => {
  // Route the client's global fetch at the Worker under test.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    SELF.fetch(input as string, init)) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

const api = () => client({ baseUrl: "https://harness.test", token: "test-token" })

async function queued(key: string) {
  await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, runtime) => {
    await runtime.storage.put("state", {
      phase: "running",
      sessionID: "ses_cli",
      budgetReservation: { reservationID: "cli-hold", date: "2026-11-16", dispatched: true },
    })
  })
}

describe("CLI against the public API", () => {
  test("submit returns a turn, status and questions answer from it", async () => {
    await queued("cli:submit")
    const submitted = await api().submit("cli:submit", { text: "work", idempotencyKey: "cli-1" }) as {
      turn: { id: string; state: string }
    }
    expect(submitted.turn.id).toMatch(/^turn_/)
    expect(submitted.turn.state).toBe("queued")

    const status = await api().status("cli:submit", submitted.turn.id) as { turn: { id: string; output: unknown } }
    expect(status.turn.id).toBe(submitted.turn.id)
    expect(status.turn.output).toEqual({ available: false, replay: "none" })

  })

  test("questions distinguishes nothing-asked from cannot-tell", async () => {
    // No session: nothing can be blocked, so the answer is an empty list.
    const idle = await api().questions("cli:idle") as { questions: unknown[] }
    expect(idle.questions).toEqual([])
    // A running turn with no reachable runtime is a 503, never [].
    await queued("cli:blocked")
    const unavailable = await api().questions("cli:blocked").catch((error: unknown) => error)
    expect(unavailable).toBeInstanceOf(CliError)
    expect((unavailable as InstanceType<typeof CliError>).status).toBe(503)
  })

  test("a repeated key replays and different content is a contract error", async () => {
    await queued("cli:replay")
    const first = await api().submit("cli:replay", { text: "work", idempotencyKey: "same" }) as { turn: { id: string } }
    const replay = await api().submit("cli:replay", { text: "work", idempotencyKey: "same" }) as {
      replayed: boolean
      turn: { id: string }
    }
    expect(replay.replayed).toBe(true)
    expect(replay.turn.id).toBe(first.turn.id)

    const conflict = await api().submit("cli:replay", { text: "different", idempotencyKey: "same" }).catch((error: unknown) => error)
    expect(conflict).toBeInstanceOf(CliError)
    expect((conflict as InstanceType<typeof CliError>).status).toBe(409)
    expect((conflict as InstanceType<typeof CliError>).code).toBe("idempotency_conflict")
  })

  test("cancel targets the queued turn the client named", async () => {
    await queued("cli:cancel")
    const { turn } = await api().submit("cli:cancel", { text: "work" }) as { turn: { id: string } }
    const cancelled = await api().cancel("cli:cancel", turn.id) as {
      cancellation: { queuedCleared: boolean; settled: boolean }
    }
    expect(cancelled.cancellation).toMatchObject({ queuedCleared: true, settled: true })
  })

  test("an unknown turn is a 404 the client surfaces as a contract error", async () => {
    const missing = await api().status("cli:missing", "turn_nope").catch((error: unknown) => error)
    expect(missing).toBeInstanceOf(CliError)
    expect((missing as InstanceType<typeof CliError>).status).toBe(404)
  })
})
