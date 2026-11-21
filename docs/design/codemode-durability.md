# CodeMode durability — what it changes here

> **Design input, not a plan.** Sequencing and gates live in
> [docs/roadmap.md](../roadmap.md) (queue row R0-24). This note records the
> decisions the harness will have to make and the ones it must not re-litigate
> when the upstream API reaches our pin.

Status: **upstream only; not reachable from this repo.** Verified locally on
2026-11-21: `runtime/opencode/package.json` pins `@opencode/server` 2.2.5, the
Worker pins `@opencode/client` 2.2.5, and `@opencode/codemode` is in neither
package graph. Everything below about `Tool.idempotent` / `Tool.durable` comes
from the upstream summary, not from reading the package here.

## The upstream shape

Long-running CodeMode programs can be snapshotted and resumed in another process
on the same interpreter build. Every tool call carries `<runId>:<callId>`.
Three categories, by what happens to a call that is in flight when a suspend
lands:

| Category | Suspended mid-call | Resumed |
|---|---|---|
| plain | suspend refused | — |
| `Tool.idempotent` | call interrupted | re-executed under the same key, not double-counted |
| `Tool.durable({ start, wait, cancel })` | job outlives the suspend | `wait` reconnects by handle; `cancel` only on a real abort |

This is journal-and-replay, not engine snapshotting. That is the only version
available to us: a Cloudflare container cannot be frozen, so "snapshot the
interpreter" was never on the table.

## The harness already has this split — for a different unit of work

| CodeMode | cf-opencode |
|---|---|
| plain tool | dispatched turn: `idle-close` refuses while it runs (`ineligibleReason`, `src/conversation/idle-close.ts`) |
| idempotent tool | lifecycle job: bounded retry fenced by `epoch` + `claimID` (`handoff`, `src/conversation/scheduler.ts`) |
| durable tool | checkpoint in R2 plus the lease that holds the slot (`src/conversation/checkpoints.ts`, `lease.ts`) |

The mapping is close enough that adoption is mostly naming and three decisions.

## Decision 1 — a suspend is not a stop

Every change this week made `container:idle` **more** willing to stop a
container. A suspended program needs the opposite, and must be distinguishable
from both states we already have:

| State | Meaning | Container |
|---|---|---|
| dispatched / running | provider work in flight | stays up (`ineligibleReason` → `not_idle_<phase>`) |
| closed (`closedTurn`) | cannot finish; operator decides the reservation | closes (`idle-close.ts`) |
| **suspended** | paused on purpose, will resume | **stays up**, and is not an idle candidate |

Consequence: a suspended run needs its own marker with its own eligibility rule.
Reusing `closedTurn` would be wrong — it authorises the close.

## Decision 2 — snapshot identity is image identity

A snapshot is only valid on the same interpreter build. The repo already pins the
image digest and `@opencode/server` version, and `ConversationImages.clearSnapshot()`
is the precedent for invalidating state when the runtime changes.

A resume key must therefore carry at least: **image digest + `@opencode/server`
version + `runtimeGeneration`**. A repin PR that changes any of them invalidates
snapshots instead of resuming a program into a mismatched interpreter. Today's
`runtimeGeneration` is per-instance, so this is a new, independent key — not a
reuse of the generation fence.

## Decision 3 — a durable wait is patient, not stalled

`pauseSettlement` closes a dispatched turn one hour past dispatch
(`STALLED_SETTLEMENT_MS`, `closedTurn.reason = "settlement_expired"`,
`src/conversation/turn-execution.ts`). That ceiling exists because a turn that
cannot settle will never settle.

A `wait` on a durable tool is different: it is *expected* to be long, and the
work is alive by definition. Without an exemption, the ceiling would kill exactly
the programs this feature exists to preserve. The timeout classification that
feeds it (`staleAction` → `"timeout"`, `src/lifecycle.ts`) has the same problem:
it judges by `runStartedAt` age alone.

So: a turn blocked in `wait` must report that fact in persistent state, and both
the ceiling and the timeout classification must read it.

## Acceptance criteria, taken from this week's failures

Each of these looked like a bug in the settlement path and was not. A resume
implementation has the same shapes and must pass all four:

1. **A wake row that never runs.** Rehydration must reconcile work from durable
   state at a point where the runner will actually pick it up (see #110/#112).
2. **A latch that never clears.** An in-memory flag gating every retry must be
   time-bounded; one unanswered read once pinned a slot for an instance's life
   (#114).
3. **Closed work that still holds a container.** A retained reservation and a
   queued message are accounting and admission state, not runtime work (#118).
4. **Polling forever.** Every "keep checking in case it appears" loop needs a
   ceiling and a terminal state (#116).

## Open questions, to answer when the API lands

- Where snapshots live: DO storage or R2. R2 already holds checkpoints and is
  portable across instances; DO storage is per-object and simpler.
- Whether `wait` needs the *same* container instance or only a reachable handle.
  The lease model assumes the latter is possible.
- Whether our public `idempotencyKey` (`MessageRequest`, validated in
  `src/index.ts`) should adopt the `<runId>:<callId>` shape or stay opaque.
- What a suspend means for an in-flight SSE reader
  (`ConversationTurnExecution.runStream`): today only `recycle` fences one.

## Trigger for implementation

When `@opencode/server` at a newer pin exposes the API: bump the pin (three
places — image digest, `runtime/opencode` packages, `@opencode/client`), then add
the suspended state, the snapshot key, and the durable-wait exemption in that
order, each with a regression of the criterion it protects.
