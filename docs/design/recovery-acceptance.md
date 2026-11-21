# Recovery acceptance matrix

> **Reference, not a plan.** Each row is a failure shape the harness has actually
> met in production, the guarantee it now gives, and the test that would fail if
> the guarantee were removed. Roadmap [R0-2](../roadmap.md) turns this into a
> measured task matrix; this page is the invariant half.

The 2026-11-20 incident produced eight distinct wedges. Seven are now closed by a
rule, and each rule has a regression that fails when the rule is removed — several
are mutation-checked in review. The row marked **open** is the one no rule covers
yet, and it is named rather than implied.

| # | Failure shape seen in production | Guarantee now | Regression |
|---|---|---|---|
| 1 | Runtime lost the session; observation failed every 60 s | Turn fails, prompts clear, container stops, lease releases; a dispatched reservation is retained and the turn is marked closed | `session-recovery.test.ts` — "settles the turn…", "retains a dispatched reservation…" |
| 2 | Closed turn re-armed by the next alarm | A closed turn owns no observation; dispatch/retry/abandon clear the marker | `session-recovery.test.ts` — re-wake assertion |
| 3 | Wake row lost across a restart | A lease renewal reconciles owed work where the runner will pick it up | `lifecycle-idle-integration.test.ts` — "re-arms an observation…" |
| 4 | Restart between dispatch and observation | The observation is rebuilt from durable state; the provider is **never** resubmitted | `lifecycle-startup.test.ts` — "never resubmits a dispatched turn…" |
| 5 | One unanswered runtime read held a latch for the instance's life | Reads are bounded (30 s) and the pump latch expires (10 min) with an owner token | `turn-observe-timeout.test.ts` — both cases |
| 6 | Dispatched turn with no provider outcome polled forever | An hour past dispatch the turn closes as `settlement_expired`, reservation retained | `stalled-settlement.test.ts` |
| 7 | Closed turn kept its container via queue + retained hold | Closed turns ignore accounting and admission state; real runtime work still blocks | `idle-close-eligibility.test.ts` |
| 8 | A failed job retried with nothing left to do | Retry only while the job owns work; never for a lost session | `job-failure-retry.test.ts` |
| 9 | Closure happened silently for hours | Closures and give-ups are alerts at the severity a person needs | `alerts.test.ts` |
| — | **Open:** settlement blocked by an unavailable budget authority | None yet: the turn pauses, then closes at the ceiling, but the *cause* is not separated from "usage unavailable" | — |

## How to use this

- **Before changing settlement, leases or observation:** find the row your change
  touches and run its regression first. A change that makes one of these rows
  untestable is a design change, not a fix.
- **Before accepting a new recovery mechanism:** add a row. A rule without a
  regression is a hypothesis.
- **When a wedge appears in production:** it belongs here, with the test that
  would have caught it. Eight rows exist because eight were discovered by hand.

## What these rows deliberately do not claim

- They assert *the harness does not make it worse*: no re-dispatch, no orphaned
  slot, no silent spend. They do not assert the provider turn succeeded — that is
  the task matrix's job.
- Timing assertions use the same clocks the code uses (bounded read, latch expiry,
  stall ceiling); a change to a constant moves the test with it rather than
  weakening the assertion.
