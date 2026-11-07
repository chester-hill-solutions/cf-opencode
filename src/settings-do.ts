import { DurableObject } from "cloudflare:workers"
import { defaultSettings, validateSettings, type HarnessSettings, type OnboardingState } from "./settings"
import { accountVault, workspaceID } from "./vault"
import { evaluateAlerts } from "./alerts"
import type { Env } from "./env"
import type { VaultKeyValueStorage } from "@chester-hill-solutions/vault/core"

/** How long a GitHub OAuth state value stays usable. */
const OAUTH_STATE_TTL_MS = 10 * 60_000
/** How long a conversation's container lease lasts without a heartbeat. */
const LEASE_TTL_MS = 10 * 60_000
const LEASE_PREFIX = "lease:"

/** Singleton Durable Object holding the harness-wide settings and secrets. */
export class Settings extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/get") return Response.json(await this.current())

    if (url.pathname === "/put" && request.method === "POST") {
      const current = await this.current()
      const result = validateSettings(await request.json(), current)
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 })

      const next: HarnessSettings = {
        ...result.value,
        version: current.version + 1,
        updatedAt: Date.now(),
      }
      await this.ctx.storage.put("settings", next)
      return Response.json(next)
    }

    if (url.pathname === "/onboarding" && request.method === "POST") {
      return this.patchOnboarding((await request.json()) as Partial<OnboardingState>)
    }

    // Daily spend ledger: one absolute entry per conversation per day, so a
    // retried report overwrites instead of double counting.
    if (url.pathname === "/usage" && request.method === "POST") {
      const body = (await request.json()) as {
        conversationID?: string
        date?: string
        costUSD?: number
        input?: number
        output?: number
      }
      if (!body.conversationID || !body.date) {
        return Response.json({ error: "conversationID and date are required" }, { status: 400 })
      }
      await this.ctx.storage.put(`usage:${body.date}:${body.conversationID}`, {
        costUSD: Number(body.costUSD ?? 0) || 0,
        input: Number(body.input ?? 0) || 0,
        output: Number(body.output ?? 0) || 0,
        updatedAt: Date.now(),
      })
      return Response.json({ ok: true })
    }

    if (url.pathname === "/usage/today" && request.method === "GET") {
      const date = new Date().toISOString().slice(0, 10)
      const entries = await this.ctx.storage.list<{ costUSD: number; input: number; output: number }>({
        prefix: `usage:${date}:`,
      })
      let costUSD = 0
      let input = 0
      let output = 0
      for (const entry of entries.values()) {
        costUSD += entry.costUSD
        input += entry.input
        output += entry.output
      }
      return Response.json({ date, costUSD, input, output, conversations: entries.size })
    }

    // Lightweight counters, bucketed by UTC day. `GET /api/metrics` exposes them
    // for a dashboard or an external scrape.
    if (url.pathname === "/metrics" && request.method === "POST") {
      const body = (await request.json()) as { name?: string; value?: number }
      if (!body.name) return Response.json({ error: "name is required" }, { status: 400 })
      const date = new Date().toISOString().slice(0, 10)
      const key = `metric:${date}:${body.name}`
      const current = (await this.ctx.storage.get<number>(key)) ?? 0
      await this.ctx.storage.put(key, current + (Number(body.value ?? 1) || 1))
      return Response.json({ ok: true })
    }

    if (url.pathname === "/metrics" && request.method === "GET") {
      const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10)
      const prefix = `metric:${date}:`
      const entries = await this.ctx.storage.list<number>({ prefix })
      const metrics: Record<string, number> = {}
      for (const [key, value] of entries) metrics[key.slice(prefix.length)] = value
      return Response.json({ date, metrics })
    }

    // Container leases: a small, TTL-based cap on concurrent conversation
    // containers, replacing the per-application max_instances the
    // durable_object scheduling policy does not support.
    if (url.pathname === "/leases/acquire" && request.method === "POST") {
      const body = (await request.json()) as { id?: string; ttlMs?: number }
      if (!body.id) return Response.json({ error: "id is required" }, { status: 400 })
      return this.acquireLease(body.id, body.ttlMs)
    }

    if (url.pathname === "/leases/release" && request.method === "POST") {
      const body = (await request.json()) as { id?: string }
      if (!body.id) return Response.json({ error: "id is required" }, { status: 400 })
      await this.ctx.storage.delete(`${LEASE_PREFIX}${body.id}`)
      return Response.json({ ok: true })
    }

    if (url.pathname === "/leases" && request.method === "GET") {
      const [cap, active] = await Promise.all([this.current(), this.activeLeases()])
      return Response.json({ cap: cap.maxContainers, active })
    }

    // Alert evaluation: the cron passes today's counters and spend; the DO
    // remembers the high-water mark so each new value is reported once.
    if (url.pathname === "/alerts/check" && request.method === "POST") {
      const body = (await request.json()) as {
        metrics?: Record<string, number>
        spendUSD?: number
        budgetUSD?: number
        leases?: { cap: number; active: number }
      }
      const date = new Date().toISOString().slice(0, 10)
      const prefix = `alertMark:${date}:`
      const marks: Record<string, number> = {}
      const stored = await this.ctx.storage.list<number>({ prefix })
      for (const [key, value] of stored) marks[key.slice(prefix.length)] = value

      const alerts = evaluateAlerts({
        metrics: body.metrics ?? {},
        spendUSD: Number(body.spendUSD ?? 0) || 0,
        budgetUSD: Number(body.budgetUSD ?? 0) || 0,
        leases: body.leases ?? { cap: 0, active: 0 },
        marks,
      })
      for (const alert of alerts) {
        await this.ctx.storage.put(`alertMark:${date}:${alert.name}`, alert.value)
        await this.ctx.storage.put(`alert:${date}:${alert.name}`, { ...alert, at: Date.now() })
      }
      return Response.json({ date, alerts })
    }

    if (url.pathname === "/alerts" && request.method === "GET") {
      const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10)
      const prefix = `alert:${date}:`
      const stored = await this.ctx.storage.list<{ name: string; message: string; at: number }>({
        prefix,
      })
      return Response.json({ date, alerts: [...stored.values()] })
    }

    if (url.pathname === "/alerts" && request.method === "DELETE") {
      const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10)
      const prefix = `alert:${date}:`
      const stored = await this.ctx.storage.list({ prefix })
      for (const key of stored.keys()) await this.ctx.storage.delete(key)
      return Response.json({ ok: true })
    }

    // Conversation registry: DOs cannot be listed, so the Worker records each
    // key it touches. This is the only way to answer "what exists?".
    if (url.pathname === "/conversations" && request.method === "POST") {
      const body = (await request.json()) as { key?: string }
      if (!body.key) return Response.json({ error: "key is required" }, { status: 400 })
      await this.ctx.storage.put(`conversation:${body.key}`, {
        key: body.key,
        lastSeenAt: Date.now(),
      })
      return Response.json({ ok: true })
    }

    if (url.pathname === "/conversations" && request.method === "GET") {
      const stored = await this.ctx.storage.list<{ key: string; lastSeenAt: number }>({
        prefix: "conversation:",
      })
      const conversations = [...stored.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      return Response.json({ conversations })
    }

    if (url.pathname === "/conversations/delete" && request.method === "POST") {
      const body = (await request.json()) as { key?: string }
      if (!body.key) return Response.json({ error: "key is required" }, { status: 400 })
      await this.ctx.storage.delete(`conversation:${body.key}`)
      return Response.json({ ok: true })
    }

    // Secrets are encrypted with the CHS vault. Values never leave the DO
    // unless a trusted caller asks for a specific key by name.
    if (url.pathname === "/secrets" && request.method === "GET") {
      const vault = this.vaultOrError()
      if (vault instanceof Response) return vault
      return Response.json({ keys: await vault.list(workspaceID(this.env)) })
    }

    if (url.pathname === "/secrets/put" && request.method === "POST") {
      const vault = this.vaultOrError()
      if (vault instanceof Response) return vault
      const body = (await request.json()) as { key?: string; value?: string }
      if (!body.key || typeof body.value !== "string") {
        return Response.json({ error: "key and value are required" }, { status: 400 })
      }
      await vault.set(workspaceID(this.env), body.key, body.value)
      return Response.json({ ok: true })
    }

    if (url.pathname === "/secrets/get" && request.method === "POST") {
      const vault = this.vaultOrError()
      if (vault instanceof Response) return vault
      const body = (await request.json()) as { key?: string }
      if (!body.key) return Response.json({ error: "key is required" }, { status: 400 })
      const value = await vault.get(workspaceID(this.env), body.key)
      return Response.json({ value })
    }

    if (url.pathname === "/secrets/delete" && request.method === "POST") {
      const vault = this.vaultOrError()
      if (vault instanceof Response) return vault
      const body = (await request.json()) as { key?: string }
      if (!body.key) return Response.json({ error: "key is required" }, { status: 400 })
      await vault.delete(workspaceID(this.env), body.key)
      return Response.json({ ok: true })
    }

    if (url.pathname === "/oauth-state" && request.method === "POST") {
      const body = (await request.json()) as { state?: string }
      if (!body.state) return Response.json({ error: "state is required" }, { status: 400 })
      await this.ctx.storage.put(`oauth:${body.state}`, Date.now() + OAUTH_STATE_TTL_MS)
      return Response.json({ ok: true })
    }

    if (url.pathname === "/oauth-state/consume" && request.method === "POST") {
      const body = (await request.json()) as { state?: string }
      if (!body.state) return Response.json({ error: "state is required" }, { status: 400 })
      const key = `oauth:${body.state}`
      const expires = await this.ctx.storage.get<number>(key)
      await this.ctx.storage.delete(key)
      return Response.json({ valid: typeof expires === "number" && expires > Date.now() })
    }

    return new Response("not found", { status: 404 })
  }

  async current(): Promise<HarnessSettings> {
    const stored = await this.ctx.storage.get<HarnessSettings>("settings")
    const settings = stored ?? defaultSettings(this.env)
    // Records written before these fields existed need defaults filled in.
    return {
      ...settings,
      onboarding: settings.onboarding ?? {},
      dailyBudgetUSD: settings.dailyBudgetUSD ?? 0,
      maxContainers: settings.maxContainers ?? 2,
    }
  }

  /** Merge onboarding metadata without bumping the settings version (no restart). */
  private async patchOnboarding(patch: Partial<OnboardingState>): Promise<Response> {
    const current = await this.current()
    const onboarding: OnboardingState = { ...current.onboarding, ...patch }
    const next: HarnessSettings = { ...current, onboarding, updatedAt: Date.now() }
    await this.ctx.storage.put("settings", next)
    return Response.json(next)
  }

  /** Active, unexpired leases; expired entries are removed as they are seen. */
  private async activeLeases(): Promise<Array<{ id: string; expiresAt: number }>> {
    const now = Date.now()
    const entries = await this.ctx.storage.list<number>({ prefix: LEASE_PREFIX })
    const active: Array<{ id: string; expiresAt: number }> = []
    for (const [key, expiresAt] of entries) {
      if (expiresAt > now) active.push({ id: key.slice(LEASE_PREFIX.length), expiresAt })
      else await this.ctx.storage.delete(key)
    }
    return active
  }

  /**
   * Grant or refresh a container lease. Returns 429 with the earliest expiry
   * when the cap is full, so the caller can queue and retry.
   */
  private async acquireLease(id: string, ttlMs?: number): Promise<Response> {
    const settings = await this.current()
    const cap = Math.max(1, settings.maxContainers ?? 2)
    const ttl = Math.min(
      Math.max(Number(ttlMs ?? LEASE_TTL_MS) || LEASE_TTL_MS, 60_000),
      6 * 60 * 60_000,
    )
    const active = await this.activeLeases()
    const now = Date.now()
    const held = active.find((lease) => lease.id === id)
    if (held) {
      await this.ctx.storage.put(`${LEASE_PREFIX}${id}`, now + ttl)
      return Response.json({ ok: true, cap, active: active.length })
    }
    if (active.length >= cap) {
      const retryAt = Math.min(...active.map((lease) => lease.expiresAt))
      return Response.json({ ok: false, cap, retryAt }, { status: 429 })
    }
    await this.ctx.storage.put(`${LEASE_PREFIX}${id}`, now + ttl)
    return Response.json({ ok: true, cap, active: active.length + 1 })
  }

  private vaultOrError() {
    try {
      const vault = accountVault(this.env, this.ctx.storage as unknown as VaultKeyValueStorage)
      if (!vault) {
        return Response.json(
          { error: "VAULT_MASTER_KEY is not configured; set it before connecting accounts" },
          { status: 503 },
        )
      }
      return vault
    } catch (error) {
      const message = error instanceof Error ? error.message : "vault unavailable"
      return Response.json({ error: message }, { status: 500 })
    }
  }
}
