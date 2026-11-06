# Production audit — cf-opencode harness

**Audited commit:** `767ae34` (fixes follow in a separate commit).
**Surface:** `src/index.ts`, `src/conversation.ts`, `src/state.ts`, `src/settings-do.ts`,
`src/settings.ts`, `control-server.ts`, `entrypoint.sh`, `wrangler.jsonc`.
**Runtime:** Cloudflare Workers + Durable Objects (SQLite-backed) + one container per conversation;
Slack Events API and HTTP/SSE adapters.
**Clusters run:** 2 · Concurrency & transactions; 4 · Data integrity & consistency.
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
| 16 | **Container capacity is one and unhandled** | `wrangler.jsonc` (`max_instances: 1`), `src/conversation.ts` `port()` | Thread B messages while thread A's container is the single instance → `start()`/health poll fails after ~20 s → admission posts an error; nothing queues or retries | Reported: queue admission behind an alarm/backoff, or raise `max_instances` and pay for it | Code path |
| 17 | **SSE backpressure is unbounded** | `src/conversation.ts` `broadcast` | A slow subscriber is enqueued without checking `desiredSize`; a stalled client grows the DO's memory | Reported: drop subscribers whose `desiredSize` is below a threshold | Code path |
| 18 | **A full-workspace checkpoint per turn is O(repo)** | `control-server.ts` `/checkpoint`, `src/conversation.ts` `checkpoint` | A 500 MB repo (with `.git` and `.state`) is tarred and uploaded to R2 after every settled turn; settle latency and R2 spend scale with repo size | Reported: Stow incremental checkpoints, or exclude `.git`/checkpoint every N turns | Code path |
| 19 | **Slack 429 is not handled** | `src/conversation.ts` `slack()` | A rate-limited post throws; the at-least-once retry re-posts on the next poll and can storm | Reported: honor `Retry-After` with a bounded retry | Code path |

## Cluster 6 · Maintainability & evolution (third pass)

| # | Finding | Location | Failure sequence | Fix | Evidence |
|---|---|---|---|---|---|
| 20 | **Model catalogue duplicated** | `src/models.ts`, `public/index.html` `FALLBACK_MODELS` | A model added to one list and not the other drifts; the UI offers a model the API does not know (or misses one) | Reported: generate the fallback from the catalogue at build time, or drop the fallback | Two copies in the tree |
| 21 | **Prod/test config drift** | `wrangler.jsonc` vs `wrangler.test.jsonc` | Different compatibility dates, containers only in prod, `CONTAINER_URL` only in tests; a new prod binding can be missing in tests and vice versa | Reported: derive the test config from prod, or add a CI check comparing binding names | Diff of the two files |
| 22 | **Implicit conversation state machine** | `src/conversation.ts` | Lifecycle is inferred from `sessionID?`, `settingsVersion?`, `lastReply?`, `pumping`, `streaming`, `readying`, `consecutiveFailures`; "starting", "running" and "settling" are not named states | Reported: explicit state + guarded transitions (prompt 37, separate session) | Field list |
| 23 | **Observability gaps** | whole Worker | No metrics or traces; only `console.warn`; no turn latency, queue depth, checkpoint bytes or failure classes | Reported: counters/log fields and OTel export | Code path |
| 24 | **Mixed responsibilities** | `src/conversation.ts` (~500 lines) | Slack delivery, SSE fan-out, container lifecycle, pump and permissions live in one class | Reported (prompt 36): extract `ContainerRuntime` and `EventStream`; do not restructure in the audit | File size and imports |

## What was not checked

- Cluster 1 (performance). Clusters 5 and 6 are reported above; cluster 6 prompt 37 (full state-machine
  pass) is deliberately deferred to its own session.
- Findings 2, 3 and 7 are cited interleavings. A workerd regression test now drives two concurrent
  deliveries of the same Slack event through the DO (`test/concurrency.test.ts`); the settings-restart and
  stale-pump interleavings still lack a live harness. Findings 16–24 are reported, not fixed.
- Light mode, 200% zoom, and Slack-specific rate limits are outside this pass.

## Verification notes

- DO storage input gates make single `get → sync → put` sequences atomic (so `seenBefore`, `setSession`,
  `nextSeq`, `appendEvent` are safe in isolation). The defects are **across** awaits on non-storage I/O,
  where a second event can run and write the same JSON blob.
- `opencode.db` exists in the container's state dir (verified locally), so the WAL flush targets a real
  file; the flaw is that flushing is not a snapshot.
