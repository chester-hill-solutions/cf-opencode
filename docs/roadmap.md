# Plan — Aboiteau execution service

**This is the single canonical plan.** Status and sequencing live here. Every other
document under `docs/` is evidence, design input, research or an operational
reference; none of them schedules work. If another document disagrees with this
one, this one wins. The reconciliation record in §8 says what each former plan
became.

Updated: 2026-11-14. Previous planning authorities folded in:
`docs/plans/execution-service-delivery.md`, `docs/plans/sandbox-lighter-plan.md`,
`docs/plans/stow-workspace-integration.md`, `docs/plans/r1-4a-caller-contract.md`,
`docs/plans/conversation-lifecycle-adoption.md` and this file's earlier revisions.

---

## 1. How this plan works

- **One authority.** This file owns goals, order, acceptance and gate status.
  Evidence documents may be linked and quoted; they cannot open or close a gate.
- **Evidence, not narrative.** A gate changes only when a recorded check with a
  command, artifact revision and result supports it. Test counts, plans, builds
  and local mocks do not close runtime or external-pilot gates.
- **Bounded change.** Prefer one supported path, hard cuts with named retained
  data, and no compatibility adapter without a concrete caller or retained-data
  requirement.
- **Update rule.** When a slice completes, update its row and the gate ledger in
  the same change. Keep exact operational receipts in the owning runbook/evidence
  file; keep this plan to status, order, acceptance and links.

## 2. Product and boundary

**Product.** **Aboiteau** — an operator-owned, durable coding-agent execution
service on Cloudflare. A team installs it in its own account, connects a
repository and provider, and drives continuing work through a public API or a
connector. **OpenCode** remains the execution runtime; the service owns
admission, persistence, accounting, recovery and upgrades. **Slack** is the first
connector, not the execution model.

**Topology (retained).**

```
client ──POST /api/conversations/:key/messages──► Worker ──► Conversation DO
                                                               ├─ SQLite state + Lifecycle wake jobs
                                                               ├─ container :4001 control server (root)
                                                               ├─ native Stow Workspace (:9000 loopback S3)
                                                               ├─ OpenCode :4000 (UID 1001, cwd /workspace)
                                                               ├─ R2 CHECKPOINTS (split workspace/state)
                                                               └─ SSE subscribers (+ Slack delivery)
```

### Runtime direction — retain the current stack

**Retained stack.** OpenCode in Cloudflare Containers; native Stow working storage;
R2 workspace/state recovery; `agents@0.33.0` Lifecycle wake intents; one active
turn plus one queued follow-up; per-conversation Durable Objects; one global
Settings DO until strict tenancy replaces it.

**First pilot topology.** One team per Cloudflare account. The tenant→agent
identity model and the G1 isolation requirements are preserved, but managed
shared hosting, billing and commercial signup are later work. Installing Slack is
never required to deploy or use the public execution API.

**Hard-cut policy (2026-11-12, retained).** Pre-customer hard cuts are allowed.
Implement one supported storage/runtime/API path and update bundled callers
together. Legacy copy jobs, dual writers, dual-run deployments and compatibility
adapters require a named retained-data or caller requirement. Name operator data
to retain or intentionally reset before a cutover. Current-format recovery,
isolation and truthful accounting remain required.

### Message delivery model

A message has one of three explicitly chosen delivery modes. The harness remains
the admission and accounting authority; OpenCode's inbox is used only to steer the
active execution.

| Mode | Default? | Semantics |
|---|---|---|
| `queue` | **yes** | Append to a durable FIFO; each entry becomes its own turn after the active turn settles. No budget hold while queued. |
| `steer` | no | Deliver into the **active** OpenCode execution (`session.prompt({delivery:"steer"})`). Same turn and hold; no new turn. Valid only while the turn is `running`. |
| `interrupt` | no | Interrupt the active execution, settle that turn normally, then run the follow-up as the next turn. Never releases the interrupted hold on acknowledgement. |

Rules:

- The queue is durable across restarts, ordered FIFO and bounded (default 10,
  configurable). A full queue returns a typed refusal and leaves existing entries
  intact; entries are never silently dropped.
- A queued entry gets an ID and a visible position. A duplicate idempotency key
  returns the same entry.
- Steering never creates a turn, hold or checkpoint; it is attributed to the
  active turn and cannot bypass settlement.
- If no turn is running, `steer` returns `no_active_turn` (Slack replies with
  guidance); it does not silently become a new turn.
- `interrupt` is explicit, never inferred. The interrupted turn keeps its hold
  until normal settlement; the follow-up is fenced behind that settlement. An
  ambiguous interrupt does not duplicate the follow-up or resend the prompt.
- HTTP: `delivery` on submit; turn-scoped cancellation can carry a follow-up.
  Existing queue entries are preserved by default; `replaceQueue` is explicit.
- Slack: normal messages queue; `!steer <text>` steers; `!stop` interrupts and
  clears the queue; `!stop <text>` interrupts and replaces the queue with the
  follow-up. `!status` shows queue depth and the head.
- Always pass OpenCode's `delivery` explicitly. Its default is `steer`; relying
  on it would silently inject work into a running turn.

### Naming

Product copy uses **Aboiteau**. Code identifiers stay `cf-opencode` until the
single R1-10/R1-11 cutover. No new `cf-opencode` string in user-facing copy. The
rename moves the Worker name, package, repo, URL, Slack app URLs and secrets
together; there is no dual run.

## 3. Standing invariants

These constrain every slice. Breaking one is a regression even if its own tests pass.

| # | Invariant |
|---|---|
| I1 | **One owned budget hold per active conversation.** Queued work holds nothing. A hold carries conversation + reservation ID + Settings originating date; release compares all three. |
| I2 | **Dispatch may have happened is recorded before the prompt.** An ambiguous outcome retains the hold; no automatic prompt resend; a confirmed stop does not zero prior spend. |
| I3 | **Unknown cost is `null`, never zero.** A permanent, visible marker survives restarts, day change, pruning and reset. No TTL reopens a closed unknown. |
| I4 | **Terminal usage is acknowledged before release.** `settleTurn` is never called while the usage queue is held. Actual, reserved and admitted amounts are reported separately; the $0.10 estimate is not a provider cap and accounting is not billing-grade. |
| I5 | **One active turn plus a durable, bounded FIFO queue.** The Lifecycle queue holds internal wake intents only — no provider job engine or parallel turn dispatch. Messages default to `queue`; `steer` belongs to the active turn; `interrupt` is explicit and settles before the follow-up. `singleflight` is not a side-effect lock. |
| I6 | **Recovery restores files and history, not process memory.** A checkpoint proves persisted bytes; it never implies resumed processes, replayed external effects or zero spend. |
| I7 | **Idempotency is bounded, not exactly-once.** 200 claims plus a 24 h tombstone are dedupe bookkeeping. A public turn record is bounded status, not a permanent receipt or a provider-success guarantee. |
| I8 | **Isolation claims require OS/network proof.** Permission-pattern strings are UX guardrails. No G1 or multi-tenant claim from glob rules, a single-tenant deployment or a local mock. |
| I9 | **One workspace authority.** No dual writable workspaces, no stow/Computer dual writers, no snapshot-as-primary-recovery. |
| I10 | **Connector parity does not duplicate the engine.** Slack and HTTP render the same admission, questions, permissions, cancellation and accounting outcomes. |
| I11 | **Slack image slice stays bounded.** One PNG/JPEG ≤5 MiB, DMs and engaged threads, immediate admission only, capability checked before reservation, never auto-switch the model. |
| I12 | **Operator reconciliation is separate and privileged.** Not available through Slack or ordinary connectors; evidence-digested, quiescence-proven and permanently recorded. |

## 4. Current state — 2026-11-14

### 4.1 What is verified

- W0 committed locally as `7626726` on base `39a42d5`: R0-17/R0-18 implemented and locally
  verified; 401 Bun tests + 5 runtime tests + 351 Worker/DO tests pass, with
  typecheck/config/UI/diff checks passing. R0-19 recovered synthetic credentials
  through both allowlisted paths in the current 0.4.0 local image. See the
  [W0 receipt](evidence/w0-correctness-2026-11-14.md) for commands, source/artifact
  hashes and limitations, including one intermittent recovery-test failure between
  passing full runs. This is **KNOWN_OPEN_G1** evidence. No deployment or
  native CI qualification is claimed for W0; its push is awaiting explicit
  destination approval after automatic approval review rejected the upload.

- Local gate at HEAD `3d71de1`: `bun run typecheck` (five tsconfig projects plus
  `runtime/opencode`), `bun run check:config`, `bun run build:ui`, `bun test tests`
  (400 pass / 0 fail, 54 files), `bun run --cwd runtime/opencode test` (5 pass),
  `bunx vitest run` (345 pass / 0 fail, 57 files). Counts drift; they are
  regression evidence, not quality evidence.
- Container control plane: local amd64 smoke at HEAD passed health, token gate,
  config denial injection, concurrent `/start`, OpenCode/Stow startup, pinned Stow
  0.4.0 digest, S3/file round-trip, proxy, workspace/state checkpoint and restore,
  symlink refusal, missing-registry fail-closed, account-seed isolation and
  preexisting-workspace refusal. It exited 1 only when the host lifecycle-race
  observer hit `spawnSync docker ETIMEDOUT` under arm64 emulation (environment,
  not an assertion).
- Latest verified base native CI pass: [run `43627788591`](https://github.com/chester-hill-solutions/cf-opencode/actions/runs/43627788591)
  at `39a42d5` passed `check` and `container-smoke`, including lifecycle
  serialization and fresh-container split restore. [Run `43626528341`](https://github.com/chester-hill-solutions/cf-opencode/actions/runs/43626528341)
  also passed at `3d71de1`; both receipts were previously missing from this plan.
  [Structured base receipt](evidence/native-ci-base-2026-11-14.json).
  SL-B originally closed at `7f33cd6` (run `43614603372`). **W0 `7626726`
  still needs its own native CI run** before that revision is smoke-qualified.
- Lifecycle scheduler, sealed recovery, idle close, split checkpoints, reservation
  accounting, operator reconciliation, Slack commands/questions/images/replay and
  the onboarding wizard have local or recorded live evidence in their evidence
  files (§8). None of that closes G0/G1/G1-C/G2.

### 4.2 Assessment findings and dispositions

A code-first evaluation on 2026-11-14 (no product docs used) found these. They are
now part of the plan rather than a separate report.

| ID | Finding | Evidence | Disposition |
|---|---|---|---|
| E1 | **The credential boundary is not enforced by the OS.** The agent UID owns `$HOME`/`XDG_*` at `/var/lib/aboiteau/state` (`entrypoint.sh:20-42`), and the allowlist grants `find *`. With OpenCode's own anchored matcher, `find / -name opencode.json -exec cat {} \;` evaluates **allow**, while a literal `cat /var/lib/.../opencode.json` evaluates **deny**. Repo-controlled code run via allowed `bun test` can read the same files. | `src/permissions.ts:71-115`; `@opencode/core/dist/util/wildcard.js`; `.../chunks/location-nw8h2gm9.js:100`; `Dockerfile:70-74`; `docs/design/r1-agent-boundary.md` §3.2–3.4 already records the residual | **R0-19 recorded** the [current-image synthetic exposure](evidence/r0-19-2026-11-14.json); **R1-7a/R1-7** own the fix. No G1 claim until the real-container proof passes. |
| E2 | **A Slack failure while announcing a question aborts the turn before settlement.** `pumpOnce` awaits `pollQuestions` before `finishTurn`; the Slack client throws on `ok:false`. Reproduced in a disposable DO test: `pumpOnce` rejected with `missing_scope`, phase stayed `running`, no `settled` event. Permanent Slack errors wedge the conversation with a retained hold. | `src/conversation/turn-execution.ts:241-246,387-416`; `src/conversation/slack-adapter.ts:331-345` | **R0-17 DONE locally**; [passing fault regressions and gate](evidence/w0-correctness-2026-11-14.md). Deployment still owed. |
| E3 | **HTTP is not at parity with Slack.** No turn-scoped cancel, no question/form route, forms polled only when `state.slack` is set, and output is a full-text snapshot per poll rather than token deltas. | `src/index.ts:432-531`; `turn-execution.ts:232,237-240`; `src/events.ts:8-13` | Already the target of **R1-4b/R1-4c**; make snapshot semantics explicit and keep deltas out of scope unless demand appears. |
| E4 | **Tenancy is implemented but inert.** D1 is not bound, there is no provisioning surface, provider sync is disabled for namespaced keys, and Settings/vault/budget remain global. | `src/tenancy.ts`; `wrangler.jsonc` (no `d1_databases`); `migrations/0001_tenancy.sql`; `src/conversation/readiness.ts:99`; `src/vault.ts:22-24` | **R1-5**: provision it (binding + admin/CLI + scoped settings/seeds/keys) or delete the dormant claim before G1. |
| E5 | **Dispatched-turn timeout escapes alerting; stale settlement state can persist.** The dispatched timeout path does not count/log `turn.timedout` although it is an alert counter; paused settlement re-polls indefinitely; `settlementError` is cleared only in the reservation branch. | `src/conversation.ts:1041-1046`; `src/alerts.ts:20-26`; `turn-execution.ts:257-272,321-331` | **R0-18 DONE locally**; [timeout/paused/success-path regressions](evidence/w0-correctness-2026-11-14.md). Deployment still owed. |
| E6 | **The local container smoke's observer timeout is an environment limit.** Native CI has passed the same gate. | §4.1; sandbox evidence note 2026-11-14 | No product ticket. Record the environment in evidence; do not claim a local full pass. |

<a id="current-gate-ledger"></a>
### 4.3 Current gate ledger

| Gate | Question | Status | Remaining evidence | Owner |
|---|---|---|---|---|
| **G0** | Do representative coding tasks complete and survive defined failures with correct admission/accounting and measured cost per accepted task? | **OPEN** | R0-1 staging rehearsal; R0-2 frozen task/fault matrix; R0-3 cost/latency baseline; R0-11 deployed container checks and legacy/manual ledger; R0-15 production storage cutover; R0-16 production replay rollout | platform + operator |
| **G1** | Do credential, egress and strict tenant boundaries hold, including resolver outages and repository-controlled probes? | **OPEN** | R1-3 deployed lifecycle proof; R1-5/6/8 strict identity, scoped keys, quotas; R1-7a/7/9 real-container egress and cross-tenant enforcement; [R0-19 confirms current exposure](evidence/r0-19-2026-11-14.json) | security + platform |
| **G1-C** | Can a non-Slack client use stable turns, questions, permissions, cancellation, reconnect and recovery solely through the public API? | **OPEN** | R1-4a sign-off and implementation; R1-4b neutral interactions; R1-4c reference-client conformance | API + connector |
| **G2** | Can five external teams install in their own accounts, integrate, repeat work, and upgrade/restore without builder intervention? | **NOT STARTED** | R2-2/3/4/6/7/8, then pilots | pilot owner |
| **G3** | Before broad R3 investment, do pilot workloads demonstrate a need for specific image, size, workspace or network changes? | **NO DEMAND EVIDENCE** | Recorded blocked workloads from pilots or controlled observations | product owner |

**Gate discipline.** A failed gate blocks expansion, not independent design,
fixtures or reference-client work. G0/G1/G1-C/G2 are never closed by a plan,
build, local mock or test suite.

### 4.4 Sandbox gate ledger

These are subordinate engineering gates for R0-3 and the efficiency work, not
product gates. They replace the former sandbox plan's A–E labels to avoid
colliding with G0–G3.

| Gate | Status | Evidence |
|---|---|---|
| **SL-A** Cold path and shape | **OPEN** | Cold/warm no-inference A/B recorded; turn latency, memory and cost evidence still owed. Targets: cold first-token p50 ≤3.5 s / p95 ≤5 s, warm ≤300 ms, no cold start within 5 min, no cost increase per active hour. |
| **SL-B** Image diet | **CLOSED** | 739 → 514 MB arm64 / 469 MB amd64; 600 MB CI guard; native CI `43614603372` at `7f33cd6`. |
| **SL-C** Computer workerd spike | **NOT STARTED** | Requires SL-A evidence and the SL-6.1 authority ADR first. |
| **SL-D** ContainerBackend | **NOT STARTED** | Only if SL-C passes; keep the current container path as fallback. |
| **SL-E** Production canary | **NOT STARTED** | Canary shape/image, rollback drill, unchanged accounting/permissions/Slack/SSE/recovery, measured cost per accepted task. |

## 5. Next steps — one ordered queue

Waves express priority and prerequisites, not a serial calendar. W0 starts now.
W1 and W2 may overlap where their dependencies allow. W4 efficiency evidence runs
alongside W1–W3 but closes no product gate. W5 waits for G1 + G1-C.

### 5.1 Queue

| Wave | ID | Work | Size | Depends | Done when |
|---|---|---|---|---|---|
| **W0** | **R0-17** | **DONE locally** — Slack question delivery must not block settlement | S | — | Failed question posts are caught, counted, retried with durable 5 s–5 min backoff; acknowledged cards are not repeated; terminal usage still settles. [Receipt](evidence/w0-correctness-2026-11-14.md) |
| **W0** | **R0-18** | **DONE locally** — Timeout and settlement observability | S | — | Both timeout paths count/log once; first paused episode alerts; successful settlement clears the error with or without a reservation. [Receipt](evidence/w0-correctness-2026-11-14.md) |
| **W0** | **R0-19** | **RECORDED** — Isolation probe harness (evidence, not a fix) | S | — | Both allowed commands recovered a synthetic state credential as UID 1001 in the current image; exit 2 / **KNOWN_OPEN_G1**. [Raw result](evidence/r0-19-2026-11-14.json); enforcement remains R1-7a/R1-7 |
| **W1** | **R0-1** | Reproducible Worker/image build, staging upgrade and backout | S | — | Workers Builds path re-run; staging upgrade + rollback receipt recorded |
| **W1** | **R0-2** | Frozen representative task/fault matrix | M | R0-1, R0-15 cutover | ≥10 predeclared coding tasks over ≥2 repos; accepted changes/checks/restart survival reported with all attempts in the denominator |
| **W1** | **R0-3** | Cost and latency baseline | M | R0-2 | Cold/warm p50/p95, checkpoint/restore, recovery, interventions, container/R2/model cost per accepted task; unknowns stay unknown |
| **W1** | **R0-11** | Deployed checks for R0-10/R0-11/R0-13 and the legacy/manual ledger | M | R0-15 | Audit 29/30/31/33 regressions pass in a deployed container; unprovable legacy cases named with their permanent marker |
| **W1** | **R0-15** | Storage production cutover and full recovery inventory | L | — | Stow 0.4.0 + current shape re-qualified; escaped/reserved keys, metadata, multipart, background writers and registry identity each preserved/rebuilt/refused; production cutover names retained/reset operator data; README/runbook updated |
| **W1** | **R0-16** | Public replay production rollout | S | — | `Last-Event-ID` forwarding and reset path live; snapshot-vs-delta semantics documented; no prompt resend on reconnect |
| **W1** | **R0-20** | Message delivery modes: durable FIFO queue, steer, interrupt-with-follow-up | L | R0-17, R0-18 | Default queue accepts multiple messages FIFO across restart; full queue refuses without loss; steer joins the active turn with no new hold; interrupt settles before the follow-up; ambiguous interrupt does not duplicate; Slack/HTTP parity; tests |
| **W2** | **R1-7a** | Disposable credential/egress feasibility proof | M | R0-19 | Synthetic provider/git credentials injected outside the sandbox; default-deny egress proven for provider HTTP/SSE, clone/fetch, packages; unsupported paths rejected; OpenCode self-approval residual recorded |
| **W2** | **R1-1/R1-2** | Stable checkpoint keys and deployed `durable_object` policy cutover | S+M | R0-10 | One supported checkpoint layout; legacy copy only with a named retained-data requirement; deployed policy and replacement cutover verified |
| **W2** | **R1-3** | Deployed per-conversation lifecycle and isolation inspection | M | R1-1, R1-2 | Runtime generation, active turn and last verified recovery point inspectable; per-conversation start/snapshot/inactivity/lease behavior verified in deployment |
| **W2** | **R1-5** | Strict tenancy and scoped configuration | L | R1-2 | D1 bound; tenant/agent/binding provisioning exists; absent/unknown/invalid/unavailable resolution fails closed with no legacy/global fallback; per-agent settings + account seed; or dormant tenancy is deleted before any claim |
| **W2** | **R1-6** | Per-tenant API keys | M | R1-5 | Hashed, revocable keys; shared `API_TOKEN` retired for tenant routes; revocation cannot steer new or existing work |
| **W2** | **R1-8** | Tenant quotas and concurrency caps | M | R1-5 | Container/minutes/storage limits named in rejection and status; no tenant can exhaust the account |
| **W2** | **R1-7** | Egress and credential enforcement | L | R1-7a, R1-3 | Credentials live only in the egress proxy; repository-controlled code cannot read them via files, child env, process state or clone args; direct credential-bearing fallback fails |
| **W2** | **R1-9** | Cross-tenant isolation matrix | M | R1-5, R1-6, R1-7 | Two tenants run concurrently; A cannot read B's state, events, settings, checkpoint, repo or questions/permissions/cancel/recovery; resolver outage probes pass |
| **W2** | **R1-10/R1-11** | Single cutover and rename | S+M | G1 + G1-C | One supported version; coupled clients updated; backout to a matching recovery point; Worker/package/repo/URL/Slack URLs/secrets renamed together |
| **W3** | **R1-4a** | Lock the caller-contract decisions (now seven), then implement turn identity/status | M | R1-3, R0-16 rollout, R0-20 | r1-4a §6 decisions signed off; one persisted turn record per accepted request; submit returns a turn or queue entry with position and delivery; same key+digest replays across restart; different digest → 409 before work; typed status separates execution/accounting and reports unknown |
| **W3** | **R1-4b** | Neutral questions, permissions, cancellation, steer and interrupt | M | R1-4a | `GET/POST /questions`, turn-scoped cancel with optional follow-up, `turnID` on replayable frames; stale/foreign answers rejected; unreadable pending state → 503; cancel/steer/interrupt report requested, observedStop and settled independently and never release accounting; snapshot semantics documented |
| **W3** | **R1-4c** | Reference CLI and non-Slack conformance | M | R1-4b | CLI uses only public HTTP/SSE, no Slack credentials, passes submit/follow-up/retry/question/permission/cancel/reconnect/restart/recovery cases against shared fixtures |
| **W3** | **R1-4d** | Re-scope protected extraction | S | R1-4c | Audit-24 extraction is either closed as consumed by the lifecycle refactor or limited to a demonstrated seam; no speculative backend interfaces |
| **W4** | **SL-1.2/1.5** | Turn, memory and cost evidence; 2 vs 3 GiB decision | M | — | Turn latency and RSS on a representative repo; cost per active hour; OOM alert; chosen default recorded |
| **W4** | **SL-1.4/SL-3.x/SL-4.x** | Prewarm, measured boot wins, restore path | M | SL-A | No-provider-spend prewarm with capacity respect; each boot/restore change kept only with before/after numbers; security tests unchanged |
| **W4** | **SL-6.1** | Workspace-authority ADR | S | — | One authoritative writer chosen with recovery story; no dual-writer integration before it |
| **W4** | **SL-7.x** | Runbook, canary and cost dashboard | M | SL-1.2 | Docs match code; canary + rollback proven; per-start/active-hour/turn cost visible |
| **W4** | **SL-5.x** | Bounded Computer spike | L | SL-A, SL-6.1 | Gate SL-C evidence: workerd host boots, bundle fits, file ops measured, no credential/token leak, gap report; then stop or continue to SL-D |
| **W5** | **R2-2/3/4** | Own-account bootstrap, install, minimal operator view | M slices | G1 + G1-C | Scoped key bootstrap; prerequisite diagnostics → repo/provider → verified task; active work/recovery/held usage/limits/revocation visible without source imports |
| **W5** | **R2-6/7/8** | Operating measurements, security review, install/upgrade guide | M | R1-8, R1-7 | Cost/intervention baseline; no critical security findings; versioned install/upgrade/rollback/export/restore runbook with pilot attempts |
| **W5** | **R2-1/R2-5** | Optional Slack OAuth install; tenant export/removal | M | R1-5, R1-6; demand-sequenced | Per-workspace install/uninstall if demanded; invite/remove/export/delete tenant with checkpoints; not a core onboarding prerequisite |
| **W5** | **G2 pilots** | Five external own-account teams | L | G1 + G1-C + R2 | Predeclared tasks, later-day repeat use, prescribed upgrade/restore, one independent non-Slack integration; every failure kept |
| **W6** | **G3 → R3** | Demand-led sandbox options | demand | G2 evidence or controlled observation | Each selected slice enables its named blocked workload or reduces a measured operating burden; no catalogue/editor before evidence |

### 5.2 Briefs for the immediate waves

**R0-17 — make question delivery non-fatal (P0).**
Scope: `pollQuestions` must not throw into `pumpOnce`. Catch Slack failures,
count them (`slack.form.failed`), keep the form unannounced so the next poll can
retry, and add bounded backoff so a permanent error does not hot-loop. Settlement
must continue even when the card cannot be posted. Tests: transient failure then
success posts once; permanent failure settles with a visible error event and an
operator-visible metric; no duplicate card. Do not mark a form announced before a
successful post. Evidence: focused vitest file plus the integrated gate.

**R0-18 — observability and state hygiene (P1).**
Scope: count and log `turn.timedout` on the dispatched path before pausing
settlement; emit an alert when `settlementError` is set or a hold has been paused
past a named threshold; clear `settlementError` on every successful settlement,
including turns without a reservation. Tests: reserved timeout, reservation-less
timeout, pause→success clear, alert threshold. Do not change settlement policy or
release a hold early.

**R0-19 — isolation probe harness (P1, evidence only).**
Scope: add a documented probe that (a) runs the allowlisted `find` form against a
synthetic credential file, (b) writes and runs repo-controlled code that reads it,
and (c) records the result. It must be clearly marked as a **known-open G1
finding**, not a passing security test. Keep it out of the normal "all green"
claim. Evidence: probe output committed with the revision and referenced from
R1-7a. Do not add new deny patterns and call the hole fixed.

**R0-20 — delivery modes (P1).**
Keep the harness as the admission/accounting authority; use OpenCode's inbox only
for steering. State: replace the single `queued` slot with a durable bounded FIFO
`queue` (default 10, configurable), migrate the old entry, and give each item an
ID, enqueue time, source, attempts and next-attempt time. No hold while queued.
Submit accepts `delivery: "queue" | "steer" | "interrupt"` (default `queue`).
Queue: append in order, return position, refuse a full queue with a typed error
without dropping anything. Steer: only while `running`; call
`session.prompt({sessionID, text, delivery:"steer"})` explicitly, create no turn or
hold, emit a steer event; if idle/settling return `no_active_turn` (Slack
guidance). Interrupt: call `session.interrupt({resume:false})`, keep the
interrupted hold until normal settlement, fence the follow-up behind settlement,
and never duplicate on ambiguity. Slack: normal messages queue; `!steer <text>`;
`!stop` interrupts and clears; `!stop <text>` replaces the queue with the
follow-up; `!status` shows depth and head. HTTP preserves existing entries by
default and takes an explicit `replaceQueue` when desired. Always pass OpenCode's
`delivery`; its default is `steer`. Tests: FIFO across restart, full-queue
refusal, steer attribution/no hold, steer-when-idle refusal, interrupt ordering,
ambiguous interrupt no duplicate, Slack/HTTP parity. Do not parallel-dispatch
turns or move accounting into the inbox.

**R1-7a — prove the boundary before scheduling the fix.**
Use the current image and disposable synthetic credentials. Verify injection from
a trusted service, default-deny egress, clone/fetch, package traffic and failure
behavior. Record unsupported protocols explicitly. Repository-controlled code
must attempt reads through files, child environments, `/proc`, clone args and
accessible internal APIs. Separately record OpenCode's API self-approval residual.
A proxy failure must stop work, not fall back to direct credentials. No production
change and no spend.

**R1-5 — decide the tenancy shape.**
Either provision what exists (add the D1 binding, a bounded admin/CLI surface for
tenants/agents/bindings, per-agent settings and account seeds, and a strict mode
that never falls back on resolver error) or remove the dormant tenant code before
any isolation claim. Do not leave `tenant:` keys reachable while Settings, the
vault and budget stay global. Acceptance includes absent/unknown/invalid/unavailable
resolution, a resolver outage, and the cross-tenant matrix in R1-9.

**R1-4a — sign off the seven decisions before coding.**
The frozen proposal is `docs/plans/r1-4a-caller-contract.md` §6: turn ID format and
retention (50 turns or 72 h, whichever ends last), queued as a separate state,
configuration fingerprint = settings version + image digest + applied flags
(`null` when unknown), questions via both SSE and polling, keep raw GET for
operators as unstable, recovery inspection in turn status while the operator
`/recovery` route stays privileged, and **delivery modes** (default FIFO queue,
explicit steer, explicit interrupt with follow-up). The §7 acceptance matrix is the
review target. The record is bounded status, not an exactly-once receipt.

**R0-15 — one storage cutover, on the current artifacts.**
Re-state provenance: all earlier C1/C2 evidence used Stow 0.3.7 and `standard-1`;
the current image pins Stow 0.4.0 and the custom shape. Re-run the split
checkpoint/restore and Cloudflare/R2 cold recovery on the current pair. Complete
the recovery inventory: natural and escaped/reserved keys, object metadata,
unfinished multipart, background-writer consistency, registry identity. For each,
preserve, rebuild or refuse before mutation. Name retained/reset operator data in
the cutover receipt. Update README and runbook in the same change.

**W4 — efficiency stays evidence-led.**
Keep the 1 vCPU / 2 GiB / 8 GB shape and 300 s idle window until SL-1.2/1.5
evidence says otherwise. Do not re-open the 30 s default; R3-6 is per-tenant
configurability, not the product default. Treat the Computer spike as a bounded
experiment behind SL-A and SL-6.1, with the current container path retained as
fallback. No WASM/AgentOS rewrite, no stow POSIX shim, no snapshot-first recovery.

### 5.3 Start here — this week (no paid resources)

1. **R0-17 — DONE locally**: reproduced both Slack post failures, fixed delivery
   isolation/backoff and passed the integrated gate. [Receipt](evidence/w0-correctness-2026-11-14.md).
2. **R0-18 — DONE locally**: both timeout paths, immediate paused-episode alerts
   and reservation-less success clearing are covered by passing regressions.
3. **R0-19 — RECORDED**: the synthetic current-image probe and raw result are
   committed with `7626726` as **KNOWN_OPEN_G1** evidence. Enforcement remains open.
4. **CI — NEXT**: run native `check` + `container-smoke` for the revision that
   includes W0 (`7626726`) once its branch push is approved, and record the run
   id here. Base `39a42d5` is qualified by `43627788591`.
5. **R0-15 — PREFLIGHT RECORDED**: the 0.4.0/custom-shape candidate pair and
   recovery matrix are [frozen](evidence/storage-preflight-2026-11-14.md).
   Confirm remote digest availability, update the historical harness pins and
   record the live-run spend ceiling before re-qualification. R0-15 remains open;
   the 0.3.7/`standard-1` receipts remain historical.
6. **R1-4a**: circulate the seven decisions (including the delivery model) for
   API/product sign-off. No code until they are locked.

## 6. Gate definitions and exit criteria

### G0 — dependable task completion

- A Slack mention produces a real reply; the same turn works over HTTP/SSE.
- A frozen set of ≥10 representative coding tasks meets observable outcomes (files
  changed as requested, relevant checks pass, changes survive restart). Report
  successes/total, runtime/model versions, cold/warm conditions, latency, provider
  cost and every intervention. `READY` is connectivity only.
- Cold start, checkpoint, restore and recovery numbers exist in `bench/RESULTS.md`
  with raw commands and conditions.
- R0-15 proves files and S3 use the same registered Workspace, with readiness
  reported and no supported data lost after R2-only cold recovery.
- Accounting holds cannot self-block; reservations do not exceed the admission
  budget concurrently; actual turn cost is measured and the remaining exposure is
  documented.
- The explicit trusted-operator/trusted-repository limit remains until R1-7.

### G1 — safe execution boundary

- Two tenants run concurrently in separate containers; A cannot read B's state,
  events, settings, checkpoint, repo, account seed, questions, permissions,
  cancellation or recovery.
- No global Settings singleton in the request path; a spec change restarts only
  that sandbox.
- A sandbox cannot reach a host outside its allowlist; no provider or git token is
  readable inside it. Repository-controlled test/typecheck code must fail to
  recover synthetic credentials through files, child env, process inspection,
  clone args or internal APIs. Verify with OS/network enforcement, not strings.
- Strict resolution handles absent, unknown, invalid and unavailable identities
  explicitly; resolver outages never start legacy work or select global settings.
- Tenant scope holds through HTTP, SSE, permissions, questions, cancellation,
  recovery and checkpoints; revoked credentials cannot steer new or existing work.
- The OpenCode API self-approval residual is documented and excluded from claims
  about a secure approval boundary.

### G1-C — public caller contract

- A persistent turn reference identifies accepted/queued work, idempotent retries
  and terminal outcomes across DO restart. One active turn plus a bounded FIFO
  queue; submit supports `queue`, `steer` and `interrupt`; steer is refused when
  no turn is running; interrupt reports requested/observedStop/settled and keeps
  the follow-up.
- Public status reports execution state, cancellation progress, accounting state,
  runtime generation and last verified recovery point without raw DO state or
  secrets. `unknown` is a first-class state with a retained hold.
- A non-Slack CLI submits/follows up, answers a question, approves/rejects a
  permission, cancels, reconnects output and inspects recovery using only public
  HTTP/SSE.
- Shared conformance covers retries, queueing, expired replay, restart, ambiguous
  dispatch, cross-tenant requests and cancellation. No duplicated lifecycle or
  accounting engine.
- Applied configuration identity is recorded per turn (credential-free), with
  `null` rather than a fabricated digest.

### G2 — own-account operation

- Five external teams install in their own accounts and complete a predeclared
  coding task without builder intervention; every attempt and help request is
  reported. Setup and ready-prerequisites → verified-task times are recorded
  against targets frozen before recruitment.
- Each team repeats useful work on a later day and completes the prescribed
  upgrade plus rollback/restore rehearsal without builder intervention, preserving
  history and accounting evidence.
- At least one independent developer integrates a non-Slack application using
  public contracts and examples, without server-source imports or a bespoke
  backend patch.
- An operator sees actual/reserved/unknown usage and named limits, inspects
  recovery and revokes access unaided. Security review is signed off with no
  critical findings.

### G3 — demand gate

Record the blocked workload, affected teams, existing-preset workaround, smallest
required change and expected measurable benefit. Try the smallest supported preset
before any catalogue, sizing or template editor. If demand is absent, keep the
defaults and improve the core service.

### Sandbox gates (SL-A…SL-E)

Use §4.4. They gate sandbox efficiency work only. Passing them does not close G0,
G1, G1-C or G2.

## 7. Verification and measurement

**Integration gate for any source change.**

```sh
bun run typecheck
bun run check:config
bun run test                 # Bun unit + runtime tests
bun run test:workers         # Worker/DO tests (vitest)
bun run build:ui
git diff --check
```

**Runtime/image change adds** `bash scripts/smoke-container.sh` on a native
amd64 runner. Record the image size, artifact digests, platform and any environment
limitation. A host-side observer timeout is not a product assertion; re-run on
native CI before claiming the revision.

**Live/deployed evidence** is required for G0/G1/G1-C/G2 and for any claim about
Cloudflare Containers, R2, Slack or model behavior. Local mocks never substitute.

**Measurement protocol.** Keep one task/fault inventory and one results record.
Before a paid/live run, record: destination/resources, workload, case selection,
runtime/image/model versions, cold/warm conditions, success criteria, numeric
thresholds and spend budget. Report all attempts, failures and interventions;
unsuccessful attempts stay in the denominator. Unknown costs stay unknown, never
zero. Report operator time separately; a monetary value needs an explicit rate.
Small authored samples describe those tasks, not overall model accuracy or an SLA.

**Alerting floor.** `turn.failed`, `turn.timedout`, `checkpoint.failed`,
`snapshot.failed`, `capacity.rejected`, budget high-water, and paused settlement
must be visible. A paused hold needs an operator-actionable signal, not only a
status field.

## 8. Reconciliation record

### 8.1 Document roles after this revision

| Document | Role now | What was folded into this plan |
|---|---|---|
| `docs/plans/execution-service-delivery.md` | **Historical delivery record**; evidence for R0-15/R0-16 and the measurement protocol | Delivery order, R1-4 slices, measurement/pilot protocol, gate-honesty rules |
| `docs/plans/sandbox-lighter-plan.md` | **Technical evidence** for shape, image, cold path and the Computer spike | SL decisions, targets, gates SL-A…SL-E, non-goals, cost model |
| `docs/plans/stow-workspace-integration.md` | **Storage evidence** for R0-15 | Native Workspace startup, split recovery, recovery inventory, cutover rule, artifact provenance |
| `docs/plans/r1-4a-caller-contract.md` | **Contract proposal awaiting sign-off** (design input) | Turn record, status, questions, cancellation, event framing, six decisions, acceptance matrix |
| `docs/plans/conversation-lifecycle-adoption.md` | **Implementation evidence** for the Lifecycle kernel | Job contracts, idle-close gate, sealing, backout constraints |
| `docs/design/r1-agent-boundary.md` | **Design input** for G1 | Credential/egress boundary, residuals, required probes |
| `docs/design/conversation-lifecycle.md` | **Contract summary** for the kernel | Public limits, bounded dedupe, replay semantics |
| `docs/plans/operator-reconciliation.md`, `r0-held-turn-reconciliation.md`, `r0-reliability-iteration.md`, `r0-simplification-research.md`, `slack-usability.md`, `roadmap-evidence-2026-11-11.md` | **Historical evidence and permanent invariants** | Accounting/recovery invariants, Slack limits, dated receipts |
| `docs/plans/agentos-storage-research.md`, `wasm-runtime-options-research.md`, `wasm-sandbox-feasibility.md`, `stow-local-branch-impact.md` | **Research reference** | No scheduled work; only the bounded Computer spike is authorized |
| `docs/production-audit.md` | **Audit evidence** | Findings 29–33 status, audit 32 open item |
| `docs/testing.md` | **Verification reference** | Layer separation and required regressions |
| `docs/runbook.md` | **Operational reference** | Deploy, recovery, rollback, onboarding procedure |

### 8.2 Conflicts resolved

1. **Several documents claimed to be "canonical."** Only this file is. The
   sandbox, storage and delivery documents are evidence; their open work is in §5.
2. **"No scheduler" vs the Lifecycle queue.** The roadmap now states the actual
   scope: a durable internal wake-intent scheduler, not a provider job engine or
   parallel prompt queue (I5).
3. **Idle close 30 s vs 5/10 minutes.** Production default is 300 s (SL-1.3);
   the runbook now matches. R3-6 is per-tenant configurability, not the default.
4. **Stow 0.3.7 evidence vs the 0.4.0 pin.** Current image pins 0.4.0. R0-15 must
   re-qualify on 0.4.0 and the custom shape; earlier receipts stay historical.
5. **C2 evidence on `standard-1` vs the custom shape.** The cold-recovery proof
   must be repeated on the current shape before production cutover.
6. **R1-4d extraction before/after the lifecycle refactor.** The lifecycle work
   already extracted most seams; R1-4d is re-scoped to close or handle a
   demonstrated seam, not repeat the refactor.
7. **Permanent receipt vs bounded status.** The public turn record is bounded
   status (I7), not an exactly-once or permanent-receipt promise.
8. **Permission rules as a security boundary.** They are UX guardrails (I8).
   R0-19/R1-7a/R1-7 own the real proof and fix.
9. **"HTTP and Slack parity" vs no token streaming.** Parity covers turns,
   questions, permissions, cancellation, replay and accounting. Snapshot output is
   the documented contract; deltas need demand evidence.
10. **R0-16 "implemented" vs deployed.** Implemented and locally verified; the
    production rollout is still open in W1.
11. **Sandbox gate names A–E.** Renamed SL-A…SL-E to avoid colliding with G0–G3.
12. **Image/node_modules numbers.** Current measured image: 514 MB arm64 / 469 MB
    amd64; node_modules 416 → 214 MB in the shipped prune. The older 235 MB
    exploratory measurement remains historical, not current state.
13. **Tenancy "partially implemented" vs usable.** Code exists; D1 is not bound
    and Settings/vault/budget are global. R1-5 must provision or remove it.

## 9. Deliberately not building

- Our own agent loop or model. OpenCode remains the runtime.
- Our own VM or scheduler. Cloudflare Containers is the substrate; the Lifecycle
  queue is internal wake bookkeeping only.
- An alternative execution backend, WASM/AgentOS rewrite, stow POSIX shim or
  full WASI/POSIX layer without measured need and the SL-C/SL-D gates.
- Snapshot-first recovery or a second writable workspace.
- Per-tenant arbitrary Dockerfiles or broad image catalogues before G3.
- A general job/process manager, connector framework or large SDK before the
  public contract and reference client demonstrate the need.
- Billing, marketplace, managed hosting, previews or a Git review UI before their
  demand gates.
- A multi-tenant or credential-isolation claim before R1-5/6/7/9 pass.

## 10. Decisions locked by this revision

1. **One canonical plan**: this document; all others become evidence/design/research.
2. **W0 correctness first**: R0-17/R0-18 before new scope; R0-19 records the
   isolation gap as evidence, not a fix.
3. **G1 order**: R1-7a before R1-7; R1-5/6/8 before R1-9; R1-3 before R1-4a.
4. **Caller contract**: lock the six R1-4a decisions before coding; bounded status,
   not a permanent receipt; snapshot output, not token deltas.
5. **Storage**: one supported native path; re-qualify on 0.4.0 + current shape;
   name retained/reset data at cutover.
6. **Sandbox**: keep the current container path and 300 s warmth until SL-A
   evidence; Computer spike stays bounded and optional.
7. **Truthfulness**: no gate closes on plans, builds, mocks or pattern strings.

## 11. Change log

- **2026-11-14 (W0 follow-through)** — committed W0 as `7626726`; found and
  recorded successful base CI runs `43627788591`/`43626528341`; froze the R0-15
  candidate artifact pair and next recovery matrix. W0 CI awaits branch-upload
  approval; no live resources were created and no product gate changed.

- **2026-11-14 (W0)** — implemented and locally verified R0-17/R0-18; retained
  the R0-19 current-image synthetic exposure receipt. Updated the queue and G1
  ledger without closing any product gate. Native CI, storage re-qualification,
  deployment and API/product sign-off remain outstanding.

- **2026-11-14** — consolidated the separate roadmap, delivery, sandbox, storage,
  lifecycle and caller-contract plans into this single authority. Added R0-17,
  R0-18 and R0-19 from a code-first evaluation; updated the gate ledgers; recorded
  the reconciliation and conflict resolutions; re-scoped R1-4d; recorded the
  current container-smoke environment limit and the latest native CI evidence.
