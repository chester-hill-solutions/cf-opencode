# R1-4a caller contract — inventory and frozen proposal

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
{ "text": "…", "user": "…", "idempotencyKey": "…" }

200 { "ok": true, "replayed": false,
      "turn": { "id": "turn_…", "state": "accepted" | "queued",
                "acceptedAt": "…", "queuePosition": 1, "sessionID": "ses_…" } }
200 { "ok": true, "replayed": true, "turn": { … identical body … } }
409 { "ok": false, "error": "idempotency_conflict", "turnID": "turn_…" }
```

- One persisted `turns/<turnID>` record per accepted request: request digest,
  state, timestamps, session/execution identity, applied configuration identity,
  accounting reference, last verified recovery point.
- `idempotencyKey` maps to a turn plus a content digest. Same key + same digest
  replays the original turn; same key + different digest is `409`.
- Expiry is explicit and returned (`"replayWindow": "24h"` on the turn). A replay
  of an expired key is a new turn, never a silent duplicate or a silent prompt.

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
        "recovery": { "checkpointKey": "…?" , "verifiedAt": "…?", "restored": false },
        "cancellation": { "requested": false, "observedStop": false, "settled": false } } }
```

`unknown` is a real state, not an error: ambiguous dispatch keeps a hold and must
report it. Credential values never appear; a missing fingerprint is `null`, never
a fabricated digest.

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
same pending-form outcomes. Unreadable pending state returns `503`, never `[]`.

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

1. Turn id format (`turn_` + UUID) and retention: 50 turns or 72 h per
   conversation, whichever ends last, with explicit expiry in the response.
2. Whether `queued` is surfaced as a separate state or `accepted` plus
   `queuePosition` (proposal: separate state, one queued follow-up only).
3. Source of the configuration fingerprint: settings version + selected image
   digest + applied flags, recorded at dispatch, `null` when unknown.
4. Questions: polling `GET /questions` only, or also an SSE `question` frame
   (proposal: both; the frame is the fast path, polling is the recovery path).
5. Whether `GET /api/conversations/:key` keeps returning raw state during the
   migration window (proposal: keep for operators, document as unstable).
6. Reuse of `recovery` GET vs folding its snapshot into turn status (proposal:
   turn status for callers, `recovery` stays operator-only).

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
| No credential value or internal state field in any response | snapshot assertions on the three new routes |

## 8. Not in this slice

Strict tenant/agent identity and scoped keys (R1-5/R1-6), Slack presentation,
operator reconciliation, public SDKs, and any change to admission or accounting
policy. R1-4d extraction still follows the contract.
