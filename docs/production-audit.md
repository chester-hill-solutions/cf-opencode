# Production audit — cf-opencode harness

## Initial implementation assessment — 2026-11-11 (historical snapshot)

**Current status:** G0 is open. The findings below concern the assessed working tree,
including pre-existing local edits; no product fixes were made during the assessment.
They supersede any historical implication below that durability or the audit is fully closed.
Release work is tracked in [the roadmap](roadmap.md#r0--harness-complete-current-work),
with [regression acceptance checks](testing.md#required-regressions-before-g0).

| # | Priority / original status | Original finding and observed trigger | Source | Current status |
|---|---|---|---|---|
| 29 | High / **open at initial assessment** | Five successful checkpoints with changing workspace contents and unchanged state leave the active manifest referring to a deleted state object. Generated `/workspace-<ts>` and `/state-<ts>` names do not match cleanup's `-workspace-` / `-state-` expressions. `latestCheckpoint` also accepts a missing referenced state object. | [`checkpoint`, `pruneCheckpoints`, `latestCheckpoint`](../src/conversation.ts) | **Locally verified repaired.** Exact-name pruning paginates, retains newest five plus manifest/legacy active references, serializes publish/prune, and preflights declared restore parts. Both changed-workspace and changed-state regressions pass. |
| 30 | High / **open at initial assessment** | With a $0.10 budget, a temporary first-start failure queues the message. Its unspent $0.10 reservation remains counted as spend, so queue drain reports “daily budget reached” without retrying startup or running a model. | [`onMessage`, `drainQueue`, `settleTurn`](../src/conversation.ts), [`/usage/reserve`, `/usage/today`](../src/settings-do.ts) | **Original case locally verified repaired.** Waiting work holds no reservation; after readiness, queued work acquires once and dispatches once without self-blocking. |
| 31 | High / **open at initial assessment** | Two concurrent $0.10 reservations both return 200 under a $0.10 daily cap, producing $0.20 reserved. The caller's budget check is a separate request; reservation creation does not enforce available budget. This proves the reservation gate is not atomic, not that a real provider was charged. | [`budgetBlocked`, `onMessage`, `onSlackEvent`](../src/conversation.ts), [`/usage/reserve`](../src/settings-do.ts) | **Original case locally verified repaired.** Serialized admission grants one and denies the other; owned holds are idempotent and released only after acknowledged actual usage. F1/F2 accounting and reconciliation guarantees remain open; estimates do not cap provider cost. |
| 32 | High for untrusted repositories / **open** | Default `bun test` / `bun run typecheck` permissions execute repository code under the identity that owns readable provider state. A disposable local Bun test read a synthetic sibling-state marker. This is a reachable execution path; production-container credential extraction was not tested. | [`SAFE_COMMANDS`](../src/permissions.ts), [`DEFAULT_ALLOW`](../src/settings.ts), [`state ownership`](../entrypoint.sh), [`startOpencode`](../control-server.ts) | R0-12 records the trusted-only rollout limit and probe; R1-7 removes long-lived credentials from repository execution and enforces external credential injection/default-deny egress. Direct-path permission denials do not close this finding. |
| 33 | Medium / **open at initial assessment** | An authenticated POST containing `{` to `/api/conversations/<key>/messages` throws an uncaught JSON parsing exception rather than returning a controlled 400. Observed through the Worker entrypoint in workerd. | [`handleApi` JSON parsing](../src/index.ts) | **Locally verified repaired.** Malformed, null, array and invalid-field bodies return controlled 400 responses before mutation; valid clients and bodyless routes remain covered. |

### Evidence and limits

- macOS arm64, Bun 1.3.5, Node 25.9.0: 210 unit tests across 33 files and 59 Worker
  tests across 23 files passed; type checks, config checks and UI build passed.
- Four disposable workerd probes reproduced findings 29, 30, 31 and 33. Their assertions
  confirmed the defective behavior, not the desired behavior. They were removed; retaining
  desired-behavior regressions is R0-14, not completed work.
- One separate local repository-code probe read only a synthetic state marker for finding 32;
  no real credentials were inspected or extracted by that probe.
- Five settings checks passed in disposable Chrome with a synthetic API: edit/save, draft
  retention after save failure, reload with saved values/token, and no horizontal overflow
  at 1280 px and 390 px. No browser page errors were observed.
- `bun test --coverage tests` reported 95.44% lines for imported files. The main Worker,
  Conversation and Settings orchestration are absent from that unit coverage report;
  the number is not repository-wide coverage or proof of security.
- Application source counted 10,222 physical lines in 49 files (`src`, `web`,
  `control-server.ts`); excludes shared UI library, generated/dependency/vendor code.
  Existing test sources counted 5,040 physical lines in 57 files, including declarations.
- No fresh real-container run (Docker unavailable), deployed-runtime check, live Slack/OAuth
  verification or model task evaluation occurred. Coding effectiveness, real latency and
  provider cost remain **unmeasured** in this assessment.
- Product README/docs/ADRs were excluded from the assessment; an incidentally visible manifest
  description was excluded from judgment. Plan documents were read afterwards for this update.

## Local repair verification — 2026-11-11

The initial 269-test assessment above is retained as a historical snapshot. After the repairs,
the final local gate passed: 212 unit tests across 34 files, 100 Worker tests across 26 files,
`check:config`, `typecheck`, `build:ui` and `git diff --check`. Regressions include checkpoint
pagination and both one-part-unchanged retention directions ([checkpoint split](../test/checkpoint-split.test.ts)),
missing-part preflight and legacy restore ([checkpoint integrity](../test/checkpoint-integrity.test.ts)),
queued admission and concurrent/owned reservation behavior ([budget gate](../test/budget-gate.test.ts),
[reservation HTTP path](../test/budget-http-admission.test.ts), [reservation authority](../test/budget-reservations.test.ts)),
dispatch/alarm recovery ([concurrency](../test/concurrency.test.ts)), terminal usage acknowledgement,
missing current-turn cost and alarm recovery ([turn settlement](../test/turn-settlement.test.ts)),
and malformed JSON side effects ([HTTP JSON](../tests/http-json.test.ts), [Worker routes](../test/worker.test.ts)).

Finding 32 remains open: local synthetic evidence records that repository-controlled code can read
state under the shared identity. No real credentials were accessed. There was no deployment, fresh
container run, live Slack/OAuth/provider test or model task evaluation. F1 ordered/reset/day usage
accounting and F2 automated/manual reconciliation guarantees remain deferred; results are not
billing-grade and do not close G0/G1.

## F1 accounting follow-up — 2026-11-11

The latest local gate passes **327 tests**: 213 unit tests in 34 files and 114 Worker
tests in 27 files, plus configuration, typecheck, UI build and diff checks. The
[test evidence](testing.md#f1-accounting-verification--2026-11-11) records scope and limits.

Matching OpenCode 2.2.5 source revealed a further accounting error: its lifetime
`session.usage.updated` total already includes title/compaction costs, so adding
auxiliary spend again can double count it. The caller now replays individual durable
step/auxiliary events. Settings records each conversation/session/event identity
with an immutable UTC date, updates source and aggregate atomically, and prevents
stale reports from reducing totals. Central records survive local reset and session
replacement. Settlement requires acknowledged terminal usage; cleanup holds the
accounting queue until state deletion finishes.

Nonzero legacy aggregates lack provenance: ambiguous mixed writes are rejected,
and new admission stops before dispatch for affected conversations. They are
preserved pending verified conversion. Warm replay and pre-admission/cleanup drains
collect available late records, but cannot prove detached auxiliary work has stopped.
Independent review accepted this bounded contract. F1 core repairs are locally
verified; legacy conversion, auxiliary-task quiescence, F2 reconciliation, audit 32,
G0/G1 and live compatibility remain open. Nothing was deployed.

## F1 policy and cutover verification — 2026-11-11

The latest gate passes **351 tests**: 217 unit tests in 35 files and 134 Worker
tests in 29 files, plus config, all TypeScript configs, UI build and diff checks.
[Detailed verification](testing.md#f1-policy-and-cutover-verification--2026-11-11)
records a transient parallel-test timeout and the successful final sequential run.

Exact-version research found two lifecycle facts relevant to accounting: detached
compaction can run after execution goes idle, and an output-limit assistant step
can lead to more foreground compaction/model work. The runtime now disables the
detached producers through supported configuration, verifies process/effective-policy
evidence, and waits for durable execution completion before retiring a hold or
allowing cleanup. A policy failure cannot trigger transport-error recycling of
active work.

Authenticated preview/apply tooling preserves legacy recorded totals as explicitly
unreconciled opening balances and atomically installs a source-ordering receipt.
Holds and changed/unsafe evidence block conversion. Delayed old writers are rejected;
new sessions recover the receipt while inheriting no old-session sequence cutoff.
Interrupted reconstruction cannot publish partial completion proof. Independent
review accepted the final implementation and regressions.

The verified official 2.2.5 Darwin binary passed isolated config and title-agent
checks without credentials or model calls. Docker was unavailable. F1 implementation
is locally verified; actual cutover, Linux/deployed-container and model checks, F2,
audit 32 and G0/G1 remain open. No production conversion or deployment ran, and
historical provider bills are not reconstructed by the opening-balance workflow.

## F2 held-turn recovery verification — 2026-11-11

The latest gate passes **371 tests**: 222 unit tests in 36 files and 149 Worker
tests in 31 files, plus config, all TypeScript configs, UI build and diff checks.
[Verification](testing.md#f2-held-turn-recovery-verification--2026-11-11) records scope.

The recovery pass reproduced a missing fence: deleting a reservation allowed a
delayed acquisition of the same ID to recreate it. Settings now retires IDs
atomically with matching/absent release or guarded cancellation and rejects reuse.
Permanent retirement survives midnight, daily pruning and local reset; actual
usage and cutover metadata are preserved. Rollout/backout must preserve the fence.

The passive recovery API exposes local/central ownership and cached evidence without
starting a provider or changing accounting. Snapshot-bound cancellation is limited
to strictly never-dispatched proposals; retry schedules the existing recovery alarm
and cannot resend an ambiguous prompt or waive accounting/execution proof. Lost
acknowledgements, newer owners and crossing release/cancellation decisions have
regressions. Independent review accepted the implemented invariants.

Scoped F2 recovery is locally verified. Legacy/orphan/mismatched cases without proof,
external billing/stop-evidence import, actual staging/production recovery, Linux
container/model checks, audit 32 and G0/G1 remain open. No production action,
deployment or model call occurred in this pass.

## Historical production audit

The following records the earlier audit and fixes at that time. Historical line numbers,
architecture descriptions and fix strategies are not a current implementation inventory.
In particular, the current state checkpoint uses SQLite `.backup` while OpenCode continues
running, the configuration uses per-conversation `durable_object` containers, and rows 29–33
above record their status at the initial Nov 11 assessment. The later local verification section
records repairs without revalidating unrelated historical fixes.

**Audited commit:** `767ae34` (fixes follow in a separate commit).
**Surface:** `src/index.ts`, `src/conversation.ts`, `src/state.ts`, `src/settings-do.ts`,
`src/settings.ts`, `control-server.ts`, `entrypoint.sh`, `wrangler.jsonc`.
**Runtime:** Cloudflare Workers + Durable Objects (SQLite-backed) + one container per conversation;
Slack Events API and HTTP/SSE adapters.
**Clusters run:** 2 · Concurrency & transactions; 3 · Reliability; 4 · Data integrity & consistency;
5 · Scalability; 6 · Maintainability.
**Isolation level:** DO storage is single-writer per object with input gates; the audited risks are
interleavings across `await` on non-storage I/O (DO→DO fetch, container HTTP, R2).

## Findings

| # | Finding | Location | Class | Failure sequence | Fix | Evidence |
|---|---|---|---|---|---|---|
| 1 | **Restore deletes the config written moments earlier** — `/configure` runs before `/restore`, and restore `rm -rf`s the workspace | `src/conversation.ts:399-408`, `control-server.ts` `/restore` | Data integrity | Cold container → `ensureReady` → `/configure` writes `$XDG_CONFIG_HOME/opencode/opencode.json` under `/workspace/.state` → `/status` reports uninitialized → `/restore` deletes `/workspace` and extracts the checkpoint → `/start` launches OpenCode with no config (default model, no permission rules) | Restore first, then configure, then start | Code path; reproduced by reading the order (control server's `rmSync(WORKSPACE)` before `tar xzf`) |
| 2 | **Settings-version restart destroys a container mid-run** | `src/conversation.ts:393-395` (called from `withClient`, `:280`) | Concurrency | Run active → operator saves settings → pump calls `session.context` → `ensureReady` sees `settingsVersion` mismatch → `container.destroy()` → in-flight `context`/prompt fails → `pumpOnce` throws → alarm rejects without re-arming → turn lost | Only restart when `!pumping && !streaming`; defer the restart to the next prompt; serialize `ensureReady` | Interleaving: T1 pump awaits `session.context`; T2 settings save bumps version; T1's next `withClient` destroys the container |
| 3 | **Stale state object saved after long awaits (lost updates)** | `src/conversation.ts:314-322`, `388-412` | Concurrency | T1 `pumpOnce` reads state → awaits `session.context` (container) → T2 `onMessage`/`startRun` saves `lastReply=undefined` and a new pending permission → T1 resumes and `save(state)` with its stale copy → T2's fields are overwritten (reply skipped or permission lost) | Add `store.patch()` that re-reads and merges only owned fields; use it for `lastReply` and `settingsVersion` | Interleaving at the container await; state is a single JSON blob written wholesale |
| 4 | **Alarm failure stalls the pump with no retry** | `src/conversation.ts:339-343` | Concurrency / reliability | Container 502s during `pumpOnce` → `alarm()` rejects before `setAlarm` → no further polls; if the warm stream also dropped, the run never settles and no reply is posted | Catch, log, re-arm with backoff | Code path: `alarm` has no `try/catch` around `pumpOnce` |
| 5 | **Checkpoint tars a live workspace** | `control-server.ts` `/checkpoint`, `src/conversation.ts:424-431` | Data integrity | Agent settles → `/checkpoint` flushes the SQLite WAL, then `tar czf` walks `/workspace` while OpenCode's LSP/indexer or a background shell writes → the archive can contain a file from before and its SQLite sibling from after; restore yields a torn DB/file | Stop `opencode serve` before the tar (or checkpoint via `stow workspace checkpoint`), then restart | Code path: no pause between settle and tar; WAL flush is not a snapshot of the DB file |
| 6 | **Admission failure loses the message silently** | `src/index.ts:59-70` (`waitUntil`), `src/conversation.ts:88-104` | Data integrity | Worker acks Slack 200 and dispatches via `waitUntil` → container down / `prompt` throws → DO request rejects, nothing is posted, Slack will not retry (already 200) → user sees silence | Catch admission errors in the DO and post an error to the adapter; release the dedupe claim | Code path; Slack only retries non-2xx |
| 7 | **Permission consumed before the reply is recorded** | `src/conversation.ts:110-112` | Concurrency | `takePermission` deletes the pending entry → `permission.reply` fails (container restart) → the pending map no longer reflects reality; a later click only works because the button payload carries `sessionID` | `peekPermission` → reply → `clearPermission` on success | Code path: delete happens before the external call |
| 8 | **SSE replay silently truncates after 200 events** | `src/conversation.ts` `onEvents`, `src/state.ts:82-85` | Data integrity | Client disconnects with `Last-Event-ID: 5`; log holds 51–250; reconnect receives 51+ with no signal that 6–50 were dropped → UI state diverges | Emit a `reset` event when `lastID < oldestSeq − 1` | Code path: `eventsAfter` filters, no gap detection |
| 9 | **Silent model fallback** | `src/conversation.ts` `ensureSession` (`switchModel(...).catch(() => {})`) | Data integrity | Settings say model X; X is unavailable in the container; `switchModel` rejects and is swallowed → the session runs the provider default, and the UI still shows X | Log and surface the failure (SSE/Slack error), or fail the turn | Code path |
| 10 | **Clone failure ignored** | `control-server.ts` `/start` | Data integrity | Bad repo/branch → `git clone` exits non-zero → `run()` ignores the exit code → `opencode serve` starts in an empty workspace; every boot repeats | Check the exit code, return 500, and have the DO surface it | Code path: `run` awaits `exited` but returns nothing |

## Fixes applied in the follow-up commit

| Finding | Fix |
|---|---|
| 1 | `ensureReady` now restores the checkpoint **before** `/configure`, so the config survives the restore |
| 2 | Restart only when `!pumping && !streaming`; `ensureReady` is serialized through a single in-flight promise |
| 3 | `ConversationStore.patch()` re-reads and merges; `lastReply` and `settingsVersion` use it |
| 4 | `alarm()` catches pump failures and always re-arms (30 s while streaming, `pollSeconds` otherwise) |
| 5 | `/checkpoint` stops `opencode serve` before the tar and leaves it stopped; the next `/start` resumes it |
| 6 | Admission failures release the dedupe claim and post a Slack error; HTTP returns 500 with the reason |
| 7 | `peekPermission` → reply → `clearPermission`, so a failed reply stays retryable |
| 8 | SSE emits a `reset` frame when `Last-Event-ID` predates the retained log |
| 9 | A failed `switchModel` now fails the turn instead of silently using the default |
| 10 | `/start` checks the clone exit code (and `/restore` the tar exit code), returning 500 |
| 14 | Checkpoint retries three times with backoff; a failed checkpoint emits an `error` event |
| 15 | Two consecutive container failures recycle it; the next turn restores the checkpoint |
| 16 | Single-slot admission queue drained by the alarm with backoff |
| 17 | Slow SSE subscribers are closed past a 64 KB queue budget |
| 18 | Workspace fingerprint lets unchanged turns skip the R2 upload |
| 19 | Slack 429s honor `Retry-After` for two retries, then fall back to the at-least-once path |
| 20 | The UI no longer embeds a model catalogue; `/api/models` is the only source |
| 21 | `bun run check:config` compares the prod and test Wrangler configs in CI |
| 25 | Readiness is cached per instance; the handshake runs once per container |
| 26 | Context and permissions are fetched concurrently |
| 27 | Pending permissions are recorded in one batched write |
| 28 | Slack gets one reply per turn; SSE keeps the live stream |
| 22 | Persisted lifecycle phase with guarded transitions |
| 23 | Turn duration, container ready time, queue events and checkpoint bytes are logged |

Findings 5 and 10's control-server changes take effect when the container image is rebuilt; findings 1–9
ship in the Worker.

## Cluster 3 · Reliability & fault tolerance (second pass)

| # | Finding | Location | Failure sequence | Fix | Evidence |
|---|---|---|---|---|---|
| 11 | **No timeout on container HTTP calls** | `src/opencode.ts` `portFetch`, `src/conversation.ts` control calls | Container hangs → the DO awaits forever; the alarm never re-arms and the turn never settles | Default 60 s on API calls, 2 s health, 10 s configure/status, 60 s start/restore, 120 s checkpoint | Code path |
| 12 | **Crashed children never restarted** | `control-server.ts` `startOpencode` / `startStow` | `opencode serve` exits → the subprocess variable still exists → `/start` returns early → every call fails until the container itself restarts | Check `exitCode`, restart, and report real `running`/`s3` in `/status` | Code path |
| 13 | **Reply delivery was at-most-once** | `src/conversation.ts` `pumpOnce` | `lastReply` persisted before the Slack post → post fails → next poll considers it delivered → reply lost | Deliver, then persist (at-least-once; a partial failure can duplicate on SSE) | Code path |
| 14 | **Checkpoint failures are silent** | `src/conversation.ts` `checkpoint` | R2/tar failure is logged and swallowed → no retry or alert → the next cold start restores an older checkpoint | **Fixed:** 3 attempts with linear backoff; on failure the pump emits an `error` event ("this turn is not durable") | Code path + `tests/retry.test.ts` |
| 15 | **No health-based restart** | `src/conversation.ts` `doEnsureReady` | A container that is running but wedged answers `/status` and is reused; calls time out but nothing restarts it | **Fixed:** `withClient` counts consecutive failures; two in a row destroy the container so the next turn starts fresh and restores the checkpoint | Code path |

## Cluster 5 · Scalability & distributed systems (third pass)

| # | Finding | Location | Failure sequence | Fix | Evidence |
|---|---|---|---|---|---|
| 16 | **Container capacity is one and unhandled** | `wrangler.jsonc` (`max_instances: 1`), `src/conversation.ts` `port()` | Thread B messages while thread A's container is the single instance → `start()`/health poll fails → admission errors with no retry | **Fixed:** single-slot admission queue; alarm drains it with linear backoff (5 attempts), then posts a final error. HTTP returns 202 `queued`; Slack gets a "queued" notice | Code path + `test/concurrency.test.ts` |
| 17 | **SSE backpressure is unbounded** | `src/conversation.ts` `broadcast` | A slow subscriber is enqueued without checking `desiredSize`; a stalled client grows the DO's memory | **Fixed:** subscribers below −64 KB queued are closed and dropped; the client reconnects with `Last-Event-ID` | Code path + `tests/events.test.ts` |
| 18 | **A full-workspace checkpoint per turn is O(repo)** | `control-server.ts` `/checkpoint`, `src/conversation.ts` `checkpoint` | A 500 MB repo is tarred and uploaded to R2 after every settled turn, even when nothing changed | **Fixed:** the control server fingerprints the workspace (HEAD + porcelain); the DO sends `since`, an unchanged tree returns 204 and no upload happens. Changed trees still tar (Stow incremental is the next step) | Code path |
| 19 | **Slack 429 is not handled** | `src/conversation.ts` `slack()` | A rate-limited post throws; the at-least-once retry re-posts on the next poll and can storm | **Fixed:** 429s honor `Retry-After` (default 1 s, capped at 30 s) for two retries, then throw so the at-least-once path takes over | `src/backoff.ts` + `tests/backoff.test.ts` |

## Cluster 6 · Maintainability & evolution (third pass)

| # | Finding | Location | Failure sequence | Fix | Evidence |
|---|---|---|---|---|---|
| 20 | **Model catalogue duplicated** | `src/models.ts`, `public/index.html` `FALLBACK_MODELS` | A model added to one list and not the other drifts; the UI offers a model the API does not know (or misses one) | **Fixed:** the embedded catalogue is gone. `/api/models` is the only source; when it is unreachable the UI hides the select and keeps the free-text field visible | `public/index.html` `renderModels` |
| 21 | **Prod/test config drift** | `wrangler.jsonc` vs `wrangler.test.jsonc` | Different compatibility dates, containers only in prod, `CONTAINER_URL` only in tests; a new prod binding can be missing in tests and vice versa | **Fixed:** `bun run check:config` compares entrypoint, flags, DO classes/bindings, R2 bindings, exports, assets and vars; CI runs it before typecheck. Test-only bindings live in `vitest.config.ts` | `scripts/check-config.mjs` + CI |
| 22 | **Implicit conversation state machine** | `src/conversation.ts` | Lifecycle was inferred from `sessionID?`, `settingsVersion?`, `lastReply?`, `pumping`, `streaming`, `readying`, `consecutiveFailures`; "starting", "running" and "settling" were not named states | **Fixed:** persisted `phase` (`idle → admitting → running → settling → idle`, plus `queued`) with a transition table; invalid transitions are ignored. A stale `admitting` after a DO restart resets to idle on the next alarm | `src/state.ts` + `tests/state.test.ts` + `test/lifecycle.test.ts` |
| 23 | **Observability gaps** | whole Worker | No metrics or traces; only `console.warn`; no turn latency, queue depth, checkpoint bytes or failure classes | **Fixed:** one-line JSON events for admission, queue enqueue/drain/fail, turn settle with `durationMs`, container ready time, checkpoint saved with `bytes` and skipped/failed. OTel export remains a follow-up; Workers Logs can query these fields today | `src/log.ts` + call sites |
| 24 | **Mixed responsibilities** | `src/conversation.ts` (~500 lines) | Slack delivery, SSE fan-out, container lifecycle, pump and permissions live in one class | Reported (prompt 36): extract `ContainerRuntime` and `EventStream`; do not restructure in the audit | File size and imports |

## Cluster 1 · Performance & efficiency (fourth pass)

| # | Finding | Location | Failure sequence | Fix | Evidence |
|---|---|---|---|---|---|
| 25 | **Readiness handshake repeated on every container call** | `src/conversation.ts` `doEnsureReady` | `withClient` calls `ensureReady`, which always did `/status` → `/configure` → `/start` → `/health`; a poll that fetches context and permissions paid it twice, so ~6 control round trips per 2 s per conversation | Cache the verified port per instance; fast-path when the spec version matches and the container is running. Configure only on cold boot or a spec change | `test/performance.test.ts` asserts one handshake for two prompts |
| 26 | **Context and permission list fetched sequentially** | `src/conversation.ts` `pumpOnce` | Two independent container calls per poll, one after the other, doubling poll latency | Fetch both in one `Promise.all` window | Code path |
| 27 | **N+1 storage reads for pending permissions** | `src/conversation.ts` `pollPermissions` | For P pending requests: `store.get()` + `rememberPermission` (get+put) per request → 2P reads and P writes per poll | One state read, one batched `rememberPermissions` write, then deliver | `tests/state.test.ts` batch test |
| 28 | **Slack posted every interim assistant reply** | `src/conversation.ts` `pumpOnce`, `deliver` | The reply text changes on every poll while streaming; each change posted to Slack, so a 60 s turn could make ~30 `chat.postMessage` calls and trip rate limits | SSE streams every change; Slack receives one assistant message when the turn settles (`lastSlackReply`), with at-least-once retry on failure | Code path + `lastSlackReply` state |

## What was not checked

- Cluster 1 is now reported above (findings 25–28, all fixed). Cluster 6 prompt 37 (full state-machine
  pass) is deliberately deferred to its own session.
- Findings 2, 3 and 7 are cited interleavings. A workerd regression test now drives two concurrent
  deliveries of the same Slack event through the DO (`test/concurrency.test.ts`); the settings-restart and
  stale-pump interleavings still lack a live harness. Findings 16–23 are fixed and covered by tests. Finding 24 (mixed responsibilities) is folded into the R1
runtime split so the refactor happens once, alongside the container-policy migration.
- Light mode, 200% zoom, and Slack-specific rate limits are outside this pass.

## Verification notes

- DO storage input gates make single `get → sync → put` sequences atomic (so `seenBefore`, `setSession`,
  `nextSeq`, `appendEvent` are safe in isolation). The defects are **across** awaits on non-storage I/O,
  where a second event can run and write the same JSON blob.
- `opencode.db` exists in the container's state dir (verified locally), so the WAL flush targets a real
  file; the flaw is that flushing is not a snapshot.
