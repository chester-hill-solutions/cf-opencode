# R0 F2 — held-turn recovery

Status: scoped local implementation and verification complete · 2026-11-11
Baseline: existing dirty working tree; F1's latest local gate passed 351 tests.
Related: [roadmap](../roadmap.md), [F1 implementation](r0-reliability-iteration.md#f1-policy-and-legacy-cutover--2026-11-11), [runbook](../runbook.md#usage-and-budget).

## 1. Mission

Make held work inspectable and recover the cases supported by durable evidence.
Reuse existing polling, accounting and settlement. Never convert unknown charges
into zero spend or resend a prompt whose dispatch may have happened.

## 2. Key results

- Operators can see local ownership, Settings ownership, cached recovery evidence,
  blockers and permitted actions without changing accounting or starting a provider.
- A never-dispatched proposal can be cancelled safely, including when an earlier
  reservation request arrives late. Actual spend is unchanged.
- An operator can request immediate recovery of a dispatched turn through the
  existing alarm/settlement path. Release still requires F1's usage acknowledgement
  and execution-completion proof.
- Missing evidence, conflicting ownership, orphaned and legacy holds remain visible
  and retained. The interface describes what evidence/intervention is missing.

## 3. Assumptions and evidence boundary

The user's subsequent “Go” authorizes local implementation and tests. No deployment,
model call, live cancellation or live hold release is part of this execution.
Shared API-token access remains
the trusted-operator boundary; tenant authorization is R1 work.

Current hold references contain conversation ID, reservation ID and origin date.
Only Conversation stores `dispatched`; Settings does not prove whether a prompt was
sent. A strict local `dispatched === false` is evidence only under the current
mark-before-prompt protocol, while no local record proves nothing about a global hold.
Old records without that evidence stay blocked.

## 4. Locked decisions

**Inspect:** propose authenticated `GET /api/conversations/:key/recovery`.
Read local state plus the existing Settings `/usage/cutover` inventory, which already
lists matching new and legacy holds. Return a deterministic `snapshotID`, ownership,
phase, cached usage/execution/error details, blockers and allowed actions. Label
cached provider evidence as last observed, not a fresh completion proof. No provider
startup, prompt, cursor update, ledger write or conversation-registry write.

**Act:** propose `POST` on that path with
`{ "action": "retry" | "cancel_before_dispatch", "expectedSnapshotID": "..." }`.
Validate before forwarding; recompute the relevant snapshot under the admission
lock. Reject stale snapshots and live `admitting`/`pumping` activity. The public
request cannot supply an arbitrary hold ID, amount or force-release flag.

| Evidence | Action |
|---|---|
| Strictly undispatched local proposal; no live admission/pump, queued work or active execution; central hold matches or is absent | Allow cancellation of this proposal through atomic Settings retirement, then compare-clear local ownership after acknowledgement |
| Dispatched local reference; central reference matches, or is absent after a possibly lost release acknowledgement | Allow `retry`: schedule the existing recovery alarm; inspect the resulting state rather than promising release |
| Current terminal usage and execution proof becomes available | Existing `pumpOnce` → `settleTurn` → acknowledged replay → matching release performs recovery |
| Provider active, missing cost/log, rollback or unsafe runtime | Retain the hold; retry may collect new evidence, never bypass the proof |
| Another central owner, no local owner, legacy hold, malformed/unsupported evidence, or authority unavailable | Inspectable blocker; no cancellation, adoption, replacement or release |

**Fence delayed acquisition:** current `/usage/release` deletes a hold without retiring
its ID. A delayed `/usage/reserve` can then recreate that same hold. Add a durable
retirement marker keyed by conversation/reservation ID, checked before grant/reuse.
Retire atomically with matching release, including an acknowledged already-absent
hold. A conflicting current owner remains untouched. Repeated retirement is
idempotent; first recorded terminal decision is retained.

For never-dispatched cancellation, a small internal Settings operation compares the
current inventory snapshot, verifies the expected owner/absence, retires the ID and
removes only the matching hold in one transaction. A changed snapshot returns a
conflict. This fences a still-pending acquisition even when no hold exists yet.
Conversation clears its captured proposal only after that acknowledgement. A crash
between the central decision and local clearing must be recoverable from the marker.
Expose the captured proposal's retirement status in recovery inspection; do not
create a second global inventory/coordinator. A retired-ID denial may compare-clear
only the matching undispatched proposal; it cannot clear dispatched evidence.

Markers have **no automatic expiry**. Without an enforced maximum request lifetime,
a TTL would reopen the late-acquire race. Account for storage growth and preserve
markers across daily pruning and local reset. A future compaction scheme needs its
own ordering proof. No broader reservation expiry/lease system is introduced.

**Retry owns no new settlement implementation:** the endpoint schedules recovery
and returns `202`; it never prompts or releases directly. Reuse the current alarm
and settlement path, including error/report/release retries. Normal queued work may
advance only after the held turn is safely settled. Do not call `settleTurn` while
holding the usage queue: its replay would attempt to acquire that queue again.

## 5. Orchestration pattern

Parent locks this contract and integrates. Reuse the existing Luna owners, serialize
shared files, and reserve one Terra review for implemented ownership/retirement and
crash invariants. No new full-history agent contexts or broad research sweep.

## 6. Team and models

- Parent: scope, contracts, sequencing and acceptance; no separate model call.
- `luna_usage_ledger`: `gpt-6-luna` / high for the bounded authority/retirement edits.
- `luna_usage_caller`: `gpt-6-luna` / high for local ownership/action handling.
- `luna_usage_research`: `gpt-6-luna` / medium for fixture/docs support; prescribed
  checks can use low effort in a new context only if cheaper than reuse.
- `accounting_contract`: `gpt-6.1-terra` / high, one read-only implementation review.
  The reason for the stronger model is cross-request ordering and crash safety of
  hold retirement; routine implementation and check execution stay on Luna.

These names/efforts are supported by the current delegation tool. Overrides require
fresh context; reuse the existing matching owners where available. Maximum team
size is four including parent, so review starts after a research/implementation
owner finishes. No Astra or Sol invocation is required by this plan.

## 7. Bounded briefs and ownership

Authority owner: Settings reservation/release handlers, retirement inspection and
new retirement/cancellation regressions. Preserve F1 cutover and actual-spend rows.
Send the exact response/error schema to caller owner before caller implementation.

Caller owner: a small pure recovery-classification helper, Conversation handlers,
atomic compare-clear state helpers if required, Worker routing and recovery tests.
Reuse existing ownership and admission locks. No broad `conversation.ts` extraction;
that remains R1-4. Keep HTTP/Slack/queue admission paths consistent on retired-ID
denial without adding a resend loop.

Support owner: adapt only affected fixtures after schemas are locked; run gates and
update evidence from results. Do not edit caller/authority files concurrently.

## 8. Backlog and execution order

| ID | Deliverable | Owner / model | Depends | Done when |
|---|---|---|---|---|
| F2-1 | Source trace and locked scope | Parent + reused Luna readers | F1 | Existing recovery/hold paths and delayed-acquire failure documented; complete in this planning pass |
| F2-2 | Atomic ID retirement | Ledger owner, Luna/high | F2-1 | Late acquire before/after release cannot recreate a retired hold; other owners unchanged; no expiry/pruning |
| F2-3 | Read-only recovery inspection | Caller owner, Luna/high | F2-2 schema | Stable classification/snapshot with local, central and retirement evidence; no side effects |
| F2-4 | Cancel a never-dispatched proposal | Same caller + sequenced ledger owner | F2-2, F2-3 | Stale/live/dispatched/conflicting cases reject; missing date/central absence and lost acknowledgement recover safely |
| F2-5 | Trigger existing recovery | Same caller | F2-3 | Immediate alarm only; no ambiguous prompt resend; successful terminal settlement reports once and releases the matching hold |
| F2-6 | Independent invariant review | Reused Terra/high, read-only | F2-2–F2-5 | One review plus focused recheck of concrete fixes; no verified must-fix remains |
| F2-7 | Integrated checks and evidence | Reused Luna/medium | F2-6 | Existing gate passes; runbook/roadmap distinguish implemented recovery from unsupported cases and live evidence |

If a bounded Luna task fails twice, first repair its brief/context or split the
remaining function. Escalate only the unresolved invariant. Do not move the whole
feature to a larger model. Stop review after named fixes pass their focused recheck.

## 9. Scope and explicit deferrals

In: per-conversation inspection, safe pre-dispatch cancellation, immediate retry of
the existing recovery path and the retirement fence required to make cancellation
safe. No automatic timeout expiry, forced provider stop, replay of ambiguous prompts,
global orphan sweeper, arbitrary charge adjustment or manual “assume zero” waiver.

Legacy/orphan holds without ownership/dispatch evidence and irrecoverable billing
history remain unresolved. The interface must preserve and explain them; completing
these local slices does **not** claim every historical hold can be cleared or close
all broader F2/G0 criteria. Importing externally verified billing/stop evidence is
a separate scoped decision, not a hidden fallback in a release button.

## 10. Risks and backout

Retirement is persistent ordering state. Release and acquisition must be deployed
together; an older Settings writer can ignore retirement and recreate holds.
Quiesce writers before backout and retain markers, receipts, source rows, opening
balances and holds. Prefer a forward fix; never delete markers to restore headroom.
Production cutover/deployment is outside this iteration.

The working tree contains earlier changes. Capture the baseline, inspect introduced
hunks and never reset unrelated files. Preserve the current foreground policy,
execution fences, cutover receipt and accounting reconstruction semantics.

## 11. Acceptance rubric

Required proposed regressions:

1. Inspection is passive; invalid/unauthorized requests cause no mutation.
2. Cancellation retires an absent or matching strictly-undispatched proposal;
   reserve-before-cancel and cancel-before-reserve both leave no recreated hold.
3. Busy admission, queued work, dispatched proposal, mismatch, legacy/orphan hold,
   stale snapshot and authority failure retain all relevant evidence.
4. Lost cancellation/release acknowledgements and a crash before local clear retry
   idempotently; a newer generation is never cleared.
5. Recovery retry sends no prompt; uncertain/active/missing-cost/rollback cases stay
   held. Terminal evidence leads through existing acknowledged accounting/release.
6. Retirement survives midnight, daily pruning and local reset. Neither cancellation
   nor retry reduces actual spend or erases cutover/opening-balance metadata.
7. An old delayed acquisition after a normally settled release is rejected too;
   the fence is not limited to the new operator cancellation path.

## 12. Verification

Extend the existing budget reservation/helper, HTTP admission, turn settlement,
concurrency and reset suites. Add one focused recovery API suite and pure classifier
tests only for the new decision helper; no detached late test-writing phase.

Focused authority/caller checks first. After review, run existing `check:config`,
all four `typecheck` configs, `build:ui`, `test`, `test:workers`, and `git diff --check`.
Run Workers without concurrent heavy builds if the pagination fixture hits its
known resource-sensitive timeout. Do not loosen its assertions/timeout. Repeat
only checks affected by subsequent changes or failures. Local listener permissions
may require the already-used test escalation. Plan preparation ran no checks;
implementation verification is recorded below.

## 13. Deliverable

A reviewable local recovery API with runbook examples, regressions and explicit
blocked-case reporting. F2's recoverable cases can be locally verified while
unprovable legacy/manual-evidence cases remain open. No model-effectiveness or
numeric token-saving claim; this design reuses three existing Luna contexts and
existing recovery/accounting machinery.

## 14. Execution gate and source decisions

F2-1 through F2-7 are complete for this scoped local implementation. The user's
“Go” authorized execution; no deployment, live provider, Slack or production
recovery action occurred.

The final gate passed **222 unit tests in 36 files** and **149 Worker tests in 31
files** (371 total), configuration, all four typecheck configs, UI build and diff
checks. Logs: `/tmp/cf-opencode-recovery-*.log`. Terra accepted the retirement,
ownership and passive/retry invariants, plus the focused release/cancellation
acknowledgement-race correction. Luna implemented the authority/caller slices and
ran tests; the parent integrated contracts and evidence.

Implemented surfaces: passive `GET /api/conversations/:key/recovery`, snapshot-bound
`POST` with the two specified actions, internal atomic retirement/cancellation,
and shared admission/settlement retirement handling. Normal releases and explicit
cancellations both fence late acquisition. Actual spend and F1 metadata remain
unchanged by cancellation. A cancellation crossing an earlier release accepts the
original valid retirement reason rather than inventing a replacement decision.

Tests cover both acquire/cancel orders, stale/foreign ownership, malformed and
legacy holds, absent holds, first-receipt idempotency, pruning, passive inspection,
invalid controls, lost acknowledgements, newer local proposals, queued/cached-active
dispatched retry, and recovery through real DO/Settings accounting and settlement
with injected provider responses. See [verification](../testing.md#f2-held-turn-recovery-verification--2026-11-11).

Broader F2 remains open for legacy/orphan/mismatched records without proof, external
billing/stop-evidence import and live recovery validation. Those cases are exposed
and retained, not silently cleared. G0/G1 and credential isolation remain open.

Local primary evidence: `Conversation.alarm`, `pumpOnce`, `settleTurn`,
`replayUsageLog`, `acquireBudgetReservation`, `releaseBudgetReservation`;
`ConversationStore.markBudgetReservationDispatched`; Settings reserve/release and
`usageCutoverSnapshot`. These already provide most recovery/accounting behavior.

Provider lookup removed a proposed automatic resend: v2.2.5 supports caller-chosen
`msg_…` prompt IDs and first-admission-wins reconciliation, but a repeat prompt also
calls `execution.wake()`. Execution/usage events bind to the session, not the prompt.
Do not mistake admission deduplication for execution or billing idempotency.
Adding prompt correlation is deferred until a named recovery case requires it.
Sources: [prompt admission](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/session.ts#L149-L183),
[inbox reconciliation](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/inbox.ts#L115-L210),
[message ID schema](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/session-message.ts#L18-L24).
