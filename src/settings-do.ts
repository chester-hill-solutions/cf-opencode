import { DurableObject } from "cloudflare:workers"
import {
  defaultSettings,
  normalizeSettings,
  validateSettings,
  type HarnessSettings,
  type OnboardingState,
} from "./settings"
import { accountVault, workspaceID } from "./vault"
import { evaluateAlerts } from "./alerts"
import { decideLease } from "./leases"
import type { Env } from "./env"
import type { VaultKeyValueStorage } from "@chester-hill-solutions/vault/core"

/** How long a GitHub OAuth state value stays usable. */
const OAUTH_STATE_TTL_MS = 10 * 60_000
/** How long a conversation's container lease lasts without a heartbeat. */
const LEASE_TTL_MS = 10 * 60_000
const LEASE_PREFIX = "lease:"
/** Days of per-day counters, alerts and usage ledger entries to keep. */
const RETENTION_DAYS = 30
const DAY_PREFIXES = ["metric:", "alert:", "alertMark:", "usage:"]

/** Singleton Durable Object holding the harness-wide settings and secrets. */
export class Settings extends DurableObject<Env> {
  /**
   * Serializes request handling. Several routes read the settings record,
   * validate it, and write it back; without a queue two concurrent saves can
   * both write the same version and one update is lost. Serializing the whole
   * fetch also makes lease acquisition and OAuth-state consumption atomic.
   */
  private tail: Promise<unknown> = Promise.resolve()

  async fetch(request: Request): Promise<Response> {
    const run = this.tail.then(
      () => this.handle(request),
      () => this.handle(request),
    )
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async handle(request: Request): Promise<Response> {
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

    // A cutover preview is read-only. The hash binds the exact retained rows,
    // unresolved holds and any prior receipt seen by the operator.
    if (url.pathname === "/usage/cutover" && request.method === "GET") {
      const conversationID = url.searchParams.get("conversationID")
      const reservationID = url.searchParams.get("reservationID")
      if (!boundedID(conversationID)) {
        return Response.json({ error: "bounded conversationID is required" }, { status: 400 })
      }
      if (reservationID !== null && !boundedID(reservationID)) {
        return Response.json({ error: "reservationID must be a bounded nonempty string" }, { status: 400 })
      }
      return Response.json(await this.usageCutoverSnapshot(conversationID, reservationID ?? undefined))
    }

    // Internal service route only: no public Worker route forwards here.
    if (url.pathname === "/usage/cutover" && request.method === "POST") {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return Response.json({ error: "valid JSON is required" }, { status: 400 })
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return Response.json({ error: "cutover request must be a JSON object" }, { status: 400 })
      }
      const requestBody = body as Record<string, unknown>
      const { conversationID, cutoverID, expectedSnapshotID, sessionID, throughSeq } = requestBody
      if (
        !boundedID(conversationID) || !boundedID(cutoverID) || !boundedID(sessionID) ||
        typeof expectedSnapshotID !== "string" || !/^[a-f0-9]{64}$/.test(expectedSnapshotID) ||
        typeof throughSeq !== "number" || !Number.isSafeInteger(throughSeq) || throughSeq < 0
      ) {
        return Response.json({
          error: "conversationID, cutoverID, sessionID, SHA-256 expectedSnapshotID, and safe nonnegative throughSeq are required",
        }, { status: 400 })
      }
      return this.applyUsageCutover({ conversationID, cutoverID, expectedSnapshotID, sessionID, throughSeq })
    }

    // Internal recovery route: cancel only the captured reservation identity.
    if (url.pathname === "/usage/cancel" && request.method === "POST") {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return Response.json({ error: "valid JSON is required" }, { status: 400 })
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return Response.json({ error: "cancellation request must be a JSON object" }, { status: 400 })
      }
      const { conversationID, reservationID, expectedSnapshotID } = body as Record<string, unknown>
      if (
        !boundedID(conversationID) || !boundedID(reservationID) ||
        typeof expectedSnapshotID !== "string" || !/^[a-f0-9]{64}$/.test(expectedSnapshotID)
      ) {
        return Response.json({
          error: "conversationID, reservationID, and SHA-256 expectedSnapshotID are required",
        }, { status: 400 })
      }
      return this.cancelUsageReservation({ conversationID, reservationID, expectedSnapshotID })
    }

    // Daily spend ledger: one absolute entry per conversation per day, so a
    // retried legacy report advances a high-water mark instead of double counting.
    if (url.pathname === "/usage" && request.method === "POST") {
      let parsedBody: unknown
      try {
        parsedBody = await request.json()
      } catch {
        return Response.json({ error: "valid JSON is required" }, { status: 400 })
      }
      if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
        return Response.json({ error: "usage report must be a JSON object" }, { status: 400 })
      }
      const body = parsedBody as Record<string, unknown>
      const { conversationID, sessionID, sourceID, date, costUSD, input, output } = body
      if (!boundedID(conversationID) || !validUsageDate(date)) {
        return Response.json({ error: "conversationID and a retained UTC date are required" }, { status: 400 })
      }
      if (sessionID === undefined && sourceID === undefined) {
        const legacyTotals = {
          costUSD: body.costUSD === undefined ? 0 : body.costUSD,
          input: body.input === undefined ? 0 : body.input,
          output: body.output === undefined ? 0 : body.output,
        }
        if (![legacyTotals.costUSD, legacyTotals.input, legacyTotals.output].every(validAmount)) {
          return Response.json({ error: "costUSD, input, and output must be finite nonnegative numbers" }, { status: 400 })
        }
        const totals = legacyTotals as UsageAmounts
        const key = `usage:${date}:${conversationID}`
        const result = await this.ctx.storage.transaction(async () => {
          const receipt = await this.ctx.storage.get<UsageCutoverReceipt>(usageCutoverKey(conversationID))
          if (receipt) return { conflict: "cutover" as const }
          const current = await this.ctx.storage.get<UsageRow>(key)
          if (current?.sourced === true) return { conflict: "sourced" as const }
          const next = highWater(current, totals)
          await this.ctx.storage.put(key, { ...next, updatedAt: Date.now() })
          return { row: next }
        })
        if ("conflict" in result) {
          const error = result.conflict === "cutover"
            ? "legacy usage writes are blocked after cutover"
            : "legacy usage cannot update a sourced ledger row"
          return Response.json({ error }, { status: 409 })
        }
        return Response.json({ ok: true, ...result.row })
      }

      if (!boundedID(sessionID) || !boundedID(sourceID)) {
        return Response.json({ error: "sessionID and sourceID must be bounded nonempty strings" }, { status: 400 })
      }
      if (![costUSD, input, output].every(validAmount)) {
        return Response.json({ error: "costUSD, input, and output must be finite nonnegative numbers" }, { status: 400 })
      }
      const totals: UsageAmounts = { costUSD, input, output } as UsageAmounts

      const aggregateKey = `usage:${date}:${conversationID}`
      const sourceKey = `usage-source:${JSON.stringify([conversationID, sessionID, sourceID])}`
      const result = await this.ctx.storage.transaction(async () => {
        const previous = await this.ctx.storage.get<UsageSource>(sourceKey)
        if (previous && previous.date !== date) return { conflict: "date" as const }
        const receipt = await this.ctx.storage.get<UsageCutoverReceipt>(usageCutoverKey(conversationID))
        if (receipt) {
          if (body.cutoverID !== receipt.cutoverID ||
            typeof body.seq !== "number" || !Number.isSafeInteger(body.seq) || body.seq < 1) {
            return { conflict: "epoch" as const }
          }
          if (sessionID === receipt.sessionID && body.seq <= receipt.throughSeq) {
            return { covered: true as const }
          }
        }
        const current = await this.ctx.storage.get<UsageRow>(aggregateKey)
        if (!previous && current?.sourced !== true && hasPositiveUsage(current)) {
          return { conflict: "legacy" as const }
        }

        const nextSource = highWater(previous, totals)
        const delta = {
          costUSD: nextSource.costUSD - (previous?.costUSD ?? 0),
          input: nextSource.input - (previous?.input ?? 0),
          output: nextSource.output - (previous?.output ?? 0),
        }
        const nextAggregate = {
          ...current,
          costUSD: (current?.costUSD ?? 0) + delta.costUSD,
          input: (current?.input ?? 0) + delta.input,
          output: (current?.output ?? 0) + delta.output,
        }
        if (![nextAggregate.costUSD, nextAggregate.input, nextAggregate.output].every(Number.isFinite)) {
          return { conflict: "overflow" as const }
        }
        await this.ctx.storage.put(sourceKey, {
          date,
          ...nextSource,
          ...(receipt ? { cutoverID: receipt.cutoverID, seq: body.seq as number } : {}),
          updatedAt: Date.now(),
        })
        await this.ctx.storage.put(aggregateKey, { ...nextAggregate, sourced: true, updatedAt: Date.now() })
        return { row: nextAggregate }
      })
      if ("conflict" in result) {
        if (result.conflict === "overflow") {
          return Response.json({ error: "usage aggregate exceeds finite numeric limits" }, { status: 400 })
        }
        if (result.conflict === "epoch") {
          return Response.json({ error: "usage report does not match the active cutover epoch" }, { status: 409 })
        }
        const error = result.conflict === "date"
          ? "sourceID was already recorded for a different date"
          : "sourced usage cannot be mixed with a nonzero legacy ledger row"
        return Response.json({ error }, { status: 409 })
      }
      if ("covered" in result) return Response.json({ ok: true, covered: true })
      return Response.json({ ok: true, ...result.row })
    }

    if (url.pathname === "/usage/reserve" && request.method === "POST") {
      const body = (await request.json()) as {
        conversationID?: unknown
        reservationID?: unknown
        costUSD?: unknown
      }
      if (
        typeof body.conversationID !== "string" ||
        body.conversationID.length === 0 ||
        typeof body.reservationID !== "string" ||
        body.reservationID.length === 0 ||
        typeof body.costUSD !== "number" ||
        !Number.isFinite(body.costUSD) ||
        body.costUSD < 0
      ) {
        return Response.json(
          { error: "conversationID, reservationID, and finite nonnegative costUSD are required" },
          { status: 400 },
        )
      }

      const { conversationID, reservationID, costUSD } = body
      const holdKey = `reservation:${conversationID}`
      const retired = await this.ctx.storage.get<ReservationRetirement>(retiredReservationKey(conversationID, reservationID))
      if (retired) {
        return Response.json({
          code: "reservation_retired",
          error: "reservation ID was already retired",
          retirement: retired,
        }, { status: 409 })
      }
      const existing = await this.ctx.storage.get<{
        conversationID: string
        reservationID: string
        date: string
        costUSD: number
      }>(holdKey)
      if (existing) {
        if (existing.conversationID !== conversationID || existing.reservationID !== reservationID) {
          return Response.json({ error: "conversation already has an outstanding reservation" }, { status: 409 })
        }
        if (existing.costUSD !== costUSD) {
          return Response.json({ error: "reservation amount does not match the existing hold" }, { status: 409 })
        }
        return Response.json({ ok: true, reservationID, date: existing.date })
      }

      const allUsage = await this.ctx.storage.list<{
        costUSD?: number
        reserved?: boolean
        input?: number
        output?: number
        sourced?: boolean
      }>({ prefix: "usage:" })
      const date = new Date().toISOString().slice(0, 10)
      const retentionCutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000)
        .toISOString().slice(0, 10)
      let actualTodayUSD = 0
      let heldUSD = 0
      for (const [key, entry] of allUsage) {
        if (legacyReservationOwner(key) === conversationID) {
          return Response.json({ error: "conversation has an unresolved legacy reservation" }, { status: 409 })
        }
        if (legacyReservationOwner(key) !== undefined) {
          if (typeof entry.costUSD === "number" && Number.isFinite(entry.costUSD) && entry.costUSD > 0) {
            heldUSD += entry.costUSD
          }
          continue
        }
        const actualKey = /^usage:(\d{4}-\d{2}-\d{2}):(.*)$/.exec(key)
        if (
          actualKey?.[2] === conversationID && validStoredDate(actualKey[1]) && actualKey[1] >= retentionCutoff &&
          entry.reserved !== true && entry.sourced !== true && hasPositiveUsage(entry)
        ) {
          return Response.json(
            {
              code: "legacy_usage_requires_migration",
              error: "conversation has retained legacy usage; legacy accounting migration is required before reserving",
            },
            { status: 409 },
          )
        }
        if (key.startsWith(`usage:${date}:`) && entry.reserved !== true) {
          if (typeof entry.costUSD === "number" && Number.isFinite(entry.costUSD)) actualTodayUSD += entry.costUSD
        }
      }

      const newHolds = await this.ctx.storage.list<{ costUSD?: number }>({ prefix: "reservation:" })
      for (const entry of newHolds.values()) {
        if (typeof entry.costUSD === "number" && Number.isFinite(entry.costUSD) && entry.costUSD > 0) {
          heldUSD += entry.costUSD
        }
      }

      const settings = await this.current()
      const budgetUSD = settings.dailyBudgetUSD
      const admittedUSD = actualTodayUSD + heldUSD + costUSD
      const toleranceUSD = Number.EPSILON * Math.max(Math.abs(admittedUSD), Math.abs(budgetUSD)) * 2
      if (
        budgetUSD > 0 &&
        (!Number.isFinite(admittedUSD) || admittedUSD - budgetUSD > toleranceUSD)
      ) {
        return Response.json(
          { ok: false, spentUSD: actualTodayUSD, reservedUSD: heldUSD, budgetUSD },
          { status: 429 },
        )
      }

      await this.ctx.storage.put(holdKey, { conversationID, reservationID, date, costUSD })
      return Response.json({ ok: true, reservationID, date })
    }

    if (url.pathname === "/usage/release" && request.method === "POST") {
      const body = (await request.json()) as {
        conversationID?: unknown
        reservationID?: unknown
        date?: unknown
      }
      if (
        typeof body.conversationID !== "string" || body.conversationID.length === 0 ||
        typeof body.reservationID !== "string" || body.reservationID.length === 0 ||
        typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ) {
        return Response.json({ error: "conversationID, reservationID, and date are required" }, { status: 400 })
      }
      const key = `reservation:${body.conversationID}`
      const result = await this.ctx.storage.transaction(async () => {
        const retiredKey = retiredReservationKey(body.conversationID as string, body.reservationID as string)
        const priorRetirement = await this.ctx.storage.get<ReservationRetirement>(retiredKey)
        if (priorRetirement) return { retirement: priorRetirement, released: priorRetirement.released }
        const hold = await this.ctx.storage.get<ReservationHold>(key)
        if (hold && (
          hold.conversationID !== body.conversationID ||
          hold.reservationID !== body.reservationID ||
          hold.date !== body.date
        )) return { conflict: true as const }
        const retirement: ReservationRetirement = {
          conversationID: body.conversationID as string,
          reservationID: body.reservationID as string,
          ...(hold ? { date: hold.date as string } : {}),
          reason: "released",
          retiredAt: Date.now(),
          released: Boolean(hold),
        }
        if (hold) await this.ctx.storage.delete(key)
        await this.ctx.storage.put(retiredKey, retirement)
        return { retirement, released: Boolean(hold) }
      })
      if ("conflict" in result) {
        return Response.json({ error: "reservation reference does not match the outstanding hold" }, { status: 409 })
      }
      return Response.json({ ok: true, released: result.released, retirement: result.retirement })
    }

    if (url.pathname === "/usage/today" && request.method === "GET") {
      const date = new Date().toISOString().slice(0, 10)
      const entries = await this.ctx.storage.list<{
        costUSD?: number; reserved?: boolean; input?: number; output?: number; legacyOpening?: UsageAmounts
      }>({
        prefix: `usage:${date}:`,
      })
      const newHolds = await this.ctx.storage.list<{ costUSD?: number }>({ prefix: "reservation:" })
      const allUsage = await this.ctx.storage.list<{ costUSD?: number }>({ prefix: "usage:" })
      let costUSD = 0
      let reservedUSD = 0
      let input = 0
      let output = 0
      const conversations = new Set<string>()
      let historicalUsageUnreconciled = false
      for (const [key, entry] of entries) {
        if (legacyReservationOwner(key) !== undefined || entry.reserved === true) continue
        costUSD += finiteAmount(entry.costUSD)
        input += finiteAmount(entry.input)
        output += finiteAmount(entry.output)
        if (entry.legacyOpening !== undefined) historicalUsageUnreconciled = true
        conversations.add(key.slice(`usage:${date}:`.length))
      }
      for (const entry of newHolds.values()) reservedUSD += finiteAmount(entry.costUSD)
      for (const [key, entry] of allUsage) {
        if (legacyReservationOwner(key) !== undefined) {
          reservedUSD += finiteAmount(entry.costUSD)
        }
      }
      return Response.json({
        date,
        costUSD,
        reservedUSD,
        admittedUSD: costUSD + reservedUSD,
        input,
        output,
        conversations: conversations.size,
        historicalUsageUnreconciled,
      })
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

      const pruned = await this.prune()
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
      return Response.json({ date, alerts, pruned })
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
      return Response.json({ keys: await vault.listSecrets(workspaceID(this.env)) })
    }

    if (url.pathname === "/secrets/put" && request.method === "POST") {
      const vault = this.vaultOrError()
      if (vault instanceof Response) return vault
      const body = (await request.json()) as { key?: string; value?: string }
      if (!body.key || typeof body.value !== "string") {
        return Response.json({ error: "key and value are required" }, { status: 400 })
      }
      await vault.setSecret(workspaceID(this.env), body.key, body.value)
      return Response.json({ ok: true })
    }

    if (url.pathname === "/secrets/get" && request.method === "POST") {
      const vault = this.vaultOrError()
      if (vault instanceof Response) return vault
      const body = (await request.json()) as { key?: string }
      if (!body.key) return Response.json({ error: "key is required" }, { status: 400 })
      const value = await vault.getSecret(workspaceID(this.env), body.key)
      return Response.json({ value })
    }

    if (url.pathname === "/secrets/delete" && request.method === "POST") {
      const vault = this.vaultOrError()
      if (vault instanceof Response) return vault
      const body = (await request.json()) as { key?: string }
      if (!body.key) return Response.json({ error: "key is required" }, { status: 400 })
      await vault.deleteSecret(workspaceID(this.env), body.key)
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
    // Records written before a field existed need defaults filled in.
    return normalizeSettings(stored, defaultSettings(this.env))
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
    const decision = decideLease({ leases: active, id, now: Date.now(), ttlMs: ttl, cap })
    if (!decision.grant) {
      return Response.json(
        { ok: false, cap, active: decision.active, retryAt: decision.retryAt },
        { status: 429 },
      )
    }
    await this.ctx.storage.put(`${LEASE_PREFIX}${id}`, decision.expiresAt)
    return Response.json({ ok: true, cap, active: decision.active })
  }

  /** Preview the exact retained ledger and hold references bound by cutover. */
  private async usageCutoverSnapshot(
    conversationID: string,
    reservationID?: string,
  ): Promise<UsageCutoverSnapshot> {
    const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10)
    const allUsage = await this.ctx.storage.list<UsageRow>({ prefix: "usage:" })
    const rows = [...allUsage].flatMap(([key, row]) => {
      const parsed = usageActualKey(key)
      if (
        !parsed || parsed.conversationID !== conversationID || parsed.date < cutoffDate ||
        legacyReservationOwner(key) !== undefined || row?.reserved === true
      ) return []
      return [{
        date: parsed.date,
        costUSD: row.costUSD === undefined ? 0 : row.costUSD,
        input: row.input === undefined ? 0 : row.input,
        output: row.output === undefined ? 0 : row.output,
        ...(row.sourced === true ? { sourced: true } : {}),
        ...(row.legacyOpening ? { legacyOpening: row.legacyOpening } : {}),
        ...(row.cutoverID ? { cutoverID: row.cutoverID } : {}),
        ...(typeof row.updatedAt === "number" ? { updatedAt: row.updatedAt } : {}),
      } satisfies UsageCutoverRow]
    }).sort((a, b) => a.date.localeCompare(b.date))
    const blockers = rows.flatMap((row) => {
      if (row.sourced === true) return []
      const invalidFields = ["costUSD", "input", "output"].filter((field) =>
        !validAmount(row[field as keyof UsageAmounts]),
      )
      return invalidFields.length > 0 ? [{ date: row.date, invalidFields }] : []
    })
    const legacyRows = rows.filter((row) =>
      row.sourced !== true && [row.costUSD, row.input, row.output].some(
        (amount) => typeof amount === "number" && Number.isFinite(amount) && amount > 0,
      ),
    )

    const holds: UsageCutoverHold[] = []
    const newHold = await this.ctx.storage.get<ReservationHold>(`reservation:${conversationID}`)
    if (newHold) {
      const invalidFields = [
        ...(newHold.conversationID !== conversationID ? ["conversationID"] : []),
        ...(!boundedID(newHold.reservationID) ? ["reservationID"] : []),
        ...(!validStoredDate(newHold.date) ? ["date"] : []),
        ...(!validAmount(newHold.costUSD) ? ["costUSD"] : []),
      ]
      holds.push({
        key: `reservation:${conversationID}`,
        kind: "reservation",
        conversationID: typeof newHold.conversationID === "string" ? newHold.conversationID : null,
        reservationID: typeof newHold.reservationID === "string" ? newHold.reservationID : null,
        date: validStoredDate(newHold.date) ? newHold.date : null,
        costUSD: validAmount(newHold.costUSD) ? newHold.costUSD : null,
        updatedAt: typeof newHold.updatedAt === "number" && Number.isFinite(newHold.updatedAt)
          ? newHold.updatedAt
          : null,
        ...(invalidFields.length > 0 ? { invalidFields } : {}),
      })
    }
    for (const [key, value] of allUsage) {
      const legacyOwner = legacyReservationOwner(key)
      const actual = usageActualKey(key)
      const actualReserved = legacyOwner === undefined && actual?.conversationID === conversationID &&
        value?.reserved === true
      if (legacyOwner !== conversationID && !actualReserved) continue
      const match = /^usage:(\d{4}-\d{2}-\d{2}):reserve:/.exec(key)
      const legacyDate = validStoredDate(value?.date)
        ? value.date
        : validStoredDate(match?.[1])
          ? match?.[1] ?? null
          : actualReserved && actual?.date
            ? actual.date
            : null
      const invalidFields = [
        ...(!legacyDate ? ["date"] : []),
        ...(!validAmount(value?.costUSD) ? ["costUSD"] : []),
      ]
      holds.push({
        key,
        kind: "legacy-reservation",
        conversationID,
        reservationID: typeof value?.reservationID === "string" ? value.reservationID : null,
        date: legacyDate,
        costUSD: validAmount(value?.costUSD) ? value.costUSD : null,
        reserved: value?.reserved === true,
        updatedAt: typeof value?.updatedAt === "number" && Number.isFinite(value.updatedAt)
          ? value.updatedAt
          : null,
        ...(invalidFields.length > 0 ? { invalidFields } : {}),
      })
    }
    holds.sort((a, b) => a.key.localeCompare(b.key))

    const receipt = await this.ctx.storage.get<UsageCutoverReceipt>(usageCutoverKey(conversationID))
    const canonicalRows = rows.map((row) => [
      row.date,
      canonicalSnapshotValue(row.costUSD), canonicalSnapshotValue(row.input), canonicalSnapshotValue(row.output),
      row.sourced === true,
      row.legacyOpening ?? null, row.cutoverID ?? null, row.updatedAt ?? null,
    ])
    const canonicalHolds = holds.map((hold) => {
      const fields: unknown[] = [
        hold.key, hold.kind, hold.conversationID, hold.reservationID, hold.date,
        hold.costUSD, hold.reserved ?? null, hold.updatedAt,
      ]
      return hold.invalidFields ? [...fields, hold.invalidFields] : fields
    })
    const canonicalReceipt = receipt ? [
      receipt.cutoverID, receipt.sessionID, receipt.throughSeq, receipt.expectedSnapshotID,
      receipt.openingBalances, receipt.createdAt, receipt.historicalUsageUnreconciled,
    ] : null
    const retirement = reservationID
      ? await this.ctx.storage.get<ReservationRetirement>(retiredReservationKey(conversationID, reservationID))
      : undefined
    const canonical: unknown[] = [canonicalRows, canonicalHolds, canonicalReceipt]
    if (reservationID !== undefined) {
      canonical.push([reservationID, retirement ? [
        retirement.conversationID, retirement.reservationID, retirement.date ?? null,
        retirement.reason, retirement.retiredAt, retirement.released,
      ] : null])
    }
    const snapshotID = await sha256(JSON.stringify(canonical))
    return {
      conversationID,
      rows,
      legacyRows,
      blockers,
      holds,
      ...(receipt ? { receipt } : {}),
      ...(reservationID !== undefined ? { retirement } : {}),
      snapshotID,
    }
  }

  /** Retire an undispatched ID using the exact hold state captured by preview. */
  private async cancelUsageReservation(input: {
    conversationID: string
    reservationID: string
    expectedSnapshotID: string
  }): Promise<Response> {
    const result = await this.ctx.storage.transaction(async () => {
      const retiredKey = retiredReservationKey(input.conversationID, input.reservationID)
      const priorRetirement = await this.ctx.storage.get<ReservationRetirement>(retiredKey)
      // Lost acknowledgements are safe to retry even after the snapshot changed.
      if (priorRetirement) return { retirement: priorRetirement, released: priorRetirement.released }

      const snapshot = await this.usageCutoverSnapshot(input.conversationID, input.reservationID)
      if (snapshot.snapshotID !== input.expectedSnapshotID) return { conflict: "changed" as const }
      if (snapshot.holds.some((hold) => hold.kind !== "reservation")) {
        return { conflict: "unsupported-hold" as const }
      }

      const holdKey = `reservation:${input.conversationID}`
      const hold = await this.ctx.storage.get<ReservationHold>(holdKey)
      if (hold) {
        if (
          hold.conversationID !== input.conversationID || hold.reservationID !== input.reservationID ||
          !validStoredDate(hold.date) || !validAmount(hold.costUSD)
        ) return { conflict: "mismatch" as const }
      }
      if (snapshot.holds.length > (hold ? 1 : 0)) return { conflict: "unsupported-hold" as const }

      const retirement: ReservationRetirement = {
        conversationID: input.conversationID,
        reservationID: input.reservationID,
        ...(hold ? { date: hold.date as string } : {}),
        reason: "cancelled_before_dispatch",
        retiredAt: Date.now(),
        released: Boolean(hold),
      }
      if (hold) await this.ctx.storage.delete(holdKey)
      await this.ctx.storage.put(retiredKey, retirement)
      return { retirement, released: Boolean(hold) }
    })
    if ("conflict" in result) {
      const error = result.conflict === "changed"
        ? "reservation snapshot changed after preview"
        : result.conflict === "unsupported-hold"
          ? "legacy or unrelated holds prevent cancellation"
          : "reservation ownership or fields do not match"
      return Response.json({ error }, { status: 409 })
    }
    return Response.json({ ok: true, retirement: result.retirement, released: result.released })
  }

  /** Apply one reviewed opening-balance cutover without releasing holds. */
  private async applyUsageCutover(input: {
    conversationID: string
    cutoverID: string
    expectedSnapshotID: string
    sessionID: string
    throughSeq: number
  }): Promise<Response> {
    const result = await this.ctx.storage.transaction(async () => {
      const key = usageCutoverKey(input.conversationID)
      const existing = await this.ctx.storage.get<UsageCutoverReceipt>(key)
      if (existing) {
        if (
          existing.cutoverID === input.cutoverID && existing.sessionID === input.sessionID &&
          existing.throughSeq === input.throughSeq &&
          existing.expectedSnapshotID === input.expectedSnapshotID
        ) return { receipt: existing }
        return { conflict: "existing" as const }
      }

      const snapshot = await this.usageCutoverSnapshot(input.conversationID)
      if (snapshot.snapshotID !== input.expectedSnapshotID) return { conflict: "changed" as const }
      if (snapshot.blockers.length > 0) return { conflict: "blockers" as const }
      if (snapshot.holds.length > 0) return { conflict: "holds" as const }

      const openingBalances: UsageOpeningBalance[] = []
      for (const row of snapshot.rows) {
        if (row.sourced === true) continue
        const opening = {
          costUSD: row.costUSD as number,
          input: row.input as number,
          output: row.output as number,
        }
        openingBalances.push({ date: row.date, ...opening })
        const stored = await this.ctx.storage.get<UsageRow>(`usage:${row.date}:${input.conversationID}`)
        await this.ctx.storage.put(`usage:${row.date}:${input.conversationID}`, {
          ...stored,
          ...opening,
          sourced: true,
          legacyOpening: opening,
          cutoverID: input.cutoverID,
          updatedAt: Date.now(),
        })
      }
      const receipt: UsageCutoverReceipt = {
        cutoverID: input.cutoverID,
        sessionID: input.sessionID,
        throughSeq: input.throughSeq,
        expectedSnapshotID: input.expectedSnapshotID,
        openingBalances,
        createdAt: Date.now(),
        historicalUsageUnreconciled: true,
      }
      await this.ctx.storage.put(key, receipt)
      return { receipt }
    })
    if ("conflict" in result) {
      const error = result.conflict === "changed"
        ? "usage ledger changed after cutover preview"
        : result.conflict === "blockers"
          ? "malformed legacy usage rows prevent cutover"
        : result.conflict === "holds"
          ? "unresolved reservations prevent usage cutover"
          : "a different usage cutover receipt already exists"
      return Response.json({ error }, { status: 409 })
    }
    return Response.json({ ok: true, ...result.receipt })
  }

  /**
   * Drop per-day counters, alerts and usage entries older than the retention
   * window, and registry entries that have not been touched. Runs with the
   * alert check (every 15 minutes), so storage stops growing forever.
   */
  private async prune(): Promise<number> {
    const now = Date.now()
    const cutoffMs = now - RETENTION_DAYS * 86_400_000
    const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10)
    let removed = 0

    for (const prefix of DAY_PREFIXES) {
      const entries = await this.ctx.storage.list<{ reserved?: boolean }>({ prefix })
      for (const [key, value] of entries) {
        const day = key.slice(prefix.length, prefix.length + 10)
        if (
          /^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoffDate &&
          !(prefix === "usage:" && value?.reserved === true)
        ) {
          await this.ctx.storage.delete(key)
          removed++
        }
      }
    }

    const usageSources = await this.ctx.storage.list<UsageSource>({ prefix: "usage-source:" })
    for (const [key, value] of usageSources) {
      if (validStoredDate(value?.date) && value.date < cutoffDate) {
        await this.ctx.storage.delete(key)
        removed++
      }
    }

    const registry = await this.ctx.storage.list<{ lastSeenAt?: number }>({
      prefix: "conversation:",
    })
    for (const [key, value] of registry) {
      if ((value?.lastSeenAt ?? 0) < cutoffMs) {
        await this.ctx.storage.delete(key)
        removed++
      }
    }

    // OAuth state values are short-lived and are deleted on use.
    const oauth = await this.ctx.storage.list<number>({ prefix: "oauth:" })
    for (const [key, expiresAt] of oauth) {
      if (typeof expiresAt === "number" && expiresAt < now) {
        await this.ctx.storage.delete(key)
        removed++
      }
    }

    return removed
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

function finiteAmount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

type UsageAmounts = { costUSD: number; input: number; output: number }
type UsageRow = UsageAmounts & {
  sourced?: boolean
  legacyOpening?: UsageAmounts
  cutoverID?: string
  updatedAt?: number
  reserved?: boolean
  reservationID?: string
  date?: string
  conversationID?: string
}
type UsageSource = UsageAmounts & { date: string; updatedAt?: number; cutoverID?: string; seq?: number }
type UsageOpeningBalance = UsageAmounts & { date: string }
type UsageCutoverReceipt = {
  cutoverID: string
  sessionID: string
  throughSeq: number
  expectedSnapshotID: string
  openingBalances: UsageOpeningBalance[]
  createdAt: number
  historicalUsageUnreconciled: true
}
type UsageCutoverRow = UsageAmounts & {
  date: string
  sourced?: boolean
  legacyOpening?: UsageAmounts
  cutoverID?: string
  updatedAt?: number
}
type UsageCutoverBlocker = { date: string; invalidFields: string[] }
type UsageCutoverHold = {
  key: string
  kind: "reservation" | "legacy-reservation"
  conversationID: string | null
  reservationID: string | null
  date: string | null
  costUSD: number | null
  reserved?: boolean
  updatedAt: number | null
  invalidFields?: string[]
}
type UsageCutoverSnapshot = {
  conversationID: string
  rows: UsageCutoverRow[]
  legacyRows: UsageCutoverRow[]
  blockers: UsageCutoverBlocker[]
  holds: UsageCutoverHold[]
  receipt?: UsageCutoverReceipt
  retirement?: ReservationRetirement
  snapshotID: string
}
type ReservationHold = {
  conversationID?: unknown
  reservationID?: unknown
  date?: unknown
  costUSD?: unknown
  updatedAt?: unknown
}
type ReservationRetirement = {
  conversationID: string
  reservationID: string
  date?: string
  reason: "released" | "cancelled_before_dispatch"
  retiredAt: number
  released: boolean
}

function validAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function boundedID(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256
}

function validStoredDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function validUsageDate(value: unknown): value is string {
  if (!validStoredDate(value)) return false
  const today = new Date().toISOString().slice(0, 10)
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10)
  return value <= today && value >= cutoff
}

function highWater(current: Partial<UsageAmounts> | undefined, next: UsageAmounts): UsageAmounts {
  return {
    costUSD: Math.max(current?.costUSD ?? 0, next.costUSD),
    input: Math.max(current?.input ?? 0, next.input),
    output: Math.max(current?.output ?? 0, next.output),
  }
}

function hasPositiveUsage(value: Partial<UsageAmounts> | undefined): boolean {
  return (value?.costUSD ?? 0) > 0 || (value?.input ?? 0) > 0 || (value?.output ?? 0) > 0
}

function usageCutoverKey(conversationID: string): string {
  return `usage-cutover:${conversationID}`
}

function retiredReservationKey(conversationID: string, reservationID: string): string {
  return `reservation-retired:${JSON.stringify([conversationID, reservationID])}`
}

function usageActualKey(key: string): { date: string; conversationID: string } | undefined {
  const match = /^usage:(\d{4}-\d{2}-\d{2}):(.*)$/.exec(key)
  if (!match || !validStoredDate(match[1])) return undefined
  return { date: match[1], conversationID: match[2]! }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function canonicalSnapshotValue(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) return { number: String(value) }
  if (typeof value === "bigint") return { bigint: value.toString() }
  return value
}

function legacyReservationOwner(key: string): string | undefined {
  return /^usage:\d{4}-\d{2}-\d{2}:reserve:(.*)$/.exec(key)?.[1]
}
