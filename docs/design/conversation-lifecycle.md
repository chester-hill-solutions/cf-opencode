# Conversation lifecycle kernel

Status: implemented and locally verified; native CI and isolated Cloudflare cold
restore qualification passed. Production has not been rolled out.
Implementation sequence: [adoption plan](../plans/conversation-lifecycle-adoption.md).

We use `agents@0.33.0` through `agents/lifecycle` on the existing Conversation
Durable Object. The SDK supplies the SQLite job queue and physical alarm driver.
It does not own our prompts, accounting ledger, permission decisions or runtime.
The compatibility fixture proves SQL job insertion, KV dispatch metadata and
alarm publication can share one rollback/commit boundary in Worker SQLite.

Conversation job IDs describe wake intents, not additional provider operations.
`ConversationStore` remains the authority for one active turn, one queued
follow-up, dispatch ownership, usage fences and public event history. Recovery
still uses Settings-owned holds and the existing classifier. An ambiguous
provider request is observed/reconciled; a queue retry is not permission to
submit it again. Scheduler failure or memory sealing cannot establish zero cost
or release an unresolved reservation.

Startup initializes local scheduling metadata without activating dormant holds.
An existing pre-SDK physical alarm is translated once, preserving its deadline;
its bootstrap fills only missing domain jobs. A passive read without that old
wake does not create recovery work. The conversion marker survives eviction,
so later SSE heartbeat alarms cannot be mistaken for legacy turn recovery.

SDK singleflight is not a side-effect lock: replacing a same-ID job can clear
its running marker. Domain locks and current ownership/epoch checks are still
required. Slow work needs a durable backstop before it leaves the alarm handler;
`waitUntil` keeps the invocation alive, while `trackAlarmWork` observes failures
for the SDK breaker. A completed old attempt must not cancel a newer intent.

Separate owners now handle encrypted checkpoints, image/snapshot selection,
runtime cache/ports, readiness, usage replay, reservations, recovery actions,
admissions, runtime upgrades, reconciliation, cutover and control tokens/forms.
The coordinator retains transport routing and composition. Settings remains the lease authority: a named
job renews its ten-minute lease halfway through its acknowledged lifetime.
Unknown release outcomes retain durable retry intent. Destructive lifecycle
actions keep state when stop or release is unconfirmed; new dispatch requires
a valid lease while observation of existing dispatched work remains possible.

Runtime access uses a fair shared/exclusive gate. A client borrow covers response
and log consumption; checkpoint capture enters that gate before its publication
tail. Readiness and teardown use explicit already-owned primitives rather than
reentrant access. The native event reader is separately owner-fenced and cancelled
on every physical stop; it never holds a permanent shared borrow. Idle/admin
cleanup takes admission, drains that stream, serializes usage, then takes runtime
exclusivity. Lease renewal has an independent tail and can run during long I/O.

Idle close proves the session is quiescent and Settings has no unresolved owner,
then authenticates both published encrypted archives by streaming their full
contents. It persists a close intent before stopping, invalidates fast snapshots,
and releases capacity only after confirmed stop and authority acknowledgement.
Queued uses wait for a committed close, then restore the same durable session.
Unknown stop/release retains the intent and returns a retryable 503. An already
stopped binding can release capacity without changing any financial hold.

Memory sealing preserves financial uncertainty. A snapshot-fenced operator retry
can also resume a sealed idle conversation without a reservation: it rechecks
Settings, cached execution, epoch, active claims and maintenance intent, then
atomically unseals and restores checkpoint, lease and idle maintenance jobs.
Failure rolls back the unseal. Cleanup returns an actionable 409 until that retry;
it never infers zero usage. Existing dispatched recovery remains observation only.

Named identity comes from `ctx.id.name` before alarm startup, and forwarded headers
must agree. Missing identity blocks runtime preparation rather than selecting a
global account seed. This uses the documented [named-object alarm identity](https://developers.cloudflare.com/durable-objects/api/id/).

The HTTP EventStream capability owns process-local subscribers and its own
heartbeat job. Replay entries are appended by ConversationStore before broadcast;
heartbeat comments do not append events or acquire a container. On eviction,
subscribers disappear and startup removes their orphan heartbeat. Its byte-based
queue now enforces the intended slow-subscriber threshold; default count-based
stream buffering did not enforce that byte budget.

HTTP clients retry a submission with the same JSON `idempotencyKey` (1–128
letters, digits, colon, underscore or hyphen), scoped to the conversation. Never
reuse a key for different content. A duplicate HTTP 200 acknowledges the retained
claim, not provider completion; queued HTTP 202 is not a permanent receipt.
The store keeps 200 recent claims, and prompted/ambiguous dispatches attempt a
24-hour tombstone. Definite pre-dispatch refusals release the claim; queued
submissions rely on the bounded claim window. These are bounded dedupe rules,
not a permanent operation ledger.

SSE clients reconnect with numeric `Last-Event-ID`; the store retains 200 public
events. An expired cursor receives `reset`, so the client reloads state/context.
No new snapshot/after/follow API is introduced here. The native durable session
log remains the accounting evidence source, separate from public replay.

## Differences from official OpenCodeHarness

| Concern | This harness |
|---|---|
| Execution | Full OpenCode server in a Cloudflare Container, with process tools and native stow-s3 Workspace. No Workerd embedding. |
| Durable runtime state | Versioned, application-encrypted workspace/state R2 archives with verified manifests. OpenCode sessions remain in the container state archive, not the DO's session tables. |
| Scheduling | Selected Lifecycle jobs/capabilities only. No additional Agent queue, Tasks engine or duplicate provider dispatcher. |
| Authorization/accounting | Existing non-relaxable permission denies, constant-time control auth, tenancy, Settings, budgets, holds and operator receipts remain authoritative. |
| Public replay | Existing retained 200-event SSE log, cursor replay and reset; not a new SDK session.events()/session.log() protocol. |
| Submission dedupe | Existing idempotency keys and bounded dedupe/tombstones. This is not a permanent receipt or exactly-once provider guarantee. |
| Idle close | Approximately 30 seconds after completed native runtime use, subject to quiescence, ledger and encrypted split-checkpoint proof. Public SSE/diagnostic reads do not refresh it. The platform ten-minute safety timeout remains. Measured empty-session cold context median is 6.44 seconds versus 187 ms warm; see bench results. |

The official [Lifecycle](https://developers.cloudflare.com/agents/runtime/lifecycle/)
and [OpenCodeHarness](https://developers.cloudflare.com/agents/harnesses/opencode/)
references explain the upstream patterns. Our runtime/recovery contracts above
remain specialized. SDK diagnostics are advisory; existing tracing, head sampling
and durable accounting evidence must retain their separate roles.

Lifecycle telemetry uses one allowlisted versioned envelope for admission/queue,
turn start/settlement, checkpoint, recovery, lease, permission and container
transitions. Settlement is emitted after usage acknowledgement and the durable
idle transition. Existing counters, annotations and head sampling remain; raw
provider errors, prompts, credentials and archive keys are excluded from events.

Backout must retain a Lifecycle-aware queue and close-intent reader. Disable new
idle scheduling and reconcile existing close intents before considering an older
binary; a pre-SDK binary cannot safely consume these persisted jobs. No production
rollout is implied by the isolated qualification fixture.

Qualification used three no-inference Cloudflare close/restore cycles. Observed
idle shutdown was 31.45–32.21 seconds; cold context ranged 6.16–7.39 seconds.
The [raw receipt](../../bench/lifecycle-idle-2026-11-12.json) records source/image,
proofs, cleanup and sample limits. These are empty-session public-network
measurements, not model latency or a p95 claim.
