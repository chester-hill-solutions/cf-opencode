# Conversation lifecycle kernel

Status: LC-0 and Conversation alarm integration verified locally; remaining
module extraction, lease renewal, idle close and telemetry wiring are pending.
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

The HTTP EventStream capability owns process-local subscribers and its own
heartbeat job. Replay entries are appended by ConversationStore before broadcast;
heartbeat comments do not append events or acquire a container. On eviction,
subscribers disappear and startup removes their orphan heartbeat. Its byte-based
queue now enforces the intended slow-subscriber threshold; default count-based
stream buffering did not enforce that byte budget.

## Differences from official OpenCodeHarness

| Concern | This harness |
|---|---|
| Execution | Full OpenCode server in a Cloudflare Container, with process tools and native stow-s3 Workspace. No Workerd embedding. |
| Durable runtime state | Versioned, application-encrypted workspace/state R2 archives with verified manifests. OpenCode sessions remain in the container state archive, not the DO's session tables. |
| Scheduling | Selected Lifecycle jobs/capabilities only. No additional Agent queue, Tasks engine or duplicate provider dispatcher. |
| Authorization/accounting | Existing non-relaxable permission denies, constant-time control auth, tenancy, Settings, budgets, holds and operator receipts remain authoritative. |
| Public replay | Existing retained 200-event SSE log, cursor replay and reset; not a new SDK session.events()/session.log() protocol. |
| Submission dedupe | Existing idempotency keys and bounded dedupe/tombstones. This is not a permanent receipt or exactly-once provider guarantee. |
| Idle close | The current platform safety timeout is ten minutes. A checkpointed approximately 30-second close/reopen policy and its measurements remain pending. Embedded-host close timing is not evidence of container cold-start cost. |

The official [Lifecycle](https://developers.cloudflare.com/agents/runtime/lifecycle/)
and [OpenCodeHarness](https://developers.cloudflare.com/agents/harnesses/opencode/)
references explain the upstream patterns. Our runtime/recovery contracts above
remain specialized. SDK diagnostics are advisory; existing tracing, head sampling
and durable accounting evidence must retain their separate roles.
