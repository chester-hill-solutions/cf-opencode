# S8 — Operator reconciliation and idle runtime migration

## Outcome and boundary

Both identified holds have been resolved through separately approved decisions,
with their evidence preserved. The idle original DM was migrated to the verified
evented image with history intact, and the configured container limit is back to
two. Final DM reply verification and free-capacity confirmation remain open.

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
| S8f | Operator + parent — complete | Both receipts verified; original DM `READY` and history verified after migration; configured cap 2, one free slot, unknown marker preserved |

S10 image helper work can run independently. Shared Conversation edits are
sequenced between S10 routing and S8c. Routine implementation stays on Luna;
escalate only an unresolved contract or failed bounded repair.

## Verification and backout

Test null versus zero, no fabricated usage row, day rollover, late actuals once,
source conflicts, stale snapshots, wrong ownership, queued/live work, runtime
generation changes, unreadable inbox/wait failure, atomic receipt/ledger/retirement,
lost acknowledgement, duplicate/conflicting decisions and no decreasing totals.
Run the existing integrated checks after source integration. Keep every
unapproved live hold until its concrete proposal has been approved.

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
deployment checks. Both live reservations were retired by approved decisions;
the unknown marker remains visible and does not mean zero spend.

Current approval state: the operator approved HTTP observed actual via
`call_2a0e410c0bbf4d229fb8953999c00e53`. The apply returned HTTP 200,
`replayed:false`, and `localCleared:true`; permanent receipt
`operator-876c3eba6014c49aa687a8724b6e757dd6fddd3d` retired and released exact
reservation `1ce57c48-32e1-4b4f-aa11-692216542498`. It recorded `$0.0017703` on
November 11 UTC. The HTTP conversation is idle with no recovery action or hold;
checkpoint/recycle completed with HTTP 200. Current November 12 spend remains
`$0.00460875`.

The fresh DM unknown-amount preview returned HTTP 200 and `canApply:true`, with
actual amount `null` and proposed release of its `$0.10` hold. The operator
approved via `call_e53ecc24d691493b9565e2718dd40254`; apply returned HTTP 200,
`replayed:false`, and `localCleared:true`. Receipt
`operator-9a943abf0a815dcb8dc2c36647e2fd400436dcae` retired and released exact
reservation `1f331927-e11e-4b65-9831-d72729eb19cc` with `actualCostUSD:null` and
no usage date. Settings now reports `unknownReconciliationCount:1` and
`historicalUsageUnreconciled:true`; this is not a zero-cost finding. Both holds
are closed. Immediately after both approvals, November 12 spend was `$0.00460875`.

The idle original DM migration completed under plan
`f986f4cb283df8e651a6087ab5e09b7c179502625ade4164b0a6cb3a71b692d7`. Original
session `ses_e33354e0effeRpcilJlpFgel4b` remains present with all three original
history entries identical; verified context digest is
`ecb88dc0f8bfd5f277f8345d866a5ab513ccdc4379a392e82f3aab0a89df4453`. Workspace
and state checkpoint parts (181 and 1,671,410 bytes, encrypted) were verified
before switching to pinned evented image digest
`826337168d6d3820181d39c69764787da6e934217889370c0a91399adc5da431`; new runtime
generation is `pV140CxssNghF_XRLC-bInylwhHJW-1A`. Original archives remain intact.
The configured max-concurrent-container limit is restored to two at settings
version 8. After that safe settings restart, the original session was still
present and idle (`timeBusy:false`) under runtime generation
`Kh7PbjuKuFhHHLyTfqxFn6QsiVYPgg7O`. Its final `READY` reply is assistant
`msg_1ce191b42001rDs3TJH5raq91t`, cost `$0.0018723` (6,225 input / 4 output
tokens); durable usage acknowledgement is exact at start seq 8, step seq 15 and
terminal seq 16. `!usage` reports `$0.0065` rounded, `$0.0000` reserved, and the
historical-usage warning. Exact November 12 spend is `$0.00648105` (20,566 input
/ 164 output); `unknownReconciliationCount` remains 1. The max-2 lease check
shows only the original DM active, with one free slot; the old HTTP lease expired
and HTTP/Slack/admin test workspaces are stopped. The DM is warm and ready.
Evidence: `/tmp/aboiteau-slack-dm-recovered.png` and private
`/tmp/cf-opencode-s8-final-live-proof.json`. S8 is complete; retain the permanent
unknown-history warning as accepted uncertainty.

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
