# S8 — Operator reconciliation and idle runtime migration

## Outcome and boundary

Resolve the two identified test holds through individually approved decisions,
preserve their evidence, then migrate the idle original DM to the verified evented
image. Return the temporary container limit to two once the held runtimes can
safely stop. No manual decision has been approved or applied yet.

Existing F1/F2 recovery remains unchanged. It cannot infer missing charges or
accept external evidence. This is a separate operator-only path using the existing
Settings transaction and permanent reservation retirement mechanisms.

## Locked decisions

- `observed_actual`: import the HTTP turn's exact assistant-context amount
  `$0.0017703`, 5,885 input / 4 output tokens, attributed to November 11 UTC.
  The terminal assistant ID is the correlation identity; the rounded Console
  amount is corroboration. A preview must show any source conflict and exact
  proposed ledger increment. This first slice blocks importing over existing
  session usage whose ownership cannot be proved.
- `acknowledged_unknown`: an optional, explicitly approved administrative close
  of the failed DM's exact reservation. Actual cost remains `null`, never zero.
  It writes no zero usage source and reduces no recorded spend. The approval must
  explain that reported spend and budget headroom exclude a possible historical
  charge after the reservation is released. Keeping the hold is a valid choice.
- Unknown closure remains permanently visible in normal usage/recovery views,
  including after a restart or UTC day change. Later actual usage is accounted
  normally; the receipt is not a cutover watermark and cannot suppress it.
- Both decisions require immutable operator/evidence references and digests,
  exact conversation/session/reservation/origin date, local and central snapshots,
  exact amount or explicit unknown, and fresh quiescence proof. They are not
  available through Slack commands.
- Keep reservation `originDate` distinct from `usageDate`. An observed import
  names the evidence-backed usage day explicitly; the preview explains its
  timestamp basis. Unknown closure has no usage date. Cross-midnight usage must
  not be charged to the reservation day merely because that is the hold's owner.
  The first public preview supports the two identified same-day cases; it blocks
  a cross-day import until its separate daily-total projection is implemented.
  The central contract still records and tests the dates separately.
- Prove quiescence with native `experimental.session.wait`, an empty inbox and
  no pending permission/form work, while holding admission, pump and usage fences.
  Verify the same runtime generation before and after. Interrupt acknowledgement,
  timestamps, timeouts and a missing assistant are not sufficient proof.
- Settings atomically compares authority, records the receipt and any monotonic
  usage increment, then permanently retires only the matching owned hold. An
  identical retry returns the receipt; a conflicting decision fails closed.
  Conversation compare-clears only that local owner after acknowledgement. A
  crash or lost acknowledgement must not double account or clear newer work.
- An observed assistant receipt may cover a later native source only when the
  assistant, session, date and source ownership match. Account only positive
  excess over the covered amount. Conflicting identities require review rather
  than silent suppression or a claimed deduplication.

## Ownership and order

| ID | Owner / model | Deliverable and acceptance |
|---|---|---|
| S8a | Parent; Terra/high review accepted | Locked authority and quiescence contract; no general accounting dashboard, estimate-charge schema or automatic waiver |
| S8b | Existing dispatch owner, `gpt-6-luna` / high — complete and reviewed | Typed operator contract and Settings preview/transaction; ledger, retirement, stale-owner, replay, unknown-marker, late-source and cross-date budget regressions |
| S8c | Same Luna owner — complete and reviewed | Fenced Conversation preview/apply, authenticated HTTP forwarding, local compare-clear, native wait/inbox proof and crash-retry tests; first-turn undefined baseline accepted with regression |
| S8d | Existing dispatch owner, `gpt-6-luna` / high — complete and reviewed | Idle migration controller, verified split checkpoints, durable image binding and original-session restore barrier; fail closed on restore/proof failure |
| S8e | Existing Terra/high reviewer, read-only — complete | Contract, lifecycle, security and accounting findings resolved; integrated gate passed |
| S8f | Operator + parent — pending | Obtain separate approval for each exact preview; apply only approved decisions, verify receipts and idle state, then migrate and stop only safely reconciled runtimes |

S10 image helper work can run independently. Shared Conversation edits are
sequenced between S10 routing and S8c. Routine implementation stays on Luna;
escalate only an unresolved contract or failed bounded repair.

## Verification and backout

Test null versus zero, no fabricated usage row, day rollover, late actuals once,
source conflicts, stale snapshots, wrong ownership, queued/live work, runtime
generation changes, unreadable inbox/wait failure, atomic receipt/ledger/retirement,
lost acknowledgement, duplicate/conflicting decisions and no decreasing totals.
Run the existing integrated checks after source integration. Keep both live holds
until their concrete proposals have been approved.

Migration is a distinct step after reconciliation: preview the exact idle
conversation, verify both checkpoint parts, select the pinned evented image,
restore and verify session/history plus native event capability. Do not destroy a
held runtime. Keep permanent receipts, retirement markers and archived evidence
through any backout; never roll back to a writer that ignores their fences.

## S8d implementation contract

Implementation status: the pure intent validator and restored-session barrier
in `src/runtime-upgrade.ts`, plus the Durable Object migration controller,
checkpoint capture/verification and crash recovery, passed independent review
and local verification. The integrated gate passed 562 tests (307 Bun, including
5 runtime tests, and 255 Worker), all five typechecks, config, UI, diff and dry-run
deployment checks. No live hold has been changed and no reconciliation approval
has been applied.

S8c first-turn evidence: the original HTTP conversation can have an undefined
local `turnBaseline` on its first accepted turn; that is a valid pre-turn state.
After the durable `runStartedAt` marker, its native history contains exactly one
user message followed by one assistant message with measured usage. The preview
guard now accepts this shape and has a regression test.

Migration sequence evidence: OpenCode 2.2.5 advances its per-session
`EventSequenceTable` even when `events.persist` is false, while omitting the
payload rows. The exact database is under `XDG_DATA_HOME` in the split state
archive, so restoring that part preserves the old sequence watermark; keep the
DO usage cursor and do not add a cutover or reset solely for image migration.
If the state archive is missing or the database is recreated, fail closed rather
than allowing the preserved cursor to skip new events.

Reuse `withAdmissionLock` and the existing usage lifecycle fence for the entire
operation; also reject local/central holds, queued work, non-idle phase, and
`checkpointPending`. Run `proveRuntimeQuiescence` against the original session
while fenced. `checkpoint()` is serialized by `checkpointTail`, but returns true
for legacy single-archive checkpoints and does not by itself prove both parts.
After it succeeds, read the published manifest and verify that both workspace
and state objects exist and are readable. Require a split checkpoint for this
migration. Do not prune or replace the pinned manifest during the operation.

Before destroying anything, transactionally persist the evented image binding
and a pending migration record containing plan ID, original session ID, native
context digest, exact checkpoint manifest/object keys, and pinned target image
digest. Check the configured image still matches that digest. Then reuse the
safe idle recycle sequence to destroy the base container and clear in-memory
ready/port/generation/inactivity caches, while retaining the old snapshot and
all checkpoint objects. Evented startup already ignores the base snapshot and
restores workspace then state from R2. The old runtime's `eventPersistence`
proof is false, so the existing `ensureSession` gate prevents prompt admission;
pending migration must additionally block the ready fast path and queue drain.

Before `doEnsureReady` returns a port or `ensureSession` can create a replacement,
verify event persistence, pinned image digest and runtime generation, then prove
quiescence again for the *original* session. Require that `session.get` still
returns that ID and the canonical context digest matches the pre-checkpoint
digest. Any missing object, session, proof or digest leaves the pending record
intact and fails closed; never silently replace the session or downgrade to the
base image. On success, atomically record a completion receipt and mark the
migration complete. Keep the old snapshot/archive and receipt as evidence.

Crash recovery is driven by the durable pending record: before destroy, retry
the same migration under the fences; after destroy, lazy readiness restores and
verifies before allowing admission. Alarm checkpoint retries must not overwrite
the captured manifest while pending. Existing `onRecycle` provides the lock,
active-turn check and cache-reset pattern, but cannot be called unchanged: it
clears the snapshot, lacks central-hold/quiescence checks, and has no restore
identity gate. Tests should cover busy/held rejection, partial/missing checkpoint
parts, both crash windows, settings/image drift, failed native proof, digest or
session mismatch, successful restored-session continuity, and receipt replay.
