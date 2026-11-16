# R1-4a caller contract — inventory and frozen proposal

> **Not a planning authority.** The single canonical plan is [docs/roadmap.md](../roadmap.md). This document is the contract proposal awaiting sign-off; its seven decisions and acceptance matrix are folded into roadmap W3. The roadmap controls sequencing and gate status.

Status: inventory complete, contract proposed 2026-11-14. Awaiting API/product
sign-off before implementation. No code changed, no live resources touched.

Scope: the public HTTP surface another application uses to drive continuing work.
Slack presentation, operator reconciliation and R1-5/6 tenant identity are out of
scope except where they constrain the contract.

Authority: [roadmap](../roadmap.md) G1-C, [execution-service delivery](execution-service-delivery.md)
R1-4a. This note records what exists and proposes the smallest contract that
satisfies it; it does not authorize breaking changes by itself.

## 1. Method

Read-only inspection at `f7f23c7` plus the working tree: `src/index.ts` (public
Worker routes), `src/conversation.ts` (DO routes and admission), `src/conversation/requests.ts`,
`src/state.ts` (persisted shape, event log, idempotency), `control-plane.ts`
(forms), `event-stream.ts` (replay/reset), `admissions.ts`, `recovery-actions.ts`.

## 2. Current public surface

Authorized by one shared `API_TOKEN` bearer. `POST …/messages` additionally passes
a per-client rate limit. No tenant or agent scoping exists yet (R1-5/R1-6).

| Route | Method | Response (current) |
|---|---|---|
| `/api/health`, `/health` | GET | liveness only |
| `/api/usage` | GET | today's usage plus `budgetUSD` |
| `/api/metrics`, `/api/leases` | GET | operator telemetry and lease list |
| `/api/alerts` | GET/POST/DELETE | alert inspection/config; `/api/alerts/check` runs a check |
| `/api/models` | GET | static catalogue plus a recommendation |
| `/api/settings` | GET/PUT | global Settings DO projection |
| `/api/onboarding/*` | mixed | status, provider proxy, GitHub OAuth, reset |
| `/api/conversations` | GET | conversation registry |
| `/api/conversations/:key` | GET/DELETE | **raw `ConversationState`**; delete removes checkpoints and registry entry |
| `/api/conversations/:key/messages` | POST | `{ok:true,sessionID}` 200; `{ok:true,queued:true}` 202; `{ok:true,duplicate:true,sessionID}` 200; `{ok:false,error}` 4xx/5xx |
| `/api/conversations/:key/events` | GET (SSE) | replayable frames with ids; `reset` frame when the cursor is stale |
| `/api/conversations/:key/context` | GET | runtime history, may be unavailable |
| `/api/conversations/:key/permissions/:requestID` | POST | `{decision:"once"\|"always"\|"reject"}` |
| `/api/conversations/:key/recycle` | POST | stop and restart the runtime |
| `/api/conversations/:key/recovery` | GET/POST | passive snapshot; `retry` and `cancel_before_dispatch` with a SHA-256 `expectedSnapshotID` |
| `/api/conversations/:key/runtime/upgrade` | GET/POST | plan and apply with `expectedPlanID` |
| `/api/conversations/:key/accounting/cutover` | GET/POST | plan and apply with `expectedPlanID` |
| `/api/conversations/:key/accounting/reconciliation` | GET/POST | **operator-only** privileged capability |
| `/api/conversations/:key/debug/*` | mixed | internal inspection |

Observation: there is no `/status`, no questions route, no turn-scoped cancel and
no typed work reference anywhere in the surface.

## 3. What identifies work today

| Identifier | Where | Lifetime | Caller-visible? |
|---|---|---|---|
| `sessionID` | `ConversationState.sessionID` | conversation lifetime; survives restarts | yes, on an accepted message only |
| `turnBaseline` | last assistant message id before the prompt | until the next turn | no |
| `admissionID` / queue `id` | `ConversationState.admissionID`, `QueuedMessage.id` | one admission attempt | no |
| event sequence | `ConversationStore` event log | last 200 events, monotonic | yes (SSE `id`) |
| `idempotencyKey` | client-supplied; `msg:<key>` in the `seen` ring, then a 24 h tombstone | 200 keys or 24 h, whichever ends first | yes (client's own value) |

None of these identifies one accepted request across its whole life. `sessionID`
spans many turns; `turnBaseline` disappears at the next turn; the event cursor is
a watermark over mixed events; `idempotencyKey` is client-owned and expires.

## 4. Gaps against R1-4a

1. **No turn reference.** Accepted and queued responses carry none. A `202` cannot
   be polled, cancelled or correlated with output or usage.
2. **Retry does not return the original work.** A repeated idempotency key returns
   `{duplicate:true, sessionID:<current>}`, which resolves to whatever session is
   current now, not the turn that consumed the key (`src/conversation.ts:645-648`).
3. **Key reuse is not detected.** The ring stores `msg:<key>` without a content
   hash, so the same key with different text is silently treated as a duplicate
   instead of a conflict.
4. **Idempotency window is implicit.** 200 keys (`SEEN_LIMIT`) before the 24 h
   tombstone; an expired key on uncertain work becomes a fresh prompt. Nothing in
   the response tells the caller which case they hit.
5. **Raw state is the only status.** `GET /api/conversations/:key` returns
   `ConversationState` verbatim — internal field names, no accounting/cancel
   distinction, no recovery point, no projection stability.
6. **Questions are Slack-only.** `ConversationControlPlane.pendingForms` and
   `replyToForm` are reachable through the Slack adapter, not HTTP, so an HTTP
   call that hits a question stalls until the runtime times out.
7. **Cancellation is not turn-scoped.** Only `recycle`, destructive `reset`, and
   `recovery.cancel_before_dispatch` for strictly undispatched proposals.
8. **Accounting state is not addressable per turn.** `budgetReservation` lives in
   state; nothing reports reserved vs settled vs unknown for one turn.
9. **Events are not turn-correlated.** A reconnecting caller cannot attribute
   frames to the turn that produced them.
10. **Configuration identity is not recorded per turn.** `settingsVersion` exists;
    an applied image/runtime/configuration fingerprint does not.

## 5. Proposed minimal contract (v1)

Pre-customer, so this is a clean break with bundled callers updated together. No
compatibility adapter and no parallel queue — all of it runs on the existing
admission, event, usage and recovery machinery.

### 5.1 Submit

```jsonc
POST /api/conversations/:key/messages
{ "text": "…", "user": "…", "idempotencyKey": "…",
  "delivery": "queue" | "steer" | "interrupt",   // default: queue
  "replaceQueue": false }                        // interrupt only

200 { "ok": true, "replayed": false,
      "turn": { "id": "turn_…", "state": "accepted" | "queued",
                "acceptedAt": "…", "queuePosition": 1, "sessionID": "ses_…" } }
200 { "ok": true, "replayed": true, "turn": { … identical body … } }
409 { "ok": false, "error": "idempotency_conflict", "turnID": "turn_…" }
429 { "ok": false, "error": "queue_full", "depth": 10, "limit": 10 }
```

- One persisted `turns/<turnID>` record per accepted request: request digest,
  state, timestamps, session/execution identity, applied configuration identity,
  accounting reference, last verified recovery point.
- `idempotencyKey` maps to a turn plus a content digest. Same key + same digest
  replays the original turn; same key + different digest is `409`.
- Expiry is explicit and returned (`"replayWindow": "24h"` on the turn). A replay
  of an expired key is a new turn, never a silent duplicate or a silent prompt.
- Delivery modes share the envelope but not the identity. `steer` joins the
  active turn: the response carries that turn's `id` and `state: "running"`, and
  no new turn record is created — `409 no_active_turn` when nothing is running.
  `interrupt` with a follow-up creates a new turn after the stop; without a
  follow-up it reports the interrupted turn. `queue` is the only mode that
  creates a `queued` turn.
- The queued answer is `202` in this slice, not `200`: `202` is the accurate
  status for work that has not started, and the body carries `state: "queued"`.
  Every other field above is unchanged.
- The key window (24 h) and the turn window (50 turns or 72 h) are independent.
  Reusing an expired key starts a new turn; replaying a key whose turn was
  pruned is `410 turn_expired`, never a `500` and never a resurrected turn.

### 5.2 Status

```jsonc
GET /api/conversations/:key/turns/:turnID
200 { "turn": {
        "id": "turn_…", "state": "queued" | "accepted" | "dispatched" | "running" |
                             "completed" | "failed" | "cancelled" | "unknown",
        "acceptedAt": "…", "startedAt": "…?", "finishedAt": "…?",
        "sessionID": "ses_…?", "runtimeGeneration": "…?",
        "configuration": { "settingsVersion": 7, "fingerprint": "…" | null },
        "output": { "available": true, "replay": "retained" | "expired" | "none" },
        "accounting": { "reservedUSD": 0.1, "settledUSD": 0.0017,
                        "state": "held" | "settled" | "unknown" },
        "recovery": { "available": true, "fromTurnID": "turn_…" | null,
                      "verifiedAt": "…?", "ageSeconds": 120, "restored": false },
        "cancellation": { "requested": false, "observedStop": false, "settled": false } } }
```

`unknown` is a real state, not an error: ambiguous dispatch keeps a hold and must
report it. Credential values never appear; a missing fingerprint is `null`, never
a fabricated digest.

`output.replay` is bounded by the 200-event log, not by the turn record: a
retained turn can legitimately report `"expired"` after enough traffic. The
status read never claims more than the event log holds.

`410 turn_expired` is returned once the turn record is pruned; `404` is only for
an id that never existed.

**Implementation note (first slice).** Status serves identity, lifecycle,
configuration, accounting state and cancellation state. `output` and per-turn
USD amounts are omitted until §5.5 correlates events with `turnID`; `accounting`
reports `held` / `settled` / `unknown` only, never an invented figure. Steer and
interrupt still answer with the active turn reference added, and gain their own
turn records with the delivery-mode follow-up.

### 5.3 Interactions

```jsonc
GET  /api/conversations/:key/questions
200  { "questions": [ { "id": "…", "turnID": "turn_…", "kind": "question" | "permission",
                         "prompt": "…", "options": ["…"], "askedAt": "…" } ] }

POST /api/conversations/:key/questions/:id
{ "answer": "…" }                  // question
{ "decision": "once" | "always" | "reject" }  // permission
204 / 409 { "error": "stale" | "not_pending" | "foreign_turn" }
```

This generalizes the existing permission route; Slack's button flow renders the
same pending-form outcomes. The first answer wins and is attempted once — a
second answer, from HTTP or Slack, is `409 not_pending` and must not be retried
by the client. Unreadable pending state returns `503`, never `[]`; a question
whose turn was pruned is simply absent, not an error.

### 5.4 Cancellation

```jsonc
POST /api/conversations/:key/turns/:turnID/cancel
202 { "ok": true,
      "cancellation": { "requested": true, "queuedCleared": true,
                        "observedStop": false, "settled": false } }
409 { "error": "already_terminal" | "cannot_target" }
```

Cancel targets one turn. Clearing the queue compare-clears that entry only; a
delayed cancel cannot clear a newer follow-up. Accounting is never released by a
cancel acknowledgement.

### 5.5 Events

Replayable frames gain `turnID`. Retention stays 200 events with the existing
`reset` frame; `/turns/:turnID` is the current-state read after a reset. Reconnect
never resends a prompt.

## 6. Decisions to lock

The packet below is the sign-off target. Each row states what exists today, the
choice to lock and the recommendation. Delivery modes are the seventh decision
added by R0-20; the earlier "one queued follow-up" wording is superseded.

| # | Decision | Current behaviour | Recommendation |
|---|---|---|---|
| D1 | Turn identity and retention | No turn reference; `sessionID` spans turns, `turnBaseline` disappears at the next turn, `idempotencyKey` is client-owned and expires | `turn_<uuid>`; retain 50 turns or 72 h, whichever ends last; never prune a turn named by the queue, a hold, an interrupt intent or the active manifest; key and turn windows are independent (`410` on a pruned replay, new turn on an expired key) |
| D2 | Queued state | Durable FIFO queue, bound by `QUEUE_LIMIT` (default 10); `202 {ok:true,queued:true}`; full is `429 queue_full` | A distinct `queued` state with `queuePosition`; multiple entries within the bound; the bound is configuration, reported in `429 depth`/`limit`; `replaceQueue` is the only bypass; no budget hold while queued. Supersedes the one-follow-up proposal |
| D3 | Configuration fingerprint | `settingsVersion` exists; runtime identity is not recorded per turn | Settings version + selected image digest + applied flags, captured once at dispatch and immutable for the turn; a later upgrade or recycle shows as `runtimeGeneration`, never as a rewritten fingerprint; `null` when unknown |
| D4 | Questions transport | Slack-only pending forms; an HTTP caller stalls until timeout | Both: an SSE `question` frame is the fast path, `GET /questions` is the recovery path; first answer wins, later answers are `409 not_pending`; unreadable state is `503`, never `[]`; stale/foreign answers are rejected |
| D5 | Raw GET during migration | `GET /api/conversations/:key` returns raw `ConversationState`; `DELETE` on the same key removes checkpoints | Keep GET operator-facing and documented unstable; `/turns/:id` is the caller API; move `DELETE` to operator-only in the same change; remove the raw GET once no bundled caller reads it |
| D6 | Recovery visibility | `/recovery` is privileged and exposes snapshot IDs | Turn status carries `{available, fromTurnID, verifiedAt, ageSeconds, restored}` and never an R2 key or snapshot digest; `/recovery` stays operator-only |
| D7 | Delivery modes | `delivery: queue \| steer \| interrupt` and `replaceQueue` are implemented in R0-20 | Lock as implemented: queue is the default FIFO (no hold); steer joins the active turn and creates no turn (`409 no_active_turn` otherwise); interrupt with a follow-up creates a new turn, without one reports the interrupted turn; a replayed interrupt returns its original outcome, not `409 interrupt_pending`; ambiguous is `502` + `unknown`, never a duplicate; Slack and HTTP agree |

### Sign-off

- [ ] D1 turn identity and retention
- [ ] D2 queued state
- [ ] D3 configuration fingerprint
- [ ] D4 questions transport
- [ ] D5 raw GET migration
- [ ] D6 recovery visibility
- [ ] D7 delivery modes

Signed by: ____________________  Date: ____________

No implementation starts until all seven are locked. The §7 acceptance matrix is
the review target; the record is bounded status, not an exactly-once receipt.

### 6.1 Invariants the decisions rely on

1. **Pruning order.** Turn records, split archives and the event log prune under
   one ordering, and nothing named by the active manifest, a queue entry, an
   open hold, an interrupt intent or a pending question is ever deleted. This is
   the issue #2 class of bug; a status read must not be able to point at a part
   that pruning removed.
2. **Replay beats delivery state.** An idempotent replay returns the original
   request's status verbatim, including interrupt's `200`, `202` or `502`.
   `409 interrupt_pending` applies only to a different key targeting the same
   turn, so a retrying client can never turn success into a conflict.
3. **Status reads are cheap and bounded.** `GET /turns/:id` is rate-limited per
   client and returns an `ETag`; status is pull-only. The event stream is the
   only push channel, so a polling caller cannot pin the Durable Object.
4. **Every window is advertised.** Key (24 h), turn (50/72 h) and event (200)
   windows differ; each response names the one that applied through
   `replayWindow` and `output.replay`, rather than leaving the caller to infer it.
5. **Configuration is captured, not recomputed.** The fingerprint is written once
   at dispatch. Settings changes and runtime upgrades during a turn surface as
   `runtimeGeneration`; rewriting the fingerprint would misreport what ran.

## 7. Acceptance matrix

| Case | Evidence |
|---|---|
| Accepted turn keeps one reference through queue → run → terminal | new fixture over `POST messages` + `GET turns/:id` |
| Retry while queued/running/terminal and after DO restart returns the same turn | same fixture, restart the DO between calls |
| Same key, different content → 409 before any work | fixture asserts no dispatch, no hold |
| Expired key on ambiguous dispatch never re-prompts | fixture over the tombstone TTL boundary |
| Status distinguishes execution from accounting (`completed` + `held`) | fixture over an acknowledged/unknown settlement |
| Cancel before dispatch clears only that queue entry | existing `recovery` cancel regression extended |
| Cancel after dispatch reports requested vs observed stop vs settled | new fixture with a stub runtime |
| Question/permission answered over HTTP and rejected when stale/foreign | new fixture plus existing Slack regressions |
| Replay gap returns `reset`, then status answers from current state | existing `worker.test.ts` cursor tests extended |
| Queue full is `429` with `depth`/`limit` and creates no turn | fixture at `QUEUE_LIMIT` |
| Steer reports the active turn and creates no new turn; `409` when idle | fixture with a stub runtime |
| A replayed interrupt returns its original outcome for each of `200`/`202`/`502` | fixture over the three outcomes |
| Pruned turn is `410`; expired key is a new turn; neither is a `500` | fixture over the 50-turn and 72 h boundaries |
| No credential, R2 key, snapshot digest or internal state field in any response | snapshot assertions on the three new routes and turn status |

## 8. Not in this slice

Strict tenant/agent identity and scoped keys (R1-5/R1-6), Slack presentation,
operator reconciliation, public SDKs, and any change to admission or accounting
policy. R1-4d extraction still follows the contract.
