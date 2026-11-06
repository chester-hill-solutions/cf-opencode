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

## What was not checked

- Clusters 1 (performance), 3 (reliability beyond the alarm), 5 (scalability), 6 (maintainability).
- No live container or deployed concurrency harness: findings 2, 3 and 7 are cited interleavings, not
  reproduced races. Regression tests are added for the state-merge and permission paths; the DO-level
  interleavings still need a workerd harness.
- Light mode, 200% zoom, and Slack-specific rate limits are outside this pass.

## Verification notes

- DO storage input gates make single `get → sync → put` sequences atomic (so `seenBefore`, `setSession`,
  `nextSeq`, `appendEvent` are safe in isolation). The defects are **across** awaits on non-storage I/O,
  where a second event can run and write the same JSON blob.
- `opencode.db` exists in the container's state dir (verified locally), so the WAL flush targets a real
  file; the flaw is that flushing is not a snapshot.
