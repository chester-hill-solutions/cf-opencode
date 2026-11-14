# Delivery and account-seed batch — 2026-11-14

Scope: R0-20, the current-policy status slice of R0-22, R0-3's low-budget
boundary regression, R0-15a's deployable rehearsal fixture, and R0-21 integration
verification. The existing roadmap remains the scheduling authority.

## Implemented behavior

- `queue` is the authoritative bounded FIFO (default 10; `QUEUE_LIMIT` 1–100).
  Legacy singleton input is normalized; subsequent writes persist only the array.
  Entries carry stable IDs, source, enqueue time and retry metadata. Appending
  does not replace the active head or acquire another hold.
- Dispatch atomically consumes only the matching head and marks its reservation
  dispatched. Tails survive transport ambiguity, retry limits and recreation.
  A failed startup removes only the exhausted head; capacity pressure does not
  burn its retry allowance. Admission replacement is refused while a head is
  being admitted.
- HTTP validates and forwards queue/steer/interrupt plus explicit replacement.
  Queue acceptance returns ID, position and depth; full queues return 429 without
  mutation. Both transports explicitly send normal SDK prompts with `queue`.
- Steering requires a running dispatched turn and uses its existing hold.
  Stop intent and follow-up changes commit before the SDK interrupt. A repeated
  same-turn stop intent cannot call the SDK again after acknowledgement loss or
  restart. Interrupt acknowledgement neither releases the hold nor confirms a
  physical stop. Follow-ups remain behind normal usage settlement.
- Slack supports `!steer`, `!stop`, `!stop <follow-up>` and queue/timeout status.
  Follow-ups retain the command's current reply target. Failed known startup
  clears admission ownership before enqueue, so the queue can drain.
- `/state` and `/debug` distinguish timeout observation, stop request/acknowledgement,
  unknown runtime stop, and accounting settlement. The threshold remains
  **observe-and-alert**, with no automatic interruption. The policy choice remains
  open. The daily budget is an admission gate, not an active-turn spending cap.
- A real SettingsDO regression admits a $0.10 hold under a $0.10 daily budget,
  records $5 of sourced usage, and rejects the next admission.

## Account-seed fixture

`account-seed.ts` and its separate Wrangler template expose only four fixed,
empty-body authenticated actions. The source/recipient names and commands are
fixed; the candidate image/profile are pinned. The fixture captures ordinary
onboarding account state, encrypts it under the workspace key, writes the global
legacy account-seed R2 object, then exercises ordinary fresh-recipient readiness.
It checks a synthetic state marker, absence of the source workspace sentinel,
distinct Stow identity, binary/controller hashes, and initialized reseed refusal.

Source freshness rejects a running runtime or an existing control token.
Recipient verification also durably claims its single attempt before startup.
A repeated or partial attempt cannot reuse an old marker and claim a new seed
consumption. Cleanup resets both fixed runtimes, removes the seed and requires an
empty temporary bucket. Use a fresh fixture Worker/DO namespace for another run.

This is **offline-qualified, not live-qualified**. The marker proves file
fidelity, not real provider authentication. Account archives include a consistent
SQLite backup; the fixture does not promise arbitrary source-history stripping.
Global account scope is not tenant isolation. Fresh-stopped rejection of a full
conversation archive remains covered by the existing native container smoke;
this fixture adds no claim to that case.

## Independent review

Three persistent `gpt-6-luna` medium agents handled bounded queue, status and
fixture work; the parent owned contracts and integration. Cross-owner read-only
review found and resolved two concrete issues:

1. Recipient reruns could falsely claim fresh seed consumption. Freshness and a
   durable one-attempt guard now refuse that path.
2. An idle follow-up could commit without a wake when scheduling failed. Queue
   insertion and wake scheduling now share one storage transaction. Both a pure
   test and a real DO-storage regression prove rollback/503/no external call.

Parent integration also corrected Slack startup phase recovery and forwarding of
its current reply target. No measured token or cost savings are claimed.

## Verification

- Full typecheck: source, Bun tests, Worker tests, UI, qualification fixture and
  evented runtime all pass.
- Configuration agreement and UI build pass.
- Full Bun gate: **441 passed**, plus **5 runtime tests passed**.
- Full credential-free local Worker/DO suite: **366 passed in 62 files**.
- Offline qualification: archive/freshness contracts pass; generated types and
  Wrangler dry-runs pass for both fixtures, using an all-zero account sentinel.
  No resources are created by preflight.
- Initial restricted-sandbox attempts could not bind local test HTTP servers.
  The same checks passed with loopback access. No Docker daemon, real provider
  inference, real Slack delivery, deployment, production reset or live seed run
  was used for these local results.

Native CI and deployed receipts must refer to the exact uploaded commit; this
local receipt does not substitute for either. G0/G1/G1-C/G2 remain open.

## Backout

Do not roll singleton-only code onto a multi-entry queue. Preserve/export or drain
pending entries first, and use a matching Worker revision and persisted state.
Never discard a dispatched hold to force queue progress. Ambiguous prompt/stop
outcomes require status/reconciliation rather than automatic resend. The rehearsal
uses only a fresh Worker/DO namespace and disposable bucket; production data and
account seeds are outside its scope.
