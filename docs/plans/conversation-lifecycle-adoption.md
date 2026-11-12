# Conversation Lifecycle adoption

Status: execution in progress on the isolated lifecycle branch. Alarm/lease
integration and most extractions are verified. Sealed-idle recovery repair,
runtime-use exclusion, idle-close measurement and remaining telemetry are open.
Date: 2026-11-12. Baseline: `0c90963`. Owner: platform/runtime.

## Outcome

Adopt Cloudflare's Lifecycle scheduling and capability pattern while retaining
the containerized OpenCode harness. Make scheduled recovery composable, and
reduce `Conversation` to routing and composition without changing transport,
accounting, permission or storage authority.

Observable results:

- Independent recovery, admission, checkpoint, lease and heartbeat deadlines
  survive overlapping schedules, eviction, duplicate alarms and failed jobs.
- A possibly dispatched prompt is never submitted again by scheduler retries;
  unknown usage and owned holds remain visible until existing reconciliation
  rules permit resolution.
- Extracted modules own their state and have narrow tested interfaces.
- An eligible idle container closes after approximately 30 seconds and reopens
  with the same session/workspace from a verified encrypted checkpoint.
- A versioned telemetry envelope correlates jobs, turns and runtime generations
  through existing logs, counters and sampled traces.

## Current evidence

Execution snapshot (the detailed assignments and release gates remain below):

| Slice | State |
|---|---|
| LC-0 | SDK pin/SQLite compatibility and earlier native smoke verified. |
| LC-1a | Full alarm cutover verified locally and in CI/native smoke through `6d85109` (run 43295111182). |
| LC-1b | EventStream and durable lease renewal/release recovery wired; integrated local checks pass. Runtime-use/idle-close gating remains LC-3. |
| LC-2 | Checkpoints, runtime cache/ports, image/snapshot policy, readiness, usage, reservations, recovery actions, reconciliation, cutover, control plane and turn execution extracted. Scheduler, admission/queue and runtime-upgrade families extracted; coordinator reduced to about 1,900 lines. |
| LC-3 | Runtime-use gate, no-inference measurement tool and isolated qualification fixture prepared. Close/reopen policy and actual measurements pending. |
| LC-4 | Checkpoint, lease and permission outcome events wired/tested. Recovery actions wired; turn/admission/runtime categories pending. |
| LC-5 | Existing replay/dedupe guarantees and limits documented. Optional protocol extensions deferred. |

### Research baseline

Read `src/conversation.ts`, `src/state.ts`, `src/lifecycle.ts`,
`src/recovery.ts`, `src/leases.ts`, alarm/lease call sites and related tests.
The coordinator has 4,833 lines. Important seams in the inspected baseline:

| Source | Existing responsibility / consequence |
|---|---|
| `conversation.ts:374–518`, `1815–1836`, `3294–3317` | Admission, ambiguous-dispatch recovery, and atomic dispatched-marker plus alarm publication. Preserve this transaction before provider I/O. |
| `conversation.ts:833–1115`, `3495–4153` | Control credentials, images, leases, readiness, snapshots, ports and runtime upgrade. These share volatile runtime identity. |
| `conversation.ts:1880–2114`, `3365–3439` | Native event subscription, pumping, settlement and alarm recovery. Warm events are hints; accounting still replays authoritative durable evidence. |
| `conversation.ts:4330–4705` | R2 discovery, split manifests, encryption, verified reuse, capture/restore, retry and pruning. Preserve publication ordering and the serialized checkpoint tail. |
| `conversation.ts:677–811` | Reset/delete/recycle and unresolved-usage fences. Reset/delete currently use `storage.deleteAll()`. |
| `state.ts:164–497` | Serialized state mutations, one queued follow-up, reservations, dedupe, permissions and the retained 200-event replay log. |
| `lifecycle.ts`, `recovery.ts`, `leases.ts` | Reusable pure stale-action, authority/classification and lease policies. Do not duplicate these inside capabilities. |

There are **23 direct `setAlarm()` call sites**, all sharing one physical alarm.
SSE heartbeats separately use `setInterval` every 15 seconds. Container inactivity
and lease TTL are currently ten minutes. Lease refresh is initiated from polling.
The overwrite interaction is a source-derived risk, not a newly reproduced
incident. Existing recovery tests already cover ambiguous dispatch and duplicate
wakes; retain them as behavioral contracts.

HTTP replay and message dedupe already exist: `src/index.ts:467` forwards
`Last-Event-ID`; `onEvents()` replays retained entries and signals an expired
cursor; `onMessage()` accepts `idempotencyKey`. Do not rebuild these as part of
the scheduler change. Neither the bounded replay window nor current dedupe
constitutes a permanent operation-receipt guarantee.

## Internal design note: what to adopt

Default to the **published `agents@0.33.0`, importing `agents/lifecycle` only**,
subject to LC-0's compatibility proof. It was absent at the research baseline. Research
inspected its published package/types/source maps without changing dependencies.
The inspected [published package](https://registry.npmjs.org/agents/-/agents-0.33.0.tgz)
has integrity:
`sha512-P6z56NXpYRXHuC1qkMakZBGpZo5btD5478X2AiEplPsTb4DPkYnkMfPt6H3Pv6vRR5mVKIgbvFzpdu24x9wiAA==`.

The official [Lifecycle API](https://developers.cloudflare.com/agents/runtime/lifecycle/api-reference/)
supports composition on an existing `DurableObject`. Its
[job queue](https://developers.cloudflare.com/agents/runtime/lifecycle/job-queue/)
owns the SQLite `cf_agents_jobs` table and derives the physical alarm from due
work. Reuse this implementation rather than maintaining a copied scheduler.
Do not also adopt `Agent.queue()`, Scheduler, Tasks or durable fibers for the
same work. A local compatible subset is a fallback only if LC-0 reproduces a
specific incompatibility that a small public-API adapter cannot resolve.

The [official OpenCodeHarness](https://developers.cloudflare.com/agents/harnesses/opencode/)
embeds OpenCode in Workerd and stores its sessions in DO SQLite. Its idle close
can release an embedded host because its state is already durable there. Here,
the full server, process tools and native Workspace remain inside a Container;
container destruction requires our own checkpoint and quiescence proof. We
adopt scheduling/capability patterns, not that harness or its session storage.
SDK capability events are best-effort telemetry, not accounting evidence or
our durable public event log.

Keep unchanged in authority and behavior:

- Settings DO, tenancy resolution, caps/leases, budgets and reservations.
- Dispatch markers, execution/usage fences, recovery classifications and
  operator proposals, approvals and permanent reconciliation receipts.
- Native stow-s3 Workspace plus versioned encrypted R2 tar.gz archives, manifest
  verification and fail-closed keys. No format migration in this refactor.
- HTTP/SSE and Slack routes, bodies, statuses and existing permission/form flow.
- `buildPermissionRules()` hard denies and constant-time control/API auth.
  Capabilities receive explicit privileged ports, never a general bypass.

This scoped wake queue supersedes older plan language excluding a general
scheduler only for internal deadlines. It creates no parallel provider job
engine, extra prompt queue, multi-turn concurrency or alternate runtime.

## Lifecycle and job contracts

1. Keep `Conversation extends DurableObject<Env>`, its class/binding/name and
   durable state. Explicitly forward `fetch()` to `lifecycle.fetch()` with the
   old router moved to `onRequest()`/`routeRequest()`, and `alarm()` to
   `lifecycle.alarm()`. Do not rely on `Lifecycle.install()` replacing methods
   already present. Start Lifecycle explicitly for retained direct RPC methods.
   Preserve protected runtime test/staging seams until their callers move too.
2. Register capabilities before startup. `onStart()` performs local schema and
   identity setup only: it runs under an SDK input gate and must not activate
   dormant domain work. Before SDK rearming, translate an existing legacy
   physical alarm once to `legacy:bootstrap`, preserving its due time; a first
   alarm-only entry supplies the firing signal if `getAlarm()` is already null.
   With no legacy alarm, mark initialization complete without inventing a wake.
   The bootstrap reconstructs missing domain intents once, respecting sealing.
   New operations already publish their jobs atomically. Passive reads and SSE
   heartbeat-only alarms must never bootstrap a dormant hold. Named routing
   already uses `getByName`; prove alarm-only startup with the same identity.
3. Jobs contain schema version, reason and ownership fences such as session,
   reservation/date, runtime generation and activity/reset epoch. They do not
   contain prompt text, credentials, provider results or a second copy of state.
   Re-read current authority before side effects. Job payloads are hints.
4. Use stable namespaced job IDs and `singleflight`; never `exclusive`, which
   would suppress other deadlines. **SDK singleflight is not the side-effect
   lock:** a same-ID push clears its running marker while an older handler may
   still execute. Keep the existing admission/checkpoint/usage serialization
   and add owner-specific generation/epoch claims where needed. Same-ID
   scheduling must not postpone an earlier necessary wake. Queue jobs check
   the current `nextAttemptAt` before dispatch. A newer queue intent must not
   allow an older operation to publish, destroy or release newer state.
5. Preserve the **single SQLite transaction** containing dispatch marker,
   queued-item consumption when applicable, job insertion and alarm publication
   before a provider call. The
   [SQLite storage reference](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction)
   includes SQL and KV writes in `storage.transaction()`. LC-0 must verify this
   exact SDK combination and rollback, with queue schema initialized first.
   Failure of that proof blocks adoption: do not send on a two-phase fallback
   with ambiguous marker/wake commit. Queue singleflight is not an exactly-once
   provider guarantee.
6. Domain retry/backoff remains durable and explicit. Set SDK job attempts
   deliberately; do not stack its default retry loop over prompt dispatch or
   checkpoint retry policies. A retry observes dispatched evidence rather than
   re-sending a possibly accepted prompt. Capability `onJobError()` persists
   visible failure and returns a deliberate retry/blocked outcome. Host jobs
   have no equivalent terminal-error hook in the inspected SDK.
7. `onAlarm()` performs lightweight reconciliation after due jobs, not a second
   copy of the old pump. Use the bounded handoff protocol below for slow work;
   `trackAlarmWork` observes breaker failures but does not retain a queue row.
   One slow R2 upload or runtime request must not starve other deadlines.
8. Handle SDK memory-limit sealing explicitly: retain all domain state/holds,
   persist a blocked scheduler status and stop reconstructing sealed recovery
   loops until an explicit recovery action. Telemetry failure cannot release a
   hold or mark a job's domain work successful.

For work that cannot finish in a short job step:

- Under its existing owner lock, atomically record an operation claim plus a
  future backstop job before launching work. The claim contains reset epoch,
  operation identity, relevant session/reservation or runtime generation and
  status. Reuse existing dispatched/usage ownership where sufficient; new
  checkpoint/close claims are bounded domain records, not another job queue.
- Launch once, register the promise with `ctx.waitUntil` and
  `trackAlarmWork`, and return a future `rescheduleAt`. Never return completion
  merely because work was handed off. While the local operation is live, a
  repeated wake reschedules instead of starting a second copy.
- Completion reacquires the owner lock and compares the durable claim/epoch.
  Only the current owner may publish its result and cancel or advance its own
  backstop. Do not cancel a newer wake or publish an older checkpoint manifest.
- After eviction, reconstruct from domain evidence. An expired heartbeat is
  not permission to repeat an uncertain prompt, destroy or lease transition.
  Dispatched work resumes observation only; checkpoint takeover fences prior
  publication; uncertain runtime/lease actions require inspection. Application
  errors retain a blocked/retryable record. Reset invalidates old claims before
  clearing application data, so an old completion cannot resurrect it.

Proposed jobs; one table, separately owned intents:

Implementation simplification: the first four intents use one permanent
`conversation-jobs` SDK capability, with explicit domain handlers and narrow
scheduling ports. Extraction must retain that queue owner rather than migrate
pending jobs between capability IDs. The table's owners below describe domain
ownership; EventStream owns its own SDK capability and heartbeat job.

| Stable ID | Owner | Due / behavior |
|---|---|---|
| `turn:observe` | TurnWork capability | Current poll interval or warm-stream watchdog; observe/settle and apply existing stale rules; never submit a prompt. |
| `admission:retry` | TurnWork capability | Persisted queued `nextAttemptAt`; one existing follow-up slot and the same atomic dispatch fence. |
| `recovery:wake` | Recovery capability | Existing classified/manual recovery intent; reconcile evidence and resume observation, never infer unknown cost or auto-approve operator actions. |
| `checkpoint:retry` | Checkpoints capability | Existing 30-second delay, attempt limit and visible failure behavior. |
| `lease:renew` | ContainerRuntime capability | Renew the Settings-owned lease before TTL while runtime work needs it; release only after confirmed stop. |
| `runtime:idle-close` | ContainerRuntime capability | Proposed 30-second unused-runtime deadline, fenced by activity/generation and checkpoint success. |
| `sse:heartbeat` | EventStream capability | 15-second comments only while this instance has subscribers; cancel after disconnect or eviction with no live subscribers. |
| `legacy:bootstrap` | Conversation jobs adapter | One-time translation of an existing pre-SDK alarm; preserve its deadline and never treat subsequent heartbeat alarms as legacy work. No runtime format migration or periodic legacy pump. |

## Extraction boundaries

`src/lifecycle.ts` remains the pure timing policy; SDK integration belongs under
`src/conversation/` to avoid changing its meaning.

| Proposed module | Owns | Narrow dependencies |
|---|---|---|
| `lifecycle.ts` / `jobs.ts` | SDK wiring, typed wake intents, local rehydration and scheduler status | Store, jobs, clock, typed handler ports; no raw provider prompt API. |
| `runtime.ts` | Image variant, start/readiness, generation, leases, ports, snapshots and volatile caches | Settings lease port, authenticated control client, restore callback. Keep `runtime-upgrade.ts` validators and isolate orchestration. |
| `checkpoints.ts` | Capture, manifests, encryption, R2 verification, restore, retry/pruning and checkpoint serialization | Existing archive helpers, store, R2, narrow control archive port and runtime identity. |
| `turns.ts` | Admission lock, one queue slot, dispatch/pump/settle, stream watchdog | Store, runtime client, budget authority, usage service, delivery and checkpoint ports. No Slack parsing. |
| `usage.ts` / `reconciliation.ts` | Existing usage replay tail, source ledger and operator workflow | Existing policy/helpers, Settings authority, store and runtime proof ports. Extract to avoid leaving a thousand-line accounting core behind. |
| `recovery.ts` | Recovery inspection/actions, stale-action orchestration, durable blocked intent | Existing root classifier, runtime quiescence, store, usage and jobs. |
| `control-plane.ts` | Control-token custody, authenticated control access, permission/form operations | Existing constant-time auth and permission policy; selected client methods and store. |
| `event-stream.ts` | Subscribers, replay/live handoff, backpressure, heartbeats, native stream cancellation | Store event API, typed delivery and runtime stream port; durable public events stay separate from telemetry. |

Use concrete interfaces with explicit ownership. Do not pass the whole
Conversation, `any` contexts, shared mutable bags or dozens of forwarding
callbacks. Keep locks with the invariant they protect, not duplicated per module.
Transport adapters call the same TurnWork service after parsing. Root pure
helpers and Settings remain authoritative. Mechanical moves precede behavior
changes; the coordinator's final methods route or compose these owners.

## Idle-close policy and measurement

Count real runtime use, not passive `/state`, `/health` or public SSE keepalives.
Track active borrowed client operations and a durable activity/generation epoch.
Under the existing admission/lifecycle fence, require idle phase; no queued work,
pending permissions/forms, reservation/central hold, active execution, unfinished
usage/settlement, recovery/upgrade/onboarding work or checkpoint operation.
Authority unavailable means keep warm. Existing unknown holds never expire by
this timer.

Before destruction, stop the owned native event subscription so its `finally`
cannot re-arm a stale turn job, prove runtime quiescence, and capture/verify both
encrypted R2 parts. Recheck activity and fences after every await and immediately
before destroy. On failure/race retain the runtime and recovery point, record
why close was deferred, and preserve checkpoint retry work. After confirmed
destroy, release the lease and clear volatile ports/generation/stream caches.
Do not clear session, events, identity, manifests or accounting. Keep the current
platform inactivity timeout as a distinct safety net; reducing it to 30 seconds
alone would skip checkpointing and is not the implementation.

The close linearization point is a **runtime-owned exclusive-use gate**, not
only a final epoch read. Every client/control/onboarding operation borrows
the runtime through that gate. With admission/lifecycle exclusion held, closing
may claim the gate only at zero active borrows; otherwise defer. Mark it closing
before the final checks and hold that state through checkpoint, destroy and
lease/cache transition. New users wait for close to finish, then reopen; passive
state/SSE requests remain responsive. The close owner receives a narrow existing
runtime handle for proof/capture so it does not deadlock by borrowing itself.
Document/test lock order and release on all failures. A lease operation with an
unknown outcome blocks close until reconciled rather than racing a late renewal.

Lock order is admission, usage serialization, then runtime exclusivity. Stop
the owned idle native stream before taking the usage fence, so queued usage
replays drain without a teardown waiting on its own lock. Internal readiness,
checkpoint and control calls use an already-owned handle; they must not enter
the outer runtime gate again. Iterated durable logs remain under usage
serialization until consumption finishes. Readiness must not race a close
between preparation and the actual borrowed operation.

Lease requests use a separate serialized tail so a long runtime call cannot
starve renewal. Persist desired-held/release-pending state before I/O; retain
uncertain or rejected releases and retry with the same Settings identity.
Runtime close waits for that tail after confirmed stop. Renewal failure blocks
new dispatch before the acknowledged lease expires, while active financial
holds remain unchanged. TTL is not a guaranteed lock through a network outage.

Runtime-dependent requests reopen through existing restore/readiness/accounting
verification; passive inspection does not reopen it. Restore failure refuses
new prompt dispatch instead of silently replacing the session. A public SSE
subscriber alone may stay connected without holding a container, matching the
existing separation between SSE and runtime lifetime.

Extend `bench/container.sh` and `bench/measure.ts`, not a new benchmark framework.
Measure warm reuse versus post-close reopen, checkpoint time/bytes, destroy,
image-start, R2 restore/readiness and same-session availability. Record samples,
p50/p95 when sample size supports them, runtime/image/platform, emulation and
network conditions in `bench/RESULTS.md`. `/health` and SSE latency are not cold
runtime latency. `BENCH_TURN=0` avoids model calls but does not currently exercise
runtime reopening: add an isolated no-inference runtime probe. Model-inclusive
latency is a separate explicitly selected measurement. No 30-second benefit or
cold-start number is claimed yet.

## Structured events

Extend the existing `logEvent`, `withSpan`, `annotate`, `traceId` and advisory
Settings counters around one typed envelope: `schemaVersion`, `at`, `event`,
`component`, `conversationID`, optional session/reservation/job/runtime identity,
attempt, outcome, duration, trace ID and sanitized error code. Keep existing event
names where possible. Use the same transition vocabulary for admission,
turn/settle, checkpoint, recovery, lease, permission and runtime start/stop.
Identifiers belong in logs/traces, not unbounded metric labels. Never include
tokens, prompts, raw headers, private archive contents or SDK job payload dumps.

Keep Wrangler's head sampling and existing native tracing context. Bridge only
public SDK diagnostics APIs, once per isolate; do not use internal event-sink
imports or install a second tracing provider. Diagnostics and counters are
best-effort and cannot gate security or durable recovery. Test disabled tracing,
sampled traces, sink failures and field redaction.

## Delivery order and assignments

The fixed parent owns decisions/integration. Reuse two Luna contexts, serializing
all edits to `conversation.ts`; independently scoped module tests can run in
parallel. Models below are available in this session, not product model choices.

| ID | Owner / model | Scope and dependencies | Done when |
|---|---|---|---|
| LC-0 | Inventory owner, `gpt-6-luna` / medium | Minimal real Worker fixture, dependency pin/lock, SDK public-API adapter; first | Fetch/alarm forwarding, named alarm-only startup, SQL+KV+job+alarm rollback, same-ID outcome supersession, terminal error, simulated sealed-hook policy, same-object reset and real eviction proven; bundle/typecheck pass. Actual OOM handling remains an evidence limit. |
| LC-1a | Dispatch owner, `gpt-6-luna` / high | Typed wake adapter and existing alarm responsibilities; LC-0 | Cut over all 23 writers together to distinct turn, admission, checkpoint and recovery intents. SDK alone owns the alarm. Prove overlapping side-effect exclusion and bounded handoff/backstop on this real adapter, plus HTTP/Slack/queued marker transactions; no second toy engine in LC-0. |
| LC-1b | Inventory owner, `gpt-6-luna` / medium | Lease renewal and SSE heartbeat jobs; LC-1a | Remove competing timer ownership; overlapping deadlines survive, disconnect cancels heartbeat, eviction reconstructs only missing work, attempts/nextAttemptAt preserved, exhausted/sealed jobs retain visible recovery state. |
| LC-2a | Dispatch owner, `gpt-6-luna` / high | Runtime + checkpoint modules/tests; LC-1 | Mechanical extraction preserves runtime image/policy/auth and encrypted archive contracts, protected seams and all existing recovery tests. |
| LC-2b | Same dispatch owner, `gpt-6-luna` / high | Turns, usage/reconciliation and recovery; LC-2a | HTTP/Slack share the same admission service; no dispatcher or accounting store duplication; locks/tails remain with owners. |
| LC-2c | Same owner, `gpt-6-luna` / medium | Control plane + event-stream modules; LC-2b | Coordinator delegates cohesive operations; routes, permission denies, credential custody and replay/backpressure unchanged. |
| LC-3 | Inventory owner, `gpt-6-luna` / high | Idle policy, runtime close/reopen + bench extensions; LC-2 | Close races/failures/unknown holds fail safe; same-session encrypted cold restore and measurements pass. |
| LC-4 | Same inventory owner, `gpt-6-luna` / medium | Typed telemetry + adoption note; LC-3 | Required transitions share the envelope, redaction/sampling tests pass, internal note records implemented SDK version and remaining differences. |
| LC-5 optional | Dispatch owner, `gpt-6-luna` / medium | Replay handoff/idempotency documentation; after required slices | Race-free snapshot+watermark/live handoff regression; current dedupe limits documented. Permanent receipts and new public after/follow API need a separate bounded contract. |
| Acceptance | Parent + one `gpt-6.1-terra` / high review | SDK/DO transaction, failure and teardown invariants, not routine implementation | Consequential review findings addressed; integrated gates and scoped runtime evidence recorded. |

Each row is a reviewable commit or small series. Extraction ownership includes
its tests and evidence. A large-model review is reserved for the cross-cutting
SDK retry/teardown/transaction boundary; narrow fixes return to Luna. Escalate
only a reproduced unresolved question after two bounded attempts; stop review
after one review plus a focused recheck of fixes.

LC-0's concrete write scope is `package.json`/`bun.lock`, a test-only entry wrapper
and Lifecycle host under `test/fixtures/`, `test/lifecycle-jobs.test.ts`, and the
test binding/type configuration. The wrapper re-exports the production Worker
and adds the probe class only to the test configuration. Do not expose probe
routes or exports in the production entry point. LC-1 then owns
`src/conversation.ts`, `src/conversation/jobs.ts` and its affected regressions.

## Acceptance, verification and backout

Use Bun pure tests plus real SQLite Worker tests (`test/`, Vitest), not only
mocked storage. Extend existing admission/concurrency, budget dispatch-loss,
turn-settlement, recovery, leases, control-token, reset, runtime-upgrade and
encrypted/split/integrity checkpoint tests beside the changed seams.

Required new fault cases: competing deadlines in either order; same-ID update
and overlapping alarm while running, followed by old completion; eviction/failure
after job return but before detached completion; claim/marker commit then eviction;
rollback before dispatch;
duplicate alarms; failed renewal; missing/stale runtime; old stream cancellation;
checkpoint retries while admission waits; reset during a yielded job followed
by reuse with stale detached completion; new request during idle capture or
after final checks while destroy is unresolved; failed destroy/release; bad R2 part;
missing key; terminal job error; memory-limit sealing retaining holds. A held or
unknown dispatch must never produce a second prompt or lose its receipt.

Run focused tests per slice, then once on the integrated revision:

```sh
bun run check:config
bun run typecheck
bun run test
bun run test:workers
bun run build:ui
bash scripts/smoke-container.sh
git diff --check
```

Record native versus emulated smoke evidence separately. After implementation,
reuse isolated Cloudflare/R2 qualification for idle destroy/reopen with synthetic
data; retain all [storage qualification limits](stow-workspace-integration.md).
No live Slack messages, provider prompts, production deployment or retained-data
reset is part of this planning pass.

Preserve existing keys/manifests/accounting and add only SDK scheduling state and
small explicit lifecycle metadata. Pre-customer hard cuts permit dropping a
legacy scheduling adapter, not erasing operator data or unknown usage. Before
rollout, verify no unresolved in-flight work is reinterpreted. Rollback after
queue activation requires a bounded adapter/repair that derives the old wake
from preserved domain state; blindly reverting to code that ignores pending
jobs is unsafe. For reusable reset/delete, cancel owned work and clear
application-owned KV under an epoch fence while retaining SDK schema. Do not
leave an SDK instance with cached schema after `deleteAll()`, or permanently
disable alarms on an object expected to accept new work.

The first executable deliverable is LC-0, followed by LC-1a's complete alarm
ownership cutover, before broad module moves. The user authorized execution
after reviewing this proposal. Deployment and operator-data reset remain outside
the implementation batch.

Plan review resolved SDK same-ID singleflight limits, detached-work backstops,
atomic publication and the exclusive idle-close gate. Implementation must still
prove these contracts; the review is not runtime qualification.

## Execution record

- LC-0 started on `codex/conversation-lifecycle`: pinned `agents@0.33.0`, with a
  test-only Lifecycle host and SQLite transaction/failure proofs under development.
  Production routes and alarm ownership have not changed at this checkpoint.
- LC-0's first three real SQLite Worker tests passed: named startup/forwarding,
  rollback of KV marker plus SDK SQL row plus physical alarm, and committed
  marker/job wake. Evidence: `/tmp/cf-opencode-lc0-atomic-vitest.log`. This clears
  the direct-SDK transaction gate; remaining failure/handoff/reset cases are
  still being completed. LC-1a implementation has started against this gate.
- LC-0's focused suite reached eight passing tests for queue semantics, terminal
  failure and reset reuse. A sealed-memory hook is explicitly simulated, not a
  real platform OOM. Domain handoff/backstop and side-effect exclusion proofs
  move to LC-1a's real adapter rather than duplicate that implementation in a
  toy fixture; LC-1a remains blocked on those tests.
- LC-0 completed with nine real SQLite Worker tests, including actual eviction,
  and a passing typecheck before LC-1 edits began. The config drift guard now
  permits only the exact test wrapper/probe while checking all production
  bindings as before; four negative/positive boundary tests pass. A later
  overlapping typecheck saw incomplete LC-1 methods, so integrated checks must
  run after that owner hands off rather than treating its partial file as final.
- Verified LC-0 snapshot: `5b10612`. The production cutover is still uncommitted;
  the fixture and config-boundary changes are isolated on the verification branch.
- LC-0 native CI passed both application and container smoke jobs in
  [run 43268073478](https://github.com/chester-hill-solutions/cf-opencode/actions/runs/43268073478).
- LC-1b's independent EventStream capability passed five real Worker tests and
  source/Worker typechecks. Its direct local-stream regression found and fixed
  an existing buffer bug: the old default stream counted chunks against a
  byte-based threshold. An explicit byte-length strategy now closes an oversized
  slow stream and removes its heartbeat. Replay, comments, last-disconnect
  cleanup and actual orphan-job eviction remain covered. Coordinator wiring and
  lease renewal are still pending; this is not LC-1b completion.
- LC-1a review found and corrected lost detached-task retry wakes, conflicting
  stale-admission/queue intents, sealing without resumable recovery, expired live
  claim replacement and new metadata breaking fresh-image guards. A final
  classifier regression was reproduced for lost Settings release acknowledgements;
  the implementation now reuses the existing classification rather than impose
  a live-hold-only retry policy. Ten focused job/recovery fault tests pass.
- First integrated Worker gate: 260/279 passed. The nine old timing suites were
  adapted to explicitly drive typed deadlines without weakening assertions.
  A genuine cold-inspection race also surfaced: unconditional startup rehydration
  could activate a turn during passive recovery inspection. A narrow review
  selected the one-time alarm translation above; it replaces ad hoc route
  bypasses and is under implementation with dedicated startup regressions.
- Current independent gate: 351 Bun tests plus five runtime tests pass; config
  consistency and UI build pass. The two readiness-listener tests required the
  usual authorized listener access. Integrated Worker/type/native checks must
  be rerun after the startup-policy repair; LC-1 is not yet accepted.
- Startup policy now has five passing Worker tests: passive held-state reads,
  preservation of a future legacy deadline, one-shot alarm-only conversion,
  and both public fetch/alarm launch orders. An earlier fixture called both
  handlers concurrently inside one incoming test callback; that does not model
  native input gates, as Cloudflare's
  [same-event concurrency caveat](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)
  explains. Separate `stub.fetch()` and `runDurableObjectAlarm()` events preserve
  observation work and held usage evidence without submitting another prompt.
  This resolves the reproduced fixture concern; it is not proof of every
  platform scheduling interleaving. Integrated Worker verification is running.
- LC-1a integrated gate passed: all 285 Worker tests, full typecheck, config
  consistency and diff checks. The working tree also passed 355 Bun tests and
  five runtime tests (four Bun tests belong to the separate telemetry foundation).
  Earlier full runs exposed nondeterministic assumptions about automatic past
  alarm delivery and three five-second timeouts under concurrent test load;
  the final complete Worker run passed on its own without increasing timeouts.
  Protected policy/accounting/Settings source hashes match the baseline. Native
  image code is unchanged; final native smoke remains a release gate. Runtime,
  lease renewal, checkpoint extraction, idle close and telemetry wiring remain.
- Checkpoint extraction now delegates archive capture, retry, lookup, decryption
  and deletion to `ConversationCheckpoints`; the serialization tail moved with
  upload/publication/pruning and failure bookkeeping. Conversation shrank by
  390 lines. Fifty-three affected Worker tests and full typecheck passed; two
  direct real-SQLite/R2 tests additionally prove capture ordering and that a
  failed capture persists its retry before releasing the next writer.
- CI run 43280729799 passed typecheck/build/unit checks but failed one startup
  race fixture. The public test helper deletes an alarm and yields before
  invoking its handler; this can erase provenance before the passive fetch.
  Native dispatch has not yet been shown to permit that gap. Platform-scheduled
  delivery is being checked directly; native smoke was skipped by the failed
  prerequisite. Do not interpret the local pass as final release verification.
- The startup fixture now uses platform-scheduled alarms before/after a public
  passive fetch, with eviction and no helper deletion/invocation. All five
  startup tests pass, preserving the observation job, deadline and held usage.
  The helper-only race did not establish a production failure; no additional
  migration protocol was added. CI will rerun with the corrected fixture.
- Runtime port routing, snapshot-start fallback, readiness coalescing and
  private cache transitions now live in `ConversationRuntime`. Coordinator
  writes use explicit verification/pause/stop/image transitions, not public
  mutable cache fields. Sixty-two focused Worker tests and full typecheck pass.
  High-level restore/readiness, image policy and lease orchestration still need
  extraction/integration. Passive debug now distinguishes actual container
  running state from verified readiness for the no-inference benchmark.
- `ConversationUsage` now owns ledger validation, acknowledged log replay,
  cursor/terminal fences and the serialization tail shared with lifecycle and
  operator work. Coordinator integration removed 341 implementation lines;
  82 focused Worker tests and full typecheck passed. Budget admission and its
  dispatch-marker/job transaction remain at their existing owner boundary.
- Control-plane token custody and permission/form operations now have one
  module. Concurrent token creation is singleflight and transactional; real
  SQLite tests prove stable identity across concurrent calls and reloads.
  Existing public request types remain re-exported. Sixty-one focused Worker
  tests, 70 Bun tests and full typecheck passed; policy/auth sources are unchanged.
- Image/snapshot extraction removes a further 227 coordinator lines, retaining
  exact freshness checks and protected seams. Thirty-nine affected Worker tests
  and full typecheck passed. Lease foundation tests cover lost release ACKs,
  reload, malformed records and stale renewals; queue/start/stop wiring follows.
- [CI run 43286834935](https://github.com/chester-hill-solutions/cf-opencode/actions/runs/43286834935)
  passed both checks and native container smoke for `8661766`. The native startup
  test now waits for schema, durable job publication and physical rearm, including
  the documented null alarm while its handler runs. This supersedes the two
  earlier fixture failures; later uncommitted integration still needs its gate.
- Checkpoint telemetry now uses the allowlisted envelope for capture start and
  one terminal outcome after publication, plus retry/prune/missing diagnostics.
  Archive keys/raw errors are excluded; counters and trace sampling are retained.
  Four envelope tests and 16 checkpoint Worker tests pass. Remaining categories
  are not yet standardized.
- LC-1b now uses stable `lease:renew` on the same SDK capability/queue. Renewal
  survives eviction and adopts already-running pre-service containers without
  blocking observation of dispatched work on lease authority availability.
  Settings cap/TTL policy is unchanged. Destruction has one runtime owner;
  reset/delete/recycle retain state and retry intent if stop or release is not
  confirmed. Financial holds are untouched. Full typecheck, 369 Bun plus five
  runtime tests and all 299 working-tree Worker tests pass (including the
  prepared native-stream test). The final counter-preservation edit also passed
  eight focused lease tests. Native smoke must run again on the final rollout.
- Lease and permission outcome events now share the envelope. Permission
  resolution is emitted after upstream acknowledgement and local clearing;
  unknown/stale/failed attempts retain their original behavior. No request IDs,
  resource paths, tokens or raw errors enter those events.
- Budget reservations now have a narrow finance service. The three public RPC
  wrappers still initialize Lifecycle; proposal/ACK handling and the single
  dispatch-marker/queue/job transaction remain unchanged inside the owner.
  Forty-three focused Worker tests and full typecheck passed; 140 coordinator
  lines were removed. The service has no provider-prompt capability.
- Recovery inspection/retry/cancel and the shared manual-action exclusion now
  belong to `ConversationRecoveryActions`. Operator, checkpoint and upgrade
  work use its scoped action guard instead of a coordinator-owned mutable flag.
  Classification and receipts are unchanged; 50 focused Worker tests and full
  typecheck pass. Retry acknowledgement emits `recovery.scheduled`, not a claim
  that asynchronous recovery has already completed. A further 253 inline
  coordinator lines were removed.
- Native turn polling/settlement and stream ownership now live in
  `ConversationTurnExecution`. Physical stop synchronously fences the old
  stream, and explicit bounded draining is available for idle close. Tests cover
  pump singleflight, late-body cancellation, cancellation before destruction,
  and one stored assistant event plus one Slack post. Focused turn/lifecycle,
  checkpoint and stream/image suites and full typecheck pass. The coordinator
  lost 359 inline lines; runtime-use/idle policy still awaits integration.
- The internal note now documents exact HTTP idempotency and SSE cursor limits.
  A new snapshot/after/follow protocol and permanent message receipts remain
  optional deferred work, not guarantees implied by this refactor.
- Restore/readiness and provider credential synchronization now belong to
  `ConversationReadiness`, using existing image, checkpoint, runtime and lease
  owners. Settings-restart deferral, accounting/event proof and upgrade restore
  verification are preserved. Sixty-three affected Worker tests and full
  typecheck pass. Runtime-use exclusion is the next behavior integration, not
  implied by this mechanical move.
- Operator reconciliation and explicit accounting cutover now have separate
  owners with the same approval, unknown-cost, quiescence, snapshot and receipt
  checks. Routing still validates proposals before delegating. Seventy-two
  focused Worker tests and full typecheck pass; 674 inline coordinator lines
  were removed. Pure policy/Settings implementations remain unchanged.

- [CI run 43295111182](https://github.com/chester-hill-solutions/cf-opencode/actions/runs/43295111182)
  passed checks and native smoke through `6d85109`. Scheduler extraction then
  passed 66 focused Worker tests plus full typecheck.
- A real Worker regression reproduced an idle reset returning 500 when a
  memory-limit seal prevents lease-release job publication. The repair adds an
  explicit, snapshot-fenced sealed-idle operator retry and actionable cleanup
  blocking; it does not infer financial settlement or resubmit a prompt.

- Admission/queue and runtime upgrade wiring passed 53 focused Worker tests and
  full typecheck. The sealed-idle repair passes 15 Worker recovery tests,
  including rollback after injected queue failure and unchanged duplicate
  financial retries. Pure classifier tests cover maintenance intent, malformed
  evidence, active claims, unknown holds and snapshot changes. Durable log
  consumption now stays inside its client borrow; nine ledger tests pass.
