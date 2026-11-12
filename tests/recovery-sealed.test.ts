import { describe, expect, it } from "bun:test"
import { classifyRecovery, recoverySnapshotID, type RecoveryAuthority, type RecoverySchedulerEvidence } from "../src/recovery"
import type { ConversationState } from "../src/state"

const live = { admitting: false, pumping: false }

function idleState(patch: Partial<ConversationState> = {}): ConversationState {
  return {
    phase: "idle",
    sessionID: "ses_idle",
    usageExecution: { sessionID: "ses_idle", startedSeq: 8, terminalSeq: 8, latestStepSeq: 8 },
    seen: [],
    pending: {},
    ...patch,
  }
}

function authority(patch: Partial<RecoveryAuthority> = {}): RecoveryAuthority {
  return {
    conversationID: "conv-1",
    snapshotID: "authority-snapshot",
    holds: [],
    legacyRows: [],
    ...patch,
  }
}

function scheduler(patch: Partial<RecoverySchedulerEvidence> = {}): RecoverySchedulerEvidence {
  return {
    sealed: true,
    epoch: 4,
    checkpointPending: false,
    claims: {},
    activeJobs: 0,
    pendingUpgrade: false,
    ...patch,
  }
}

describe("sealed idle recovery classification", () => {
  it("offers retry only for a fully quiescent sealed idle conversation", () => {
    expect(classifyRecovery({
      conversationID: "conv-1",
      state: idleState(),
      authority: authority(),
      live,
      scheduler: scheduler(),
    })).toEqual({ kind: "sealed_idle", blockers: [], actions: ["retry"] })
  })

  it.each([
    ["local phase", { state: idleState({ phase: "queued" }) }],
    ["queue", { state: idleState({ queued: { text: "later", attempts: 0 } }) }],
    ["live operation", { live: { admitting: true, pumping: false } }],
    ["pending upgrade", { scheduler: scheduler({ pendingUpgrade: true }) }],
    ["active scheduler job", { scheduler: scheduler({ activeJobs: 1 }) }],
    ["missing authority", { authority: undefined }],
    ["authority owner mismatch", { authority: authority({ conversationID: "other" }) }],
    ["central holds", { authority: authority({ holds: [{ conversationID: "conv-1", reservationID: "h", kind: "reservation" }] }) }],
    ["legacy rows", { authority: authority({ legacyRows: [{ row: 1 }] }) }],
    ["authority blockers", { authority: authority({ blockers: ["ledger_ambiguous"] }) }],
    ["execution session mismatch", { state: idleState({ usageExecution: { sessionID: "ses_other", startedSeq: 1, terminalSeq: 1, latestStepSeq: 1 } }) }],
    ["unfinished execution", { state: idleState({ usageExecution: { sessionID: "ses_idle", startedSeq: 2, terminalSeq: 1, latestStepSeq: 1 } }) }],
    ["malformed lease intent", { scheduler: scheduler({ leaseIntent: { desired: "held" } }) }],
    ["malformed claims", { scheduler: scheduler({ claims: { "turn:observe": { epoch: 4, claimID: "x", until: "later" } } }) }],
    ["current epoch claim", { scheduler: scheduler({ claims: { "turn:observe": { epoch: 4, claimID: "x", until: Date.now() + 60_000 } } }) }],
  ] as const)("blocks when %s", (_name, patch) => {
    const input = {
      conversationID: "conv-1",
      state: idleState(),
      authority: authority(),
      live,
      scheduler: scheduler(),
      ...patch,
    }
    const result = classifyRecovery(input)
    expect(result.kind).toBe("blocked")
    expect(result.actions).toEqual([])
    expect(result.blockers.length).toBeGreaterThan(0)
  })

  it("allows expired claims, including claims from an older epoch, to be invalidated", () => {
    const result = classifyRecovery({
      conversationID: "conv-1",
      state: idleState(),
      authority: authority(),
      live,
      scheduler: scheduler({ claims: {
        "turn:observe": { epoch: 4, claimID: "expired-current", until: Date.now() - 1 },
        "lease:renew": { epoch: 3, claimID: "old-epoch", until: Date.now() + 60_000 },
      } }),
    })
    expect(result).toEqual({ kind: "sealed_idle", blockers: [], actions: ["retry"] })
  })

  it("accepts absent or valid persisted lease intent", () => {
    const state = idleState()
    const base = { conversationID: "conv-1", state, authority: authority(), live }
    expect(classifyRecovery({ ...base, scheduler: scheduler() }).kind).toBe("sealed_idle")
    expect(classifyRecovery({ ...base, scheduler: scheduler({ leaseIntent: {
      version: 1,
      desired: "held",
      status: "acknowledged",
      requestStartedAt: 100,
      acknowledgedUntil: 200,
    } }) }).kind).toBe("sealed_idle")
    expect(classifyRecovery({ ...base, scheduler: scheduler({ leaseIntent: {
      version: 1,
      desired: "released",
      status: "pending",
      requestStartedAt: 100,
    } }) }).kind).toBe("sealed_idle")
  })

  it("allows sealed idle checkpoint retry and brand-new idle state without session execution metadata", () => {
    expect(classifyRecovery({
      conversationID: "conv-1",
      state: idleState(),
      authority: authority(),
      live,
      scheduler: scheduler({ checkpointPending: true, checkpointRetryAt: Date.now() }),
    })).toEqual({ kind: "sealed_idle", blockers: [], actions: ["retry"] })

    expect(classifyRecovery({
      conversationID: "conv-1",
      state: { phase: "idle", seen: [], pending: {} },
      authority: authority(),
      live,
      scheduler: scheduler(),
    })).toEqual({ kind: "sealed_idle", blockers: [], actions: ["retry"] })
  })

  it("keeps the existing financial classification branch unchanged", () => {
    const result = classifyRecovery({
      conversationID: "conv-1",
      state: idleState({
        budgetReservation: { reservationID: "r1", date: "2026-11-12", dispatched: true },
      }),
      authority: authority({
        holds: [{ conversationID: "conv-1", reservationID: "r1", date: "2026-11-12", kind: "reservation" }],
      }),
      live,
    })
    expect(result).toEqual({ kind: "dispatched", blockers: [], actions: ["retry"] })
  })

  it("binds supplied scheduler and authority-blocker evidence into snapshots without changing old inputs", async () => {
    const base = { conversationID: "conv-1", state: idleState(), authority: authority(), live }
    const withoutScheduler = await recoverySnapshotID(base)
    expect(await recoverySnapshotID(base)).toBe(withoutScheduler)
    expect(await recoverySnapshotID({ ...base, scheduler: scheduler() })).not.toBe(withoutScheduler)
    expect(await recoverySnapshotID({
      ...base,
      authority: authority({ blockers: ["ambiguous_history"] }),
    })).not.toBe(withoutScheduler)

    const schedulerSnapshot = await recoverySnapshotID({ ...base, scheduler: scheduler() })
    for (const changed of [
      scheduler({ epoch: 5 }),
      scheduler({ checkpointPending: true }),
      scheduler({ leaseIntent: { version: 1, desired: "held", status: "pending", requestStartedAt: 1 } }),
      scheduler({ claims: { "turn:observe": { epoch: 3, claimID: "expired", until: 1 } } }),
      scheduler({ activeJobs: 1 }),
    ]) {
      expect(await recoverySnapshotID({ ...base, scheduler: changed })).not.toBe(schedulerSnapshot)
    }
  })
})
