# Plan — Aboiteau execution service

**This is the single canonical plan.** Status and sequencing live here. Every other
document under `docs/` is evidence, design input, research or an operational
reference; none of them schedules work. If another document disagrees with this
one, this one wins. The reconciliation record in §8 says what each former plan
became.

Updated: 2026-11-15. Previous planning authorities folded in:
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
service currently hosted on Cloudflare. The user-directed replacement track in
§5.6 targets a standalone Linux host using our Stow/Vault primitives. A team
installs it in its own account or host, connects a provider, and starts general
work in a disposable or persistent workspace through a public API or connector.
Work can start from nothing and remain repository-free; repository integration
is optional. **OpenCode** remains the execution runtime; the service owns
admission, persistence, accounting, recovery and upgrades. **Slack** is the first
connector, not the execution model.

**Comparative position.** The candidate distinction is the integrated operator
workflow: owned usage holds, settlement/reconciliation, portable encrypted
workspace/state recovery and connector behavior. Durable sessions, FIFO/steer,
cancellation, replay and Linux execution already exist in current Cloudflare
building blocks. They establish parity, not comparative advantage. Task success,
recovery, operator effort, cost and latency advantages remain unmeasured.

The primary execution-equivalent baseline is **OpenCodeHarness + a Linux
sandbox**. A DO-only JavaScript workspace cannot stand in for a Linux build/test
environment. Pi/Think are alternative loops, Exo is an architectural peer, and
E2B/Daytona are alternative execution substrates. Compare each at its own layer;
do not count a platform primitive as an operated product or claim absence from
an entire platform because one example omits it. The
[source-backed comparison](evidence/cloudflare-harness-comparison-2026-11-14.md)
records the inspected source and limits. **R0-23 / C0** supplies the comparative
decision before broad platform expansion. The separately user-directed PORT
replacement track does not depend on winning C0; neither track closes the other's
runtime/security gates.

**Workspace workflow and optional GitHub publication (R2-9).** Start disposable
or net-new persistent general work without a repository. Named retention,
keep/discard controls and recovery are the current workspace increment; users
can retain work permanently without Git. If the caller later selects an
authorized repository and base branch, Aboiteau checks it out,
the agent creates a working branch, makes changes and runs checks, then an
explicitly authorized publication operation pushes that branch and returns a
draft pull-request URL. HTTP/reference-client and Slack callers use the same
operations. Readiness, review evidence and caller-requested revision acceptance
are refined in §5.7. GitHub credentials stay outside repository-controlled execution.
This is scheduled before G2 pilots; the storage, credential-boundary and public
API prerequisites still apply.

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

**Current supported stack, retained until a qualified cutover.** OpenCode in Cloudflare Containers; native Stow working storage;
R2 workspace/state recovery; `agents@0.33.0` Lifecycle wake intents; one active
turn plus a durable bounded FIFO; per-conversation Durable Objects; one global
Settings DO until strict tenancy replaces it.

Retain this supported path while R0-23 tests whether upstream components can
replace custom plumbing without weakening the accounting, recovery or caller
contracts. A measured reuse recommendation needs a separately scoped cutover,
retained-data inventory and backout; no speculative backend abstraction or
parallel production path is required to run a disposable comparison.

**Replacement direction (2026-11-15).** Own supervision and workspace; keep
execution runtimes replaceable. Aboiteau owns the durable controller, wake intents,
admission, accounting and recovery; Stow owns the workspace contract; Vault supplies
credential storage. The reference host uses private SQLite, an HTTP controller,
Caddy and systemd. Qualify light execution early for startup speed, with native
Linux available for compatibility. Rivet/agentOS can inform or implement a runtime
adapter, but never own our supervisory core. §5.6 owns sequencing and cutover.
Cloudflare remains the supported host until those checks pass; there is no
dual-writer production migration or general multi-cloud framework. This new
user-directed track supersedes the blanket C0 prerequisite only for PORT work.
The Computer/WASM experiments and broad platform expansion retain their gates.

**First pilot topology.** One team per Cloudflare account, or per standalone host
after PORT-G qualification. The tenant→agent
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
| I5 | **One active turn plus a durable, bounded FIFO queue.** The Lifecycle queue (standalone: transactional jobs table) holds internal wake intents only — no provider job engine or parallel turn dispatch. Messages default to `queue`; `steer` belongs to the active turn; `interrupt` is explicit and settles before the follow-up. `singleflight` is not a side-effect lock. |
| I6 | **Recovery restores files and history, not process memory.** A checkpoint proves persisted bytes; it never implies resumed processes, replayed external effects or zero spend. |
| I7 | **Idempotency is bounded, not exactly-once.** 200 claims plus a 24 h tombstone are dedupe bookkeeping. A public turn record is bounded status, not a permanent receipt or a provider-success guarantee. |
| I8 | **Isolation claims require OS/network proof.** Permission-pattern strings are UX guardrails. No G1 or multi-tenant claim from glob rules, a single-tenant deployment or a local mock. |
| I9 | **One workspace authority.** No dual writable workspaces, no stow/Computer dual writers, no snapshot-as-primary-recovery. |
| I10 | **Connector parity does not duplicate the engine.** Slack and HTTP render the same admission, questions, permissions, cancellation and accounting outcomes. |
| I11 | **Slack image slice stays bounded.** One PNG/JPEG ≤5 MiB, DMs and engaged threads, immediate admission only, capability checked before reservation, never auto-switch the model. |
| I12 | **Operator reconciliation is separate and privileged.** Not available through Slack or ordinary connectors; evidence-digested, quiescence-proven and permanently recorded. |

## 4. Current state — 2026-11-14

### 4.1 What is verified

- Comparative primary-source research is complete, **runtime comparison is
  unmeasured**. OpenCodeHarness and Pi/Think already supply substantial durable
  harness machinery; a Linux sandbox can supply native tools. The small Linux
  OpenCode runner has a narrower continuing-work/recovery workflow, but its
  credential-injection placement and Exo's are implemented outside the sandbox.
  Aboiteau has not established a task-quality, security, speed or cost lead.
  Source spot-checks at `d428cf5` include the completed permission retry and
  FIFO/steer/interrupt work; the earlier assessment is a historical snapshot.
  [Comparison evidence](evidence/cloudflare-harness-comparison-2026-11-14.md).

- R0-21 permission-notification recovery is implemented locally: durable
  acknowledgement/backoff, batch isolation, restart retry and resolved/stale
  cleanup. Five new fault tests and the full 356-test Worker/DO gate pass;
  [receipt](evidence/r0-21-permission-delivery-2026-11-14.md). The integrated
  repair is now covered by the native CI receipt in §5.4; deployed Slack
  verification remains owed.

- Follow-up code assessment: **412 Bun + 5 runtime + 351 Worker/DO tests passed**;
  typecheck/config/UI checks passed. Three disposable local diagnostics confirmed
  approval-notification loss, observation-only timeout behavior and admitted-turn
  budget overshoot (E7–E9 below). These are simulated control-path results, not
  provider-task or native-runtime qualification. The assessment did not rerun
  container smoke because its local Docker daemon was unavailable; the recorded
  native CI passes below remain separate evidence. See the
  [assessment receipt and reproduction details](evidence/code-assessment-2026-11-14.md).

- The corrected R0-15 candidate (`metadata-refusal.2`) passed **17/17 fixed live
  Cloudflare/R2 outcomes: 14 preserved, 3 safely refused, zero failures**.
  Unsupported metadata writes now return 501 before mutation. Final source
  `fa5411b` passed native CI (412 Bun + 5 runtime + all 351 Worker/DO tests and
  native container smoke). [Remediation and receipts](evidence/storage-metadata-remediation-2026-11-14.md).
  The [retained-data runbook](runbooks/storage-cutover.md) resets no operator data.
  Live account-seed rehearsal and production cutover remain open; no product or
  security gate closes from this fixed synthetic qualification.

- The initial unpatched R0-15 probe ran on the frozen Stow 0.4.0 image and
  requested custom shape in live Cloudflare/R2: **14 preserved, 2 registry
  refusals before mutation, 1 metadata failure**. Encrypted split archives,
  cold image start, exact keys, multipart completion, Git, imported session
  history and the fixed active-writer recovery point passed. Accepted metadata
  PUT loses Cache-Control, Content-Disposition and Content-Encoding at the HEAD
  surface before capture. [Live receipt](evidence/storage-matrix-live-2026-11-14.json)
  and [interpretation](evidence/storage-matrix-2026-11-14.md). The test Worker,
  container application and bucket were removed. This is a failed qualification;
  R0-15 and product gates remain open.

- R0-15 harness preparation on base `dca482d`: shared 0.4.0 artifact pins,
  explicit custom profile, stale-receipt refusal, six safety contracts and an
  offline Wrangler dry run pass. The regular gate passes 407 Bun tests,
  5 runtime tests, 351 Worker/DO tests and typecheck/config/UI/diff checks.
  [Receipt](evidence/storage-harness-preparation-2026-11-14.json). Resource
  allocations remain unmeasured; remote image availability and live recovery
  qualification remain open.

- W0 published as `7626726` on base `39a42d5`: R0-17/R0-18 implemented and locally
  verified; 401 Bun tests + 5 runtime tests + 351 Worker/DO tests pass, with
  typecheck/config/UI/diff checks passing. R0-19 recovered synthetic credentials
  through both allowlisted paths in the current 0.4.0 local image. See the
  [W0 receipt](evidence/w0-correctness-2026-11-14.md) for commands, source/artifact
  hashes and limitations, including one intermittent recovery-test failure between
  passing full runs. This is **KNOWN_OPEN_G1** evidence. Native CI
  [run `43633250236`](https://github.com/chester-hill-solutions/cf-opencode/actions/runs/43633250236)
  passed both `check` and `container-smoke` for this commit; the recovered
  intermittent test passed on native CI too. [Structured receipt](evidence/w0-native-ci-2026-11-14.json).
  No production deployment or product-gate closure is claimed.

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
  SL-B originally closed at `7f33cd6` (run `43614603372`). W0 `7626726` is now
  separately smoke-qualified by run `43633250236` above. Later documentation-only
  follow-ups remain local; native qualification belongs to the tested commit.
- Lifecycle scheduler, sealed recovery, idle close, split checkpoints, reservation
  accounting, operator reconciliation, Slack commands/questions/images/replay and
  the onboarding wizard have local or recorded live evidence in their evidence
  files (§8). None of that closes G0/G1/G1-C/G2.

### 4.2 Assessment findings and dispositions

Code-first evaluations on 2026-11-14 found these. Product documentation was
excluded from the assessments; the follow-up encountered a manifest description
but did not use it for judgment. The findings and their dispositions live here;
supporting receipts do not schedule separate work.

| ID | Finding | Evidence | Disposition |
|---|---|---|---|
| E1 | **The credential boundary is not enforced by the OS.** The agent UID owns `$HOME`/`XDG_*` at `/var/lib/aboiteau/state` (`entrypoint.sh:20-42`), and the allowlist grants `find *`. With OpenCode's own anchored matcher, `find / -name opencode.json -exec cat {} \;` evaluates **allow**, while a literal `cat /var/lib/.../opencode.json` evaluates **deny**. Repo-controlled code run via allowed `bun test` can read the same files. | `src/permissions.ts:71-115`; `@opencode/core/dist/util/wildcard.js`; `.../chunks/location-nw8h2gm9.js:100`; `Dockerfile:70-74`; `docs/design/r1-agent-boundary.md` §3.2–3.4 already records the residual | **R0-19 recorded** the [current-image synthetic exposure](evidence/r0-19-2026-11-14.json); **R1-7a/R1-7** own the fix. No G1 claim until the real-container proof passes. |
| E2 | **A Slack failure while announcing a question aborts the turn before settlement.** `pumpOnce` awaits `pollQuestions` before `finishTurn`; the Slack client throws on `ok:false`. Reproduced in a disposable DO test: `pumpOnce` rejected with `missing_scope`, phase stayed `running`, no `settled` event. Permanent Slack errors wedge the conversation with a retained hold. | `src/conversation/turn-execution.ts:241-246,387-416`; `src/conversation/slack-adapter.ts:331-345` | **R0-17 DONE locally**; [passing fault regressions and gate](evidence/w0-correctness-2026-11-14.md). Deployment still owed. |
| E3 | **HTTP is not at parity with Slack.** No turn-scoped cancel, no question/form route, forms polled only when `state.slack` is set, and output is a full-text snapshot per poll rather than token deltas. | `src/index.ts:432-531`; `turn-execution.ts:232,237-240`; `src/events.ts:8-13` | Already the target of **R1-4b/R1-4c**; make snapshot semantics explicit and keep deltas out of scope unless demand appears. |
| E4 | **Tenancy is implemented but inert.** D1 is not bound, there is no provisioning surface, provider sync is disabled for namespaced keys, and Settings/vault/budget remain global. | `src/tenancy.ts`; `wrangler.jsonc` (no `d1_databases`); `migrations/0001_tenancy.sql`; `src/conversation/readiness.ts:99`; `src/vault.ts:22-24` | **R1-5**: provision it (binding + admin/CLI + scoped settings/seeds/keys) or delete the dormant claim before G1. |
| E5 | **Dispatched-turn timeout escapes alerting; stale settlement state can persist.** The dispatched timeout path does not count/log `turn.timedout` although it is an alert counter; paused settlement re-polls indefinitely; `settlementError` is cleared only in the reservation branch. | `src/conversation.ts:1041-1046`; `src/alerts.ts:20-26`; `turn-execution.ts:257-272,321-331` | **R0-18 DONE locally**; [timeout/paused/success-path regressions](evidence/w0-correctness-2026-11-14.md). Deployment still owed. |
| E6 | **The local container smoke's observer timeout is an environment limit.** Native CI has passed the same gate. | §4.1; sandbox evidence note 2026-11-14 | No product ticket. Record the environment in evidence; do not claim a local full pass. |
| E7 | **A failed permission notification can suppress later retries.** `pollPermissions` records every fresh request before delivery, then filters recorded IDs on subsequent polls. With two pending permissions and a transient first-send failure, service recreation plus another poll produced one attempt, zero successful deliveries and both IDs still pending. | `src/conversation/turn-execution.ts:387-400`; `src/conversation.ts:976-980`; [local diagnostic](evidence/code-assessment-2026-11-14.md#approval-delivery) | **R0-21 DONE locally, rollout owed** — [five new fault regressions and the full local gate pass](evidence/r0-21-permission-delivery-2026-11-14.md); ownership, durable delivery acknowledgement/backoff and failure isolation are separate. Bounded deployed Slack verification remains owed. This is distinct from R0-17 question cards. |
| E8 | **The 15-minute timeout observes overdue work; it does not interrupt it.** A dispatched overdue turn recorded the timeout, retained its hold, read context and rescheduled with zero interrupt calls. | `src/lifecycle.ts:9`; `src/conversation.ts:1041-1065`; [local diagnostic](evidence/code-assessment-2026-11-14.md#timeout-behavior) | **R0-22 DONE locally; deployed verification owed** — user chose observe-and-alert with manual stop; status exposes observation, requested stop, unknown runtime stop and settlement. R0-18 remains complete for observability; it never established a runtime stop guarantee. |
| E9 | **The daily budget is an admission gate, not an active-turn spending ceiling.** The fixed $0.10 hold admitted a synthetic turn under a $0.10 budget; reporting $5 usage succeeded and only the following admission was refused. | `src/conversation/budget-reservations.ts:74-81`; `src/settings-do.ts:431-446`; [local diagnostic](evidence/code-assessment-2026-11-14.md#budget-exposure) | **R0-3 acceptance expanded** — preserve I4, regression-test the boundary and measure admitted-turn/concurrent exposure. Do not introduce a hard-cap claim or a new billing engine from this probe. |
| E10 | **Generic durable harness features substantially overlap with upstream.** OpenCodeHarness supplies durable operations, queue/steer, abort, permissions and replay; Pi/Think provide alternative loops, and Linux tools can live in a separate sandbox. | [Inspected APIs/source and limits](evidence/cloudflare-harness-comparison-2026-11-14.md#opencodeharness-close-overlap-in-the-control-plane) | **R0-23 / C0 OPEN** — compare against OpenCodeHarness + equivalent Linux tools; identify which custom plumbing earns its maintenance burden and which can be reused upstream. R0-20/R0-21 completion remains recorded; overlap does not reopen those repairs. |
| E11 | **Comparable credential-placement implementations already exist.** Cloudflare's Linux runner and Exo inject selected credentials outside repository-controlled execution; Aboiteau's E1 boundary remains open. | [Runner/source scope](evidence/cloudflare-harness-comparison-2026-11-14.md#the-current-linux-opencode-runner-is-the-most-direct-small-example); [Exo](evidence/cloudflare-harness-comparison-2026-11-14.md#exo-an-architectural-peer) | **R1-7a/R1-7 acceptance sharpened** — evaluate these patterns first, then prove scoped provider/Git access and fail-closed egress in the actual runtime. Example code is not universal secret safety or per-repository authorization. |
| E12 | **Comparative outcomes are unknown; persistence guarantees differ.** Aboiteau restores files/history, while some E2B/Daytona modes preserve memory. Exo is a close orchestration peer; substrate features and narrower examples are not equivalent finished products. | [Peer/substrate boundaries and proposed measurements](evidence/cloudflare-harness-comparison-2026-11-14.md#other-close-and-adjacent-comparables) | **R0-23 extends R0-2/R0-3**, using one task/fault inventory and results record. Report non-equivalences and all failed/unsupported attempts; no superiority claim from feature count, docs or test counts. |

<a id="current-gate-ledger"></a>
### 4.3 Current gate ledger

| Gate | Question | Status | Remaining evidence | Owner |
|---|---|---|---|---|
| **G0** | Do representative coding tasks complete and survive defined failures with correct admission/accounting and measured cost per accepted task? | **OPEN** | R0-21 deployed approval-delivery check; R0-22 deployed timeout/stop verification; R0-1 staging rehearsal; R0-2 frozen task/fault matrix; R0-3 cost/latency and admitted-turn budget exposure; R0-23 comparative results linked to that matrix (C0 is a separate decision); R0-11 deployed container checks and legacy/manual ledger; R0-15 live account-seed rehearsal and production cutover ([corrected fixed matrix passed](evidence/storage-metadata-live-2026-11-14.json)); R0-16 production replay rollout | platform + operator |
| **G1** | Do credential, egress and strict tenant boundaries hold, including resolver outages and repository-controlled probes? | **OPEN** | R1-3 deployed lifecycle proof; R1-5/6/8 strict identity, scoped keys, quotas; R1-7a/7/9 real-container egress and cross-tenant enforcement; [R0-19 confirms current exposure](evidence/r0-19-2026-11-14.json) | security + platform |
| **G1-C** | Can a non-Slack client use stable turns, questions, permissions, cancellation, reconnect and recovery solely through the public API? | **OPEN** | R1-4a sign-off and implementation; R0-22 timeout policy reflected in R1-4b status/cancellation; R1-4b neutral interactions; R1-4c reference-client conformance | API + connector |
| **G2** | Can five external teams install in their own accounts, integrate, repeat work, and upgrade/restore without builder intervention? | **NOT STARTED** | C0 investment decision before W5/pilot expansion; R2-2/3/4/6/7/8; R2-9; five pilots including one independent public-API repo-to-draft-PR integration | pilot owner |
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
| **SL-C** Computer workerd spike | **NOT STARTED** | Requires C0 comparison decision, SL-A evidence and the SL-6.1 authority ADR first. |
| **SL-D** ContainerBackend | **NOT STARTED** | Only if SL-C passes; keep the current container path as fallback. |
| **SL-E** Production canary | **NOT STARTED** | Canary shape/image, rollback drill, unchanged accounting/permissions/Slack/SSE/recovery, measured cost per accepted task. |

### 4.5 Comparative decision checkpoint

| Checkpoint | Question | Status | Exit evidence |
|---|---|---|---|
| **C0 — R0-23** | Which operating behavior warrants custom code, and which upstream components should be retained or adopted? | **OPEN — four-cell smoke passed; full task/fault matrix and reuse decision remain unmeasured** | Frozen equivalent-workload protocol, all task/fault attempts and operating costs, then a reasoned retain/reuse/reduce decision with accounting/security/recovery constraints and any remaining unknowns. |

C0 is an architecture/product investment decision, not another security or task
completion certification. It does not require Aboiteau to win every metric, and
cannot close G0/G1/G1-C/G2. Complete it before the optional SL-5.x backend spike
or expansion into W5/R3 platform scope. The user-directed PORT replacement in
§5.6 is a separate exception: infrastructure independence is its objective and
does not require a competitive win. Independent correctness fixes, scoped
credential enforcement, qualified storage rehearsals and public-contract work
continue; benchmarking must not delay repair of a demonstrated defect.

## 5. Next steps — one ordered queue

Waves express priority and prerequisites, not a serial calendar. W0 starts now.
W1 and W2 may overlap where their dependencies allow. W4 efficiency evidence runs
alongside W1–W3 but closes no product gate. W5 expansion waits for C0 + G1 + G1-C;
independent design, fixtures and security checks can proceed.

### 5.1 Queue

| Wave | ID | Work | Size | Depends | Done when |
|---|---|---|---|---|---|
| **PORT** | **PORT-0…PORT-12, 5c, 7a** | **PLANNED; implementation not started** — replace Cloudflare while owning supervision/workspace, and keep the harness useful without an execution | L, sliced below | §5.6 dependencies; correctness repairs continue; cutover requires PORT-G | Standalone install, restart/recovery, runtime portability and retained-data cutover qualified; no Cloudflare service required for supported operation |
| **W0** | **R0-17** | **DONE locally** — Slack question delivery must not block settlement | S | — | Failed question posts are caught, counted, retried with durable 5 s–5 min backoff; acknowledged cards are not repeated; terminal usage still settles. [Receipt](evidence/w0-correctness-2026-11-14.md) |
| **W0** | **R0-18** | **DONE locally** — Timeout and settlement observability | S | — | Both timeout paths count/log once; first paused episode alerts; successful settlement clears the error with or without a reservation. [Receipt](evidence/w0-correctness-2026-11-14.md) |
| **W0** | **R0-19** | **RECORDED** — Isolation probe harness (evidence, not a fix) | S | — | Both allowed commands recovered a synthetic state credential as UID 1001 in the current image; exit 2 / **KNOWN_OPEN_G1**. [Raw result](evidence/r0-19-2026-11-14.json); enforcement remains R1-7a/R1-7 |
| **W0** | **R0-21** | **DONE locally; deployed check owed** — Recover failed permission notifications | S | — | Pending authorization and delivery acknowledgement are distinct; transient/batch/restart failures retry durably with bounded backoff; acknowledged sends are not repeated; connector failure cannot stop usage observation or terminal settlement. See §5.2 |
| **W1** | **R0-22** | **DONE locally; deployed verification owed** — Observe-and-alert timeout and explicit manual stop | S | R0-18 | Overdue-work observation and requested/observed stop are distinct in status and guidance; chosen policy has fault regressions; no hold release or stop claim on interrupt acknowledgement. See §5.2 |
| **W1** | **R0-1** | Reproducible Worker/image build, staging upgrade and backout | S | — | Workers Builds path re-run; staging upgrade + rollback receipt recorded |
| **W1** | **R0-2** | Frozen representative task/fault matrix | M | R0-1, R0-15 cutover | ≥10 predeclared coding tasks over ≥2 repos; accepted changes/checks/restart survival reported with all attempts in the denominator |
| **W1** | **R0-3** | Cost and latency baseline, including admission-budget exposure | M | R0-2 | Cold/warm p50/p95, checkpoint/restore, recovery, interventions, container/R2/model cost per accepted task; fixed-hold vs actual and concurrent admitted-turn exposure reported; low-budget boundary regression; unknowns stay unknown |
| **W1** | **R0-23** | **OPEN, P1** — Four-cell smoke passed; native fault controls and full matrix next | M | Runtime: R0-1, R0-2; native fault controls and separate full-matrix budget | Reuse the R0-2 task/fault matrix and R0-3 cost record; [four-cell smoke](evidence/r0-23-smoke-2026-11-15.md) passes both arms. Finish fault controls and full-matrix measurement; no implicit backend cutover |
| **W1** | **R0-11** | Deployed checks for R0-10/R0-11/R0-13 and the legacy/manual ledger | M | R0-15 | Audit 29/30/31/33 regressions pass in a deployed container; unprovable legacy cases named with their permanent marker |
| **W1** | **R0-15** | Storage production cutover and full recovery inventory — corrected fixed matrix qualified | L | — | [Corrected live receipt](evidence/storage-metadata-live-2026-11-14.json): 14 preserved, 3 safely refused, zero failures. Native CI passes. Complete live account-seed rehearsal and remaining cutover inventory, then review the [retained-data runbook](runbooks/storage-cutover.md) and production rollout; no operator data reset proposed |
| **W1** | **R0-16** | Public replay production rollout | S | — | `Last-Event-ID` forwarding and reset path live; snapshot-vs-delta semantics documented; no prompt resend on reconnect |
| **W1** | **R0-20** | **IMPLEMENTED; steering-consumption/deployed verification owed** — Message delivery modes: durable FIFO queue, steer, interrupt-with-follow-up | L | R0-17, R0-18, R0-21 | Default queue accepts multiple messages FIFO across restart; full queue refuses without loss; steer joins the active turn with no new hold; interrupt settles before the follow-up; ambiguous interrupt does not duplicate; Slack/HTTP parity; tests |
| **W2** | **R1-7a** | Disposable credential/egress feasibility proof using inspected external-injection patterns | M | R0-19 | Evaluate Cloudflare runner/Exo patterns first; synthetic provider/git credentials outside the sandbox; scoped default-deny egress proven for provider HTTP/SSE, clone/fetch, packages; unsupported paths rejected; OpenCode self-approval residual recorded |
| **W2** | **R1-1/R1-2** | Stable checkpoint keys and deployed `durable_object` policy cutover | S+M | R0-10 | One supported checkpoint layout; legacy copy only with a named retained-data requirement; deployed policy and replacement cutover verified |
| **W2** | **R1-3** | Deployed per-conversation lifecycle and isolation inspection | M | R1-1, R1-2 | Runtime generation, active turn and last verified recovery point inspectable; per-conversation start/snapshot/inactivity/lease behavior verified in deployment |
| **W2** | **R1-5** | Strict tenancy and scoped configuration | L | R1-2 | D1 bound; tenant/agent/binding provisioning exists; absent/unknown/invalid/unavailable resolution fails closed with no legacy/global fallback; per-agent settings + account seed; or dormant tenancy is deleted before any claim |
| **W2** | **R1-6** | Per-tenant API keys | M | R1-5 | Hashed, revocable keys; shared `API_TOKEN` retired for tenant routes; revocation cannot steer new or existing work |
| **W2** | **R1-8** | Tenant quotas and concurrency caps | M | R1-5 | Container/minutes/storage limits named in rejection and status; no tenant can exhaust the account |
| **W2** | **R1-7** | Egress and credential enforcement | L | R1-7a, R1-3 | Credentials live only in the egress proxy; repository-controlled code cannot read them via files, child env, process state or clone args; direct credential-bearing fallback fails |
| **W2** | **R1-9** | Cross-tenant isolation matrix | M | R1-5, R1-6, R1-7 | Two tenants run concurrently; A cannot read B's state, events, settings, checkpoint, repo or questions/permissions/cancel/recovery; resolver outage probes pass |
| **W2** | **R1-10/R1-11** | Single cutover and rename | S+M | G1 + G1-C | One supported version; coupled clients updated; backout to a matching recovery point; Worker/package/repo/URL/Slack URLs/secrets renamed together |
| **W3** | **R1-4a** | Lock the caller-contract decisions (now seven), then implement turn identity/status | M | R1-3, R0-16 rollout, R0-20 | r1-4a §6 decisions signed off; one persisted turn record per accepted request; submit returns a turn or queue entry with position and delivery; same key+digest replays across restart; different digest → 409 before work; typed status separates execution/accounting and reports unknown |
| **W3** | **R1-4b** | Neutral questions, permissions, cancellation, steer and interrupt | M | R1-4a, R0-22 | `GET/POST /questions`, turn-scoped cancel with optional follow-up, `turnID` on replayable frames; stale/foreign answers rejected; unreadable pending state → 503; cancel/steer/interrupt report requested, observedStop and settled independently and never release accounting; timeout policy and snapshot semantics documented |
| **W3** | **R1-4c** | Reference CLI and non-Slack conformance | M | R1-4b | CLI uses only public HTTP/SSE, no Slack credentials, passes submit/follow-up/retry/question/permission/cancel/reconnect/restart/recovery cases against shared fixtures |
| **W3** | **R1-4d** | Re-scope protected extraction | S | R1-4c | Audit-24 extraction is either closed as consumed by the lifecycle refactor or limited to a demonstrated seam; no speculative backend interfaces |
| **W3** | **R1-4e** | Opt-in MCP connector for agent offload | M | R1-4b | `MCP_ENABLED` (default off) with `MCP_TOKEN ?? API_TOKEN`; Streamable HTTP at `/mcp`; a stateless `createMcpHandler` server with tools `submit`/`status`/`wait`/`read`/`cancel`/`questions`/`answer` reusing the public contract through the client shared with R1-4c; `submit` returns a turn immediately and `wait` is bounded; no credential, digest, queue id, R2 key or reservation id in any tool result; shared conformance fixtures; the route is added outside `handleApi` so the lint ratchet does not grow |
| **W4** | **SL-1.2/1.5** | Turn, memory and cost evidence; 2 vs 3 GiB decision | M | — | Turn latency and RSS on a representative repo; cost per active hour; OOM alert; chosen default recorded |
| **W4** | **SL-1.4/SL-3.x/SL-4.x** | Prewarm, measured boot wins, restore path | M | SL-A | No-provider-spend prewarm with capacity respect; each boot/restore change kept only with before/after numbers; security tests unchanged |
| **W4** | **INFRA-1** | Publish the static guards and RatchetStrap; consume by version | M | RatchetStrap #262 | The Callcaster guards and `ratchet-strap` are consumed from their registries with lockfile integrity; `tools/vendor` and the tarball override are gone; CI holds registry credentials; improvements arrive as version bumps instead of re-vendored copies |
| **W4** | **SL-6.1** | Workspace-authority ADR | S | — | One authoritative writer chosen with recovery story; no dual-writer integration before it |
| **W4** | **SL-7.x** | Runbook, canary and cost dashboard | M | SL-1.2 | Docs match code; canary + rollback proven; per-start/active-hour/turn cost visible |
| **W4** | **SL-5.x** | Bounded Computer spike | L | C0, SL-A, SL-6.1 | Gate SL-C evidence: workerd host boots, bundle fits, file ops measured, no credential/token leak, gap report; then stop or continue to SL-D |
| **W5** | **R2-2/3/4** | Own-account bootstrap, install, minimal operator view | M slices | C0, G1 + G1-C | Scoped key bootstrap; prerequisite diagnostics → repo/provider → verified task; active work/recovery/held usage/limits/revocation visible without source imports |
| **W5** | **R2-9** | General disposable/persistent workspace → optional repository, tested branch and draft PR | M slices | C0, R0-15, G1, G1-C | General work starts without Git; persistent/disposable selection, naming, promotion and safe explicit discard; repo/base optional, with public/private scoped clone/fetch/push and draft-PR creation; checks and commit recorded; restart/retry reconciles publication without duplicate PRs; HTTP/Slack parity; caller receives review/check evidence, patch/PR URL and can request a checked revision. See §5.2 and §5.7 |
| **W5** | **R2-6/7/8** | Operating measurements, security review, install/upgrade guide | M | R1-8, R1-7 | Cost/intervention baseline; no critical security findings; versioned install/upgrade/rollback/export/restore runbook with pilot attempts |
| **W5** | **R2-1/R2-5** | Optional Slack OAuth install; tenant export/removal | M | R1-5, R1-6; demand-sequenced | Per-workspace install/uninstall if demanded; invite/remove/export/delete tenant with checkpoints; not a core onboarding prerequisite |
| **W5** | **G2 pilots** | Five external own-account teams | L | C0 + G1 + G1-C + R2 | Predeclared tasks, later-day repeat use, prescribed upgrade/restore, one independent non-Slack integration; every failure kept |
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

**R0-21 — permission delivery recovery (P1, implemented; deployed check owed).**
Extend the existing permission path rather than adding another approval engine.
Keep pending request→session ownership available for valid replies, and track
connector delivery independently. A failed send must remain eligible for retry;
one failed request must not suppress the rest of a batch. Persist bounded backoff
across service recreation, expose connector failure through a secret-free event
and metric, and keep permission posting failures from aborting usage observation
or terminal settlement. Clear retry state when a request resolves or becomes
stale. Acknowledged sends must not repeat; a lost send acknowledgement is
ambiguous and must not be presented as an exactly-once guarantee.

Regression cases: first-send transient failure→success; two pending requests
with the first failing; service recreation before retry; permanent connector
failure with continued usage observation and eventual terminal settlement;
resolution/stale-session cleanup; no repeat after acknowledged delivery. Use
synthetic connector responses locally, then record a bounded deployed delivery
check before claiming the Slack workflow repaired in production.

**R0-22 — timeout and stop semantics (P2).**
The current 15-minute threshold is an overdue-work observation, not a runtime
execution deadline. The user confirmed **observe-and-alert with explicit manual
stop** on 2026-11-14. Keep R0-18's completed alerting work separate; status and
guidance now name this policy. Automatic interruption is outside this choice.

Acceptance distinguishes deadline observed, stop requested, runtime stop
observed and accounting settled. Cover terminal completion racing the threshold,
restart, repeated observations and unavailable/ambiguous interrupt responses.
Never release a dispatched hold on elapsed time or interrupt acknowledgement.
Any claim that execution or child work actually stopped needs a disposable
native-runtime check, separate from the local control-path diagnostic.

**R0-3 addition — measure budget exposure, do not invent a ceiling.**
Retain the low-budget fixture: $0.10 budget, $0.10 admitted reservation, $5
synthetic usage accepted, next admission refused. This verifies accounting and
admission semantics only. For the authorized representative task matrix, report
actual spend above the estimate, concurrent in-flight exposure, reporting delay
and behavior on stop. Keep caller/operator wording explicit that the estimate
does not cap provider spend; unknown provider costs remain unknown. A hard
spending guarantee requires a separate runtime/provider enforcement design and
evidence, not larger fixed holds or a passing ledger test.

**R0-23 — comparative baseline and reuse decision (P1).**
**Four-cell smoke PASSED; C0/G0 remain OPEN.** The frozen v11 run used
`opencode/deepseek-v4.1-flash` for L1/Q1 in both arms. All **4/4 cells** passed
public regressions and independent private oracles; each agent runtime stopped
before separate-VM grading, and every grader stopped. The 27 provider requests
have complete terminal usage, no refusals and a **$0.0542769 published-rate
estimate**. Actual billing, infrastructure cost and operator time remain
unreconciled. [Per-cell times, request counts, costs and limits](evidence/r0-23-smoke-2026-11-15.md),
[raw v11 receipt](evidence/r0-23-live-2026-11-15-08.json).

The user was already signed in: the initial 401 tested an **inactive legacy
API key**, not the current CLI's active Chester Hill Solutions OAuth connection.
The operator now selects that active connection, verifies it without inference,
and forwards its configured workspace header. Refresh credentials stay local;
real provider credentials stay outside Linux. No re-login was required.
[Corrected diagnosis](evidence/r0-23-provider-auth-2026-11-15.json).

The baseline uses OpenCodeHarness/Workerd plus Linux tools. Aboiteau uses actual
Conversation orchestration and native OpenCode. The staging build profile allows
owned-VM shell work while retaining product hard denials; baseline shell is
broader. Full tool/system-prompt/policy equivalence remains unproved, so the
matched stratum is **unrated**. Workspaces/containers were fresh; Worker and
coordinator code were partly primed by model-free gates. Two authored tasks with
one repetition per arm do not establish representative coding accuracy, a
winner, percentiles or a retain/reuse/reduce decision. Production permission
policy and deployment are unchanged.

Earlier setup and failed/blocked cells remain retained, including the native
approval waits and explicit operator interruptions. Published-rate estimates
across v10/v11 sum to $0.0918564; the old inactive-key401 retains unknown billing.
Five final v10 Q1 request rows were observed and summed but not individually
retained; that accounting limit is explicit. The final $5 authorized scope was
allocated as $4.50 continuation budget, $0.25 prior-known-cost reserve and $0.25
prior-unknown-cost reserve; reserves are not expenses. No full-matrix spend is
authorized. [Integration repairs and retained source archives](evidence/r0-23-staging-integration-2026-11-15.md).

All **eight** deployed disposable scopes were verified removed, including owned
container applications and checkpoint buckets, with pre-existing applications
retained. Final local checks: **80 tests /561 assertions**, both TypeScript
projects and offline bundle pass. Actual SDK/schema/config-script checks cover
the staging policy; 34 Worker regressions cover the protected runtime hooks.
The [v11 manifest](../bench/comparison/protocol.freeze.v11.json) and exact source
archive identify the uncommitted code; root HEAD alone does not.

**Product differentiation correction (2026-11-15).** OpenCode Console now
documents hosted Slack agents with sandbox execution and approvals (early access),
remote web/server access, budgets and hosted session retention. These capabilities
must not be sold as unique to Aboiteau. The narrower candidate value is the
Cloudflare-specific self-hosted operating package, owner-controlled encrypted
checkpoint/recovery lifecycle, and application-level turn admission/settlement/
operator reconciliation. OpenCode itself is also self-hostable. Equivalent
Console recovery/reconciliation controls have not been ruled out; comparative
operator effort, failure recovery and total cost must establish the benefit.
[Current official offerings and limits](evidence/cloudflare-harness-comparison-2026-11-14.md#product-overlap-update--2026-11-15).

**Broader harness comparison (2026-11-15).** Exo already combines Cloudflare
coordination, separate Linux execution and recovery; OpenHands supplies
self-hosted remote execution, persisted state, approvals and restart-persistent
budgets. LangGraph/Deep Agents, Claude and Codex also overlap session recovery
and operator controls. Open SWE's current managed-runtime application includes
usage recording and cautious handling of uncertain sandbox loss. Generic
self-hosting, durability and accountability are shared capabilities. The
candidate edge is the integrated Cloudflare operating experience, subject to
measured deployment/recovery/reconciliation effort and total cost. No absent
equivalent peer reconciliation contract or general superiority was established.
[Comparison, source evidence and proof criteria](evidence/r0-23-harness-edge-comparison-2026-11-15.md).

**Next bounded slice:** finish native fault/checkpoint controls, normalize
billing/infrastructure/operator measurements without replacing unknowns with
zero, and obtain a separate execution budget for the **150-attempt matrix**.
Native cancellation observed descendant progress after caller abort; fresh image
restart is not portable recovery. These limits remain open. C0/G0 closure and
any backend cutover require the full evidence/decision criteria below.

1. **Freeze the baseline and equivalences.** Compare Aboiteau with the current
   OpenCodeHarness plus a Linux sandbox supplying equivalent repository/file,
   shell, package and test access. Pin harness/runtime/image/model versions,
   model settings, repo/base commits, tool and network policy, resource shape,
   recovery points and cold/warm conditions. Prove the tool adapter fits before
   calling it a drop-in replacement. Name unsupported combinations and version
   differences; do not quietly substitute an easier DO-only JavaScript task.
2. **Reuse the representative matrix.** Use R0-2's at least ten predeclared
   tasks across at least two repos. Inject client disconnect, DO eviction,
   container loss, lost prompt acknowledgement and failed checkpoint at named
   boundaries. Compare accepted outcomes/checks, surviving files/history,
   duplicate external effects, held/unknown usage and operator interventions.
   A resumed transcript, restored file or successful interrupt acknowledgement
   alone is not task completion or exactly-once execution.
3. **Measure operating burden.** Extend R0-3 with cold/warm latency and
   model/container/storage cost per accepted task, startup/restore overhead,
   reporting delay, failures and operator time. Predeclare numeric decision
   thresholds and repetitions before execution. Keep every failed/refused/
   unsupported attempt in the appropriate reported denominator; explain workload
   or harness non-equivalence instead of producing a misleading average.
4. **Keep peers in scope without confounding the core test.** Exo is the
   independent orchestration peer; its basic/Codex loops are not assumed to be
   interchangeable with OpenCode. Pi/Think are alternative-loop references.
   OpenHands is a self-hosted remote-service reference; LangGraph/Deep Agents,
   Claude/Codex SDKs and Open SWE provide additional control/recovery/accounting
   comparisons, with their distinct hosting and runtime boundaries recorded in
   the broader harness evidence. Documentation/source overlap is not a runtime
   outcome, and this inventory does not authorize a larger live benchmark.
   E2B/Daytona compare execution/persistence guarantees and infrastructure
   burden; their memory snapshots cannot be equated with Aboiteau's portable
   file/history archives. Runtime tests of these additional systems need a
   specific unresolved decision; no vendor matrix is required by default.
5. **Record the decision.** Identify which custom components to retain, reuse
   upstream or reduce, with evidence against the frozen thresholds. Preserve
   ownership/ambiguity/settlement, secret placement, recovery and caller
   invariants. Retention may be justified by an operator outcome without a speed
   win; an adoption recommendation needs a separate bounded change and cutover
   review. Unavailable evidence leaves C0 open with named unknowns. Do not build
   a generic backend layer or launch a rewrite to perform this comparison.
   The separately user-directed PORT replacement has its own scope/gate in §5.6.

**R1-7a — prove the boundary before scheduling the fix.**
Start from the inspected Cloudflare runner and Exo external-injection patterns
in the comparison receipt. Validate provider/Git destination, path and operation
scope; hostname-wide injection is not sufficient repository authorization.
Keep credentials out of tool-visible files, environment, argv, process state and
internal APIs. The sandbox is the trust boundary; a different Linux UID or
permission glob is not a substitute. Inspecting an example does not qualify our
runtime, and external placement alone does not establish universal secret safety.

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

**R1-4c — reference CLI location (decided).**
The conformance client lives at `tools/cli` in this repository, not as a
published package: it exercises the public HTTP/SSE surface with the same CI and
fixtures as the service, and publishing can follow if external teams need it. It
is also the evidence that keeps R1-4e optional rather than load-bearing.

**R1-4e — opt-in MCP connector.**
Expose the caller contract as a Streamable-HTTP MCP server at `/mcp` so another
agent (OpenCode, Claude Code, Codex) can offload a turn and read the result.
`MCP_ENABLED` gates the endpoint and defaults off; `MCP_TOKEN` falls back to
`API_TOKEN` so the connector can be revoked separately. Tools: `submit` (returns
`{turn:{id,state,queuePosition}}` immediately — an MCP call cannot hold a coding
turn), `status`, `wait` (bounded poll ≤45 s), `read` (assistant reply for the
turn, from its stored baseline), `cancel`, `questions` and `answer` (the R1-4b
interaction surface). Tool results carry no credential, digest, queue id, R2 key
or reservation id. The connector is a client, not a second implementation: it
calls the same Conversation DO routes through the client module shared with the
R1-4c CLI, and passes the same conformance fixtures. Serve it with the stateless
`createMcpHandler` from `agents/mcp`; `McpAgent` is feature-frozen and would add
a Durable Object class and a storage migration for no benefit. The only new
dependency is `zod` declared directly (already present transitively) for tool
input schemas. It demonstrates G1-C's "public API or connector" but is not
required evidence for that gate; a deployment without MCP must still pass it.
Submit-side rate limiting reuses `enforceRateLimit` and every tool call is logged.

Locked defaults: `conversation` is a required argument on every tool, with no
environment default, so one connector can drive several conversations without
hidden routing; `wait` caps at 45 s with 1 s polls; `read` returns the assistant
reply the conversation still retains.

**Implemented (PR #16).** Stateless `POST /mcp`, off unless `MCP_ENABLED`, with
`MCP_TOKEN ?? API_TOKEN`; seven tools over the existing conversation routes, so
an MCP result cannot differ from an HTTP one. `read` reads the turn-correlated
event log rather than a stored baseline field. **Verified (2026-11-16), deployed.** No separate staging Worker exists, so the
run was against `cf-opencode.chester-hill-solutions.workers.dev` with
`MCP_ENABLED=1` and its own `MCP_TOKEN`. `tools/list` returned all seven tools
with `outputSchema`; `submit` dispatched, `wait` reported `completed`, `read`
returned the assistant reply (`pong`, `replay: retained`), `questions` returned
an empty list, and a second `cancel` correctly answered `409 already_terminal`.
The endpoint is live in the only deployment; disabling it is removing
`MCP_ENABLED`.

The shared bearer token is a **pilot stopgap**, not the target design. Cloudflare
documents remote MCP authorization as OAuth 2.1 (`OAuthAuthorizationServer` /
`OAuthResourceServer`, scopes per operation with `insufficientScope`) or
Cloudflare Access in front of the endpoint. Before any external team integrates,
put one of those in front of `/mcp` and give read and write tools separate
scopes; per-tenant identity (R1-6) is the prerequisite for real per-caller
tokens. Every tool declares `outputSchema` and returns matching
`structuredContent`, because strict MCP clients reject drifting results. The connector remains optional G1-C evidence — a deployment without
MCP must still pass that gate.

**R0-15 — one storage cutover, on the current artifacts.**
Re-state provenance: all earlier C1/C2 evidence used Stow 0.3.7 and `standard-1`;
the current image pins Stow 0.4.0 and the custom shape. Re-run the split
checkpoint/restore and Cloudflare/R2 cold recovery on the current pair. Complete
the recovery inventory: natural and escaped/reserved keys, object metadata,
unfinished multipart, background-writer consistency, registry identity. For each,
preserve, rebuild or refuse before mutation. Name retained/reset operator data in
the cutover receipt. Update README and runbook in the same change.

The first expanded live matrix is complete and failed: acknowledged metadata
does not round-trip Cache-Control, Content-Disposition or Content-Encoding.
The [downstream safe-refusal patch](evidence/storage-metadata-remediation-2026-11-14.md)
now rejects those unsupported properties before mutation, including malformed
multipart-selector fallthrough. Native CI and the corrected fixed live matrix
pass: 14 preserved and 3 safe refusals. This qualifies the safe-refusal contract,
not full metadata persistence. Keep the original failure receipt. Account-seed
isolation passed native smoke; live account-seed rehearsal and the production
retained/reset-data inventory still need current-pair cutover evidence. Keep the
successful 0.3.7 receipts historical.
The [prepared cutover runbook](runbooks/storage-cutover.md) retains operator data
and intentionally resets none; it is not production approval.

**Pre-merge non-Git checkpoint repair (2026-11-15).** The complete Bun gate
reproduced a same-size/unchanged-timestamp false fingerprint in a general
workspace. Controller source now streams content in 64 KiB reads, includes entry
type/mode/link identity, rejects changing files and delegates privileged reads to
the agent user through a fixed bounded helper. Deterministic regression failed
before the fix, then all 20 targeted and 618 full Bun tests plus 5 runtime tests
passed. The existing canary's frozen `a07c2d2d…` image has not changed; native CI
must build/verify this source before merge, and retained-workspace image upgrade
remains a separate rollout. Historical qualification pins/receipts are unchanged.
[Repair and boundary](evidence/workspace-fingerprint-content-2026-11-15.json).

**R2-9 — General workspaces and optional repository-to-PR workflows.**

**Disposable and net-new persistent work — IMPLEMENTED FOR THE INTERNAL CANARY (2026-11-15).**
Repository-free work is a first-class outcome, not a staging area that must
ultimately become Git. Start analysis, documents, scripts, experiments or a new
project in a blank general workspace. Keep work persistently without creating a
repository, commit, remote or publication. A friendly name identifies the
thread's work; multi-thread project sharing/catalogue remains a separate feature.

Default new and existing workspaces to persistent retention. Add explicit
persistent/disposable selection and optional naming with passive status, no
runtime/model call for metadata. A disposable workspace is recoverable while
active and is removed only through an explicit discard operation. No automatic
TTL, turn-completion deletion, `!leave` cleanup or inferred destructive intent.
Promote disposable work to persistent in place without copying files, replacing
workspace identity or resetting its session/history. Both modes may optionally
use repositories later.

Discard reuses existing cleanup/accounting/runtime/delivery/check guards. It must
refuse unresolved execution, holds, permissions or notifications. Persist a
request/expected-incarnation identity and receipt outside cleared workspace
state; a lost response or old retry must never delete later work. Status must
distinguish retained work from a running process. Working files, internal
session state and checkpoints are discardable; Slack messages, provider logs
and financial records are not erased by this operation. Qualification includes
mode/name retention, promotion preserving work, busy/pending refusal, faulted
cleanup recovery, duplicate/stale requests across later work, fresh-root binding
compatibility and an owned empty-workspace live control smoke. No existing user
workspace is discarded as verification.

Canary version `229d8fbb-1fda-41d1-9d19-60ad256d58e1` adds optional names,
persistent defaults, explicit disposable selection, in-place keep/promotion and
fenced discard through shared HTTP/Slack operations. No Git or repository is
needed for either kind of work. `!workspace` reports retained work independently
of whether a runtime is running. The native image and legacy Worker are
unchanged. **466 Worker tests**, **43 focused unit tests** and all type/config/diff
checks pass. The initial full run caught two reset/admission regressions; both
original serialization tests pass unchanged after the correction.

Actual DO fault tests cover inert prepared refusals, pending/alias recovery,
queued runtime denial after partial cleanup, lost completion acknowledgements,
old requests preserving successor R2 files, orphan permission refusal and
surviving command intake after failed initial reads. Retain minimal request,
alias and event-ID/time metadata, without command payload/name retention in the
intake markers. At-most-once Slack control intake may require a new command
when an early failure prevented execution.

A new owned empty Slack thread verified passive persistent defaults, naming,
disposable→persistent promotion with the same ID, explicit discard, a new
persistent successor, later naming and harmless exact old Slack/HTTP replays.
All transitions were read back from the actual bot thread. No runtime, model,
repository or user files were involved; no existing user workspace was removed.
Prior [native persistence/carry proof](evidence/workspace-first-2026-11-15.json)
continues to establish file/Git/session cold recovery independently of Git as a
prerequisite. [Live receipts, source identities and limits](evidence/workspace-retention-2026-11-15.json),
[workspace usage](runbooks/workspace-first.md). Broad product/security/runtime
gates remain open.

**Workspace first — IMPLEMENTED FOR THE INTERNAL CANARY (2026-11-15).**
The thread owns a general workspace independently of repository membership. A
repository is optional: start general work immediately, retain its files and
conversation, then carry requested work into an accessible existing or new
repository when the user instructs it. A project name is not a checkout or an
access grant. This supersedes the earlier no-repository prompt refusal.

The immediate implementation reuses `/workspace`, Stow workspace/state
checkpoints and OpenCode file/Git tools. Clone/create a repository in a workspace
subdirectory, preserve source work, report conflicts before overwriting, and
exclude workspace/runtime metadata from repository contents. Keep the same
session/history and require user instruction for publication. No root replacement
or automatic immutable-binding relaxation is needed. `!repo` remains an optional
fresh-root binding shortcut; its status/conflict guidance must permit continued
work and user-directed child checkouts in the existing thread.

A tool-managed child checkout does not automatically register a root binding or
qualify trusted committed-source `!check` evidence. Path-aware repository
registration/checks, structured transfer receipts, independently verified
conflict resolution and private credential support remain separate work. They
must build on workspace ownership instead of requiring users to discard earlier
work. Acceptance for the immediate correction: normal unbound Slack admission,
truthful context and controls, same-workspace file carry with originals retained,
Git state and Stow cold-restore proof, and a visible unbound Slack answer.

Canary version `d9b7fd15-3007-4354-952e-80961032acb3` removes the prerequisite,
adds truthful general-workspace/transfer context, and updates help/status/`!repo`
without weakening root binding guards or final reply recovery. **454 Worker
tests**, **25 focused command tests**, full typechecks, configuration and diff
checks pass. Offline qualification on frozen image `a07c2d2d…` carried three
selected files into a child Git checkout, preserved originals and a README
conflict, then removed the source before cold restore. Eight file digests, Git
HEAD/branch/uncommitted state, native workspace identity and the actual empty
OpenCode session/location matched after restore. Both owned containers were
removed. This qualifies authored primitive capability; autonomous transfer and
registered child checks remain unqualified.

A fresh unbound Slack thread received one real `opencode/deepseek-v4.1-flash`
answer with the workspace context present, no tools and a released hold
(**$0.00074171**). The original thread now displays general-workspace guidance
with its session retained and no model request. Owned test runtimes were
checkpointed/stopped to return capacity. The first fixture-permission failure
and the corrected live user-message assertion remain recorded; no prompt was
resent. [Usage](runbooks/workspace-first.md),
[verification and exact identities](evidence/workspace-first-2026-11-15.json).
G0/G1/G1-C/C0/PORT-G remain open; no broad release or private credential
qualification is implied.

**Slack repository/check workflow — DONE FOR THE INTERNAL CANARY (2026-11-15).** New root threads in
`#arfin-test` (`C0A5YNXLP6C`) after the fixed cutoff `1794776237.000000` use
`!repo`, bounded `!check` and `!checks` through the existing task operations.
A separate collector capability, one durable global attempt owner, encrypted
bounded logs and a durable thread outbox now connect committed-source export to
trusted execution evidence. Restart/lost-ack recovery cannot silently execute an
uncertain attempt again; cleanup-only reconciliation preserves its original
result. Proven benign control history permits fresh binding without adopting
unknown history.

The exact-baseline `15a916a` ingress patch retains legacy DO/image/storage code.
It validates the real Slack signature and delegates through a service binding
to independent canary Worker/DO/R2 state. Old threads, including old test-channel
threads, retain their backend. Ownership remains fixed through drain. No
production seed archive, conversation history or old accounting state was copied.
The owner explicitly authorized reusing only the local OpenCode key in this
canary; `opencode/deepseek-v4.1-flash` was verified enabled without inference.

Final gates passed **600 Bun tests, 432 Worker tests**, full type/config/UI checks,
and four isolated legacy Worker ingress tests. A real local Worker/DO/R2 → native
Docker collector → thread outbox smoke passed one execution, exact completion
replay, ordinary-token refusal and second-runner idle. The real Cloudflare canary
then passed the same committed-source check, confirmed cleanup, one-attempt Slack
result delivery and checkpoint/cold restore preserving binding, base, HEAD/tree
and historical source digest. The original observation timeout during a stalled
Slack app lookup remains recorded: its queued/null-attempt request was warmed
and completed once, without another check authorization. Slack readback verified
the passing result and final instructions in the authorized thread.

The owner explicitly approved installing the frozen login collector service.
It is running, and a separate authorized check was claimed, executed, cleaned up
and delivered automatically. The checker requires this Mac and Docker to remain
available; uncertain attempts still require explicit reconciliation. Fresh public GitHub tasks and dependency-free Bun
checks are the supported canary scope. Working edits, baseline checks,
test/config review, private repositories, dependency setup, full coding-task
success and publication are unverified or unfinished. No model inference ran.
See [release receipts](evidence/slack-workspace-checks-2026-11-15.md) and
[operator usage](runbooks/workspace-check.md). G0/G1/G1-C/C0/PORT-G remain open;
this internal canary does not authorize broad retained-data cutover.

**Post-canary credential repair — DONE FOR THE AFFECTED CANARY (2026-11-15).**
A human Slack request exposed provider `401 api_key_expired`: the copied local
key was expired although model catalogue selection had passed. A dedicated key
with Models: Request only, expiring 2027-02-13, is now connected and saved in the
encrypted canary seed. Authenticated issuer access, a real provider request, a
fresh harness text reply and original-session provider execution passed. The
original-session probe generated only tool activity and ended interrupted; it
did not verify a public answer or Slack delivery. Setup now
rejects expired OpenCode keys against its authenticated issuer before mutation;
model-list enablement alone is not credential readiness.

The explicit per-thread ID/CAS repair preserves custom keys, session, history and
workspace binding; encrypted key recovery and checkpoints before/after rotation
protect retries. Cold preparation verifies the selected credential digest.
Pending repair fences admission and cleanup. The owner-approved $0.10 hold was
released with permanent null actual cost, not zero. An existing one-time usage
boundary covers only that approved historical failed turn; future unpriced
failures still need separately qualified recovery. The original session passed
cold restore and priced execution, ending idle with no hold or permission pending.
Its unknown-cost receipt and original history remain intact. The diagnostic
model used tools despite a no-tools request; its unexpected permission was
rejected and the same verification turn steered to finish. This is not a claim
of instruction adherence, a visible Slack answer or task success. The follow-up
response-delivery repair below preserves final delivery ownership after
accounting settles. The later workspace-first correction supersedes its
repository prerequisite. Its live Slack answer readback is verified independently.

Canary version `2c48080c-649c-47c0-90f0-d332f6727fde` passed **442 Worker tests**,
five issuer-validation tests and full typechecks. Existing-object adoption took
the platform's deferred rollout window; do not equate Worker upload completion
with DO code readiness. [Exact repair receipts](evidence/opencode-key-repair-2026-11-15.json).
Legacy routing/images and other threads' credentials were not changed;
G0/G1/G1-C/C0/PORT-G remain open.

**Slack answer delivery — DONE FOR THE INTERNAL CANARY (2026-11-15).**
The affected Callcaster turn contained eight assistant steps with no public text:
tools searched an unbound workspace, then execution was interrupted. No generated
answer was available for Slack to send. The earlier credential receipt establishes
provider execution and accounting, not a visible answer or coding-task success.
The initial repair added a repository prerequisite for canary prompts; the user
subsequently rejected that product policy. The workspace-first correction above
supersedes that prerequisite. Its historical guidance/readback receipt remains
accurate for that deployment, not the intended current workflow.

Two separate real-orchestration regressions exposed dropped replies: a Slack
failure after hold release lost its reservation-fenced retry, and accepted-turn
bookkeeping recovery retained a prior content-deduplication marker. Final public
text and its immutable Slack destination now have a durable delivery intent,
created before hold release, with independent job ownership, restart/unseal
rehydration and acknowledged chunk progress. Delivery retries never rerun provider
inference or usage settlement. A successful terminal run with no public text
produces an honest fallback. Lost Slack acknowledgements can repeat an
unacknowledged chunk; exactly-once external delivery is not claimed. Limits are
96 KiB per reply, twenty pending replies and twenty recent acknowledgements;
exceeding a delivery limit refuses settlement before releasing the hold.

The full **453 Worker tests**, full typechecks, configuration and diff checks
passed. A final one-line correction bounds failed send attempts as well as
successful sends; the expanded delivery regressions passed **9/9** afterward,
with Worker-test types rechecked. Canary version
`54df8cc6-8036-4c56-bd7f-31af45affe8e` preserves the frozen runtime image and legacy
resources. A quiescent rollout used a 30-second deferred DO update. The original
unbound thread's guidance was read back with its session preserved and no model
admission. Both a pre-deploy and a post-deploy real `opencode/deepseek-v4.1-flash`
answer were read back from Slack in the same bound verification thread; the
post-deploy answer is a distinct new assistant/message with prior history
preserved. Each used one step and no tools, with a released hold. Combined model
verification cost was **$0.00139366**. [Visible post-deploy reply](https://teamnatelib.slack.com/archives/C0A5YNXLP6C/p1794783417771519?thread_ts=1794783182.886909&cid=C0A5YNXLP6C),
[diagnosis and verification](evidence/slack-reply-delivery-2026-11-15.json).
Callcaster has not been attached or worked on; private repository support remains
outside the qualified public-repository canary. Product gates remain open.

**R2-9.2 earlier direct-CLI increment — HISTORICAL LOCAL RECEIPT (2026-11-15).**
The later Slack/service-collector canary above extends this scope. At this earlier
checkpoint, immutable authorized check intent and encrypted
raw-object source export now feed an owned offline checker image and external
operator collector. New exports borrow an already warm, verified, idle workspace
without ordinary runtime preparation, checkpointing or idle renewal. Frozen
sources/status remain cold-readable. The collector owns credentials, journaling,
bounded logs, observed exit/timeout/OOM and confirmed cleanup outside the test
container. It records committed input identity and before/after HEAD freshness;
working-tree changes remain unverified. Existing output never triggers a rerun.
The service records `checksNotRun`; execution evidence has local-operator
provenance, with no caller-result upload or server-authenticated completion.
Final checks: **562 Bun and 409 Worker tests**, full type/config/UI gates and a
six-case real Linux control-export/CLI/checker smoke passed. Native arm64 checker
qualification retained the 512 MiB cap; emulated amd64 startup OOM receipts and
the metadata/proxy diagnosis remain visible. See
[evidence and exact source/image receipts](evidence/workspace-checks-2026-11-15.md)
and [usage/limits](runbooks/workspace-check.md). The smoke used a synthetic public
API fixture; production Worker behavior was separately tested. Baseline/check-
config comparison, service-authenticated completion, dependency setup, deployed
qualification and G0/G1/G1-C/C0/PORT-G remain open. No model inference occurred.

**R2-9.1 earlier public repository binding increment — HISTORICAL LOCAL RECEIPT
(2026-11-15).** The later canary above adds deployed public-binding/restore proof. Authenticated intent-only GET/PUT and a reference
CLI select a fresh task's repository, base and working branch. The controller
persists the binding before checkout and acknowledges the actual base commit
before session/provider dispatch. Identical retries retain identity; conflicting
checkouts are refused. Root-protected receipts and matching controller state
verify cold restore; account seeds exclude/reject task binding metadata.
The final gate passed **530 Bun and 394 Worker tests**, all typechecks,
configuration validation and UI build. The rebuilt Linux image passed public
clone, immutable base after a working commit, conflict refusal, split cold
restore and tampered-mirror rejection without model execution. See the
[evidence and exact image/source identities](evidence/workspace-repository-2026-11-15.md)
and [usage/limits](runbooks/workspace-repository.md).
This opt-in path supports fresh public GitHub tasks; existing unbound workspaces
retain their legacy behavior. Uncertain copies remain blocked, with no repair/
rebind endpoint. Private credentials, setup/check execution, review/publication,
deployed qualification and G0/G1/G1-C/C0/PORT-G remain open.

**Read-only preflight increment — DONE locally; captured image sequential smoke
passed, release qualification pending (2026-11-15).** A portable inspector, public passive GET endpoint and
local/remote CLI now report repo HEAD/branch, available tools, project metadata
and approval-required suggestions. Setup/checks remain `not_run`; working-tree
changes are explicitly unknown because Git filters can execute code. Cold API
inspection returns 409 without starting the runtime, touching admission or
renewing idle time. [Usage and limits](runbooks/workspace-preflight.md),
[verification/remaining boundary](evidence/workspace-preflight-2026-11-15.md).
The [image retry and memory diagnosis](evidence/workspace-preflight-image-2026-11-15.md)
retain the original failure and subsequent complete sequential pass. This is
local amd64 emulation evidence, not simultaneous-load or Cloudflare storage
qualification; later source changes require a new image receipt.
The preflight inspector itself does not implement setup execution, trusted checks,
review/revision or publication, and closes no G0/G1/G1-C/C0 gate.

User outcome: **choose repo → choose base branch → create working branch → make
and test changes → publish draft PR → receive URL**. Implement the smallest
supported GitHub workflow before external pilots. Design, fixtures and contract
work can start alongside earlier waves; live credential-bearing publication
depends on C0, R0-15, G1 and G1-C. This does not displace the current correctness,
storage and credential-boundary queue.

Remaining gap: `HarnessSettings.workspaceRepo/workspaceBranch` remain legacy
global defaults; the new opt-in binding snapshots defaults once and overrides
them for its task. The legacy path shallow-clones the configured branch and
wires its saved GitHub token only into that clone. Bound public checkout uses a
separate credential-free Git path. The image does not install `gh`; there is no
first-class scoped authenticated push/draft-PR operation. Local clone/binding
proof and shell permission prompts do not prove the complete workflow.

Deliver in these bounded slices:

1. **Workspace repository binding.** Accept an authorized GitHub repository and
   base branch per workspace, resolve and retain the base commit, and check out
   that identity into a fresh `/workspace`. Global settings may supply defaults;
   changing them must not switch another workspace's repo. Bind the repository,
   base and working branch to durable workspace state. Refuse a conflicting
   existing checkout before mutation. Fetch additional history only when needed
   for the supported task or comparison.
2. **Branch, changes and checks.** Create a new working branch, use the existing
   OpenCode turn/accounting engine for edits and tests, and record the resulting
   commit SHA plus check commands and pass/fail/skipped results. Preserve `.git`,
   workspace files and that binding across checkpoint/cold restore. A skipped or
   failed check must never be reported as passing.
3. **Scoped publication.** Use trusted service operations for authenticated
   clone/fetch/push and GitHub draft-PR creation through the R1-7 credential
   boundary. Repository-controlled code must not obtain tokens through files,
   environment, argv, Git config, logs, checkpoints or internal APIs. Enforce
   repository and new-branch scope, revocation and explicit publication authority
   at the service; permission-pattern strings do not supply that boundary.
   Return the repository, branch, commit SHA, draft-PR number and URL.
4. **Recovery and caller parity.** Persist publication intent/status before
   external writes. After a lost push/PR acknowledgement, reconcile the remote
   branch/commit and PR before retrying; return an existing matching PR rather
   than creating another. Unknown publication stays visible; no automatic prompt
   resend, force-push or broader repository fallback. Expose credential-free
   progress, checks, failures and the final PR URL through public HTTP/status/SSE,
   the reference client and Slack without duplicating execution/accounting.

Acceptance: deployed end-to-end runs on dedicated authorized public and private
test repos, using only public caller contracts; correct repo/base/branch and
resulting commit/PR URL verified; checkpoint/restore preserves the checkout;
lost push and PR responses do not duplicate publication; revoked credentials,
cross-repo requests, branch/base conflicts and insufficient permissions fail
visibly without overwriting unrelated work. Include repository-controlled
credential probes from R1-7, and record all attempts and check results. Local
fixtures alone do not close this slice or a product gate.

Initial scope is same-repository branches and draft PRs. Merging, force-push,
fork/cross-repository publication and an in-app Git review UI remain deferred.

**W4 — efficiency stays evidence-led.**
Keep the 1 vCPU / 2 GiB / 8 GB shape and 300 s idle window until SL-1.2/1.5
evidence says otherwise. Do not re-open the 30 s default; R3-6 is per-tenant
configurability, not the product default. Treat the Computer spike as a bounded
experiment behind C0, SL-A and SL-6.1, with the current container path retained as
fallback. No WASM/AgentOS rewrite, no stow POSIX shim, no snapshot-first recovery.

### 5.3 Start here — this week

Items 1–6 retain completed local evidence and outstanding rollout obligations.
R0-21 and R0-22 need deployed verification; native CI is recorded in the batch
receipt. R0-22's policy is confirmed as observe-and-alert with manual stop.
Independent R0-15 rehearsal work can continue alongside these.

1. **R0-17 — DONE locally**: reproduced both Slack post failures, fixed delivery
   isolation/backoff and passed the integrated gate. [Receipt](evidence/w0-correctness-2026-11-14.md).
2. **R0-18 — DONE locally**: both timeout paths, immediate paused-episode alerts
   and reservation-less success clearing are covered by passing regressions.
3. **R0-19 — RECORDED**: the synthetic current-image probe and raw result are
   committed with `7626726` as **KNOWN_OPEN_G1** evidence. Enforcement remains open.
4. **CI — DONE**: W0 `7626726` is pushed and native `check` + `container-smoke`
   passed in [run `43633250236`](https://github.com/chester-hill-solutions/cf-opencode/actions/runs/43633250236).
   This qualifies that source/image build, not the remaining live product gates.
5. **R0-15 — CORRECTED FIXED MATRIX PASSED**: downstream `metadata-refusal.2`
   rejects unsupported properties before mutation. Native CI on `fa5411b` is
   green, including all 351 Worker regressions and native smoke. The approved
   corrected live run passed 17/17 fixed outcomes (14 preserved, 3 refused) and
   cleaned up its temporary resources. [Remediation and receipts](evidence/storage-metadata-remediation-2026-11-14.md).
   Next complete the live account-seed rehearsal and review the production
   [retained-data runbook](runbooks/storage-cutover.md). It proposes no resets;
   production cutover and all product/security gates remain open.
6. **R0-21 — DONE locally**: durable notification acknowledgement/backoff now
   stays separate from pending authorization; failed requests retry across
   recreation without suppressing the batch or terminal settlement. Five new
   regressions and all 356 Worker/DO tests pass, with typing/config and 412 Bun
   + 5 runtime tests passing. [Receipt](evidence/r0-21-permission-delivery-2026-11-14.md).
   The native batch receipt in §5.4 covers the integrated repair; the bounded
   deployed Slack-delivery check remains owed.
7. **R0-22 — DONE locally**: policy confirmed as observe-and-alert with manual
   stop. Status preserves holds and distinguishes requested stop from unknown
   runtime stop and accounting settlement; deployed verification remains owed.
   R0-3 carries the budget-exposure measurement;
   neither diagnostic closes G0.
8. **R0-23 — four-cell smoke passed; C0 remains OPEN**: active OAuth selection
   and staging fixture authorization are fixed. Both arms passed L1/Q1 public
   tests and independent oracles; all runtimes/scopes cleaned. 27 completed
   provider requests estimate $0.0542769 for the final run; actual total operating
   costs remain unknown. [Evidence and limits](evidence/r0-23-smoke-2026-11-15.md).
   Finish native fault controls and prepare the full matrix under a separate
   budget. Matched-stratum equivalence and C0/G0 remain open; no backend cutover.
   Keep completed R0-20/R0-21 parity evidence. Complete C0 before optional backend
   or broad W5/R3 expansion.
9. **R1-4a**: circulate the seven decisions (including the delivery model) for
   API/product sign-off. No code until they are locked.

### 5.4 Active orchestrated batch — 2026-11-14

**Mission.** Deliver a substantial correctness and workflow slice using the
existing engine: durable multi-message delivery, truthful timeout/budget status,
and a ready encrypted account-seed rehearsal. This section executes the queue
above; it is not a second planning authority.

**Verified outcome.** Implementation and cross-owner review are complete. The user
confirmed observe-and-alert with manual stop as the timeout policy. FIFO,
explicit delivery, durable stop fencing, timeout status and the low-budget probe
pass the local gates. Steering acknowledgement proves inbox admission only:
`resume:false` prevents a fresh execution, but a run that finishes its final poll
can leave guidance pending until a later admitted turn. `consumed:null` records
that uncertainty; R0-20's stronger same-execution consumption guarantee remains
open for the stable caller contract and deployed verification. The account-seed
fixture passes offline types/bundling and safety contracts; live rehearsal and production cutover remain open.
[Batch evidence](evidence/orchestrated-delivery-batch-2026-11-14.md). Native
[CI 43649498746](https://github.com/chester-hill-solutions/cf-opencode/actions/runs/43649498746)
passed both `check` and `container-smoke` at `8e74638` (442 Bun, 5 runtime and
368 Worker/DO tests). Deployed checks remain open.

**Key results.** (1) FIFO accepts bounded follow-ups without new holds or lost
items and survives recreation; (2) queue/steer/interrupt agree over HTTP and
Slack with no ambiguous prompt resend; (3) timeout and budget exposure are named
truthfully and regression-tested; (4) account-seed fixture/evidence distinguish
synthetic/local, deployed and production guarantees.

**Locked boundaries.** One authoritative queue array, default capacity 10,
configurable 1–100; migrate the legacy slot without dual writers. Consume the
matching head atomically with dispatch intent, keep tails and retained holds on
ambiguity. Explicit replacement cannot discard an in-flight admitting head.
The user chose observe-and-alert at 15 minutes with explicit manual stop;
no automatic cancellation or spending-cap claim. Use the qualified
image and synthetic account data only for seed rehearsal; global legacy scope
is explicit, not tenant isolation. No real Slack messages, provider prompts,
production rollout or operator-data reset in this batch.

**Team pattern.** Two bounded parallel implementation streams plus a rehearsal
stream, then parent integration and one independent review. The parent owns
contracts, root HTTP/Slack integration, shared-file sequencing, canonical plan,
external-action review and final acceptance. Three persistent subagents use the
supported `gpt-6-luna` override at medium reasoning with fresh bounded briefs.
The parent model is fixed by this chat; no additional larger-model invocation
is planned. Escalate a specific unresolved design only after narrowing/context
fails, rather than reassigning whole features.

| ID | Deliverable / owned scope | Owner / dispatch | Depends | Done when |
|---|---|---|---|---|
| R0-20a | Queue schema/helpers, legacy normalization, pure regressions (`state.ts`, `queue.ts`, state tests) | queue_core / Luna medium | — | FIFO/full/replace/head fencing/legacy tests pass |
| R0-20b | Admission/drain/retry adaptation and budget dispatch wrapper, related Worker tests | same queue_core / Luna medium | R0-20a | Only matching head consumed; tails, retry deadlines and ambiguity retained |
| R0-20c | HTTP/default queue, explicit steer/interrupt, scheduler/recovery guards and Slack adapter | parent | R0-20a/b | Both transports use the same engine and explicit delivery; no second hold on steer |
| R0-20d | Slack command rendering/delegation and unit tests (`slack-commands.ts`) | exposure_contracts / Luna medium | contract lock | Queue depth/head and !steer/!stop follow-up match parent services |
| R0-22a | Pure observation projection/tests, parent status wiring | exposure_contracts / Luna medium; parent wiring | current policy | Threshold is not a stop claim; stale records cannot label another turn |
| R0-3a | Low-budget admitted-turn exposure regression | same exposure_contracts / Luna medium | — | $0.10 hold admits; sourced $5 actual records; next admission rejects |
| R0-15a | Fixed source/recipient encrypted-R2 seed fixture and safety contracts | seed_rehearsal / Luna medium | current artifact | No arbitrary exec/proxy, synthetic marker fidelity and distinct identity; limits explicit |
| R0-21v | Review prior permission repair and include it in integration verification | exposure read-only, parent acceptance | existing b71f1f9 | No concrete regression; local/native/deployed status separate |
| BATCH-V | Independent invariant review, integrated gate, receipts and backout | parent coordinates; reuse idle Luna context read-only | implemented batch | Consequential findings resolved, all required checks reported honestly |

**Verification/backout.** Focused regressions accompany each bounded edit; parent
runs the existing typing/config/Bun/runtime/Worker gate once integrated, then
repeats only affected checks after changes. CI and isolated live rehearsal require
concrete source/config/budget receipts and authorized upload destinations; no
release script is permission to deploy production. Never roll old singleton-only
code back onto a queue with multiple entries: preserve/export or drain it first.
Keep schema/retry migration limits and remaining R0-15/G1/G1-C/G2 gates open.

### 5.5 Active credential-proxy slice — R1-7a

**Mission.** Implement one usable provider boundary and a disposable native
qualification path: OpenCode uses a scoped proxy token, while the upstream key
stays in a trusted Worker. This is the first feasibility slice of R1-7a;
production migration and full R1-7 enforcement remain separate work.

**Implementation status.** The first provider slice is implemented and live
qualified at `ac5f9bf`: a real OpenCode streamed reply, agent-UID exposure probes,
default-deny network probes, fixed failure cases and a secret-free portable state
archive passed. Native CI passed 475 Bun + 5 runtime + 370 Worker/DO tests, all
typing/config/UI/offline checks and native container smoke. Cleanup of
all disposable Workers, container applications and synthetic secrets is confirmed.
This does not close R1-7a or G1.
[Evidence](evidence/provider-egress-prototype-2026-11-14.md) ·
[Live receipts](evidence/provider-egress-native-2026-11-14.json).

**Decision from current source/docs.** Use an exact virtual HTTP hostname,
`provider.aboiteau`, intercepted by a `WorkerEntrypoint`. Its only upstream is
`https://api.openai.com/v1/chat/completions`. Register the intercept before every
start with `enableInternet:false`. This uses Cloudflare's documented internal
[bindings gateway](https://developers.cloudflare.com/containers/configuration/workers-connections/)
and [outbound control](https://developers.cloudflare.com/containers/configuration/outbound-traffic/),
without adding TLS interception/CA changes to the pinned runtime image. Request
URL/Host, path, model, method, token and expiry are still checked inside the
trusted handler. Redirects never receive forwarded credentials.

**Upstream reuse check.** The inspected Cloudflare
[runner outbound handler](https://github.com/cloudflare/sandbox-sdk/blob/main/examples/coding-agents/runner/outbound.ts)
(blob `9cb80650360b188a3dcb431fd08ee3310a47685a`) already uses native
intercepts and Worker-side credential injection. Exo's
[network adapter](https://github.com/exoharness/exo/blob/1eeab021a854dc8db502d82b9fe656cbaf044671/exoharness/cloudflare/src/network.ts)
uses trusted identity props and manual redirects. Reuse that platform pattern;
the new code adds only the single-provider grant, request/model policy and
qualification checks. Guest HTTP terminates at the internal binding; credentialed
upstream requests are rebuilt with a fixed HTTPS destination. Broader component
reuse and comparative outcomes remain C0 work.

**Scope and finish line.** A fresh fixed qualification DO runs the current pinned
image, a custom OpenAI-compatible provider and a synthetic upstream. Actual
OpenCode output must consume the synthetic SSE; repository-controlled tests must
read the proxy token but find no upstream key in readable state/process data.
Portable state capture must contain no upstream key. Unmatched HTTP/HTTPS and
raw network probes must be denied under native egress policy. Fault cases cover
wrong scope/token/model/host, expiry, redirects and unavailable upstream. Streaming
must return incrementally, with cancellation and generic secret-free errors.

**Boundaries.** Existing seeds/checkpoints contain credentials; the proof requires
fresh state and refuses reuse. There is no silent archive migration, provider-key
sync or direct-network fallback. No real provider inference is needed: the
qualification upstream is deterministic and synthetic. Existing production
configuration stays outside this prototype. Short-lived proxy capabilities are
not long-lived provider keys; production renewal/restore and Git/package egress
are later R1-7a/R1-7 slices. No G1, tenant-isolation or general credential-removal
claim follows from mocked tests or an offline bundle.

| ID | Deliverable | Owner / model | Acceptance |
|---|---|---|---|
| R1-7a.1 | Scoped grant + strict streaming forwarder and Worker entrypoint | queue_core / persistent Luna medium | Synthetic auth/expiry/routing/model/redirect/error/SSE regressions |
| R1-7a.2 | Managed provider config and fixed agent-UID probe | exposure_contracts / persistent Luna medium | Valid installed-schema config; real key never a config/probe input |
| R1-7a.3 | Fixed native qualification DO, synthetic upstream, preflight and cleanup | seed_rehearsal / persistent Luna medium | Fresh-only, internet disabled, exact intercept, bounded actions/output; cleanup on manual/alarm paths |
| R1-7a.4 | Contract/integration review, required gate, CI and receipts | parent | Cross-owner findings resolved; local/native/live evidence distinguished |

**Verification and backout.** Pure protocol/config tests and credential-free
Worker tests precede native CI and any isolated live proof. Prepare concrete
source/config/resource/budget/cleanup details before an external upload. A live
run uses fresh synthetic secrets and disposable resources with a $1/30-minute
limit; it never touches production archives or real provider credentials. Remove
the qualification Worker/container and synthetic secrets afterward. Failed or
unavailable enforcement keeps R1-7a and G1 open; do not substitute an
Internet-enabled proxy and call the boundary enforced.

### 5.6 Cloudflare replacement — owned core, replaceable execution (PORT)

**Authority and status.** User-directed plan, 2026-11-15; no replacement code or
deployment has been performed. The clarified decision is: **OpenCode remains the
coding harness; we own supervision and workspace; execution runtimes stay
replaceable.** This is not an agent-loop, VM-kernel or general operating-system
rewrite. Fast lightweight startup is an explicit target, and so is not starting an
execution at all: a command the durable state can answer must never warm one.

**Harness-first execution split (2026-11-16).** The Durable Object owns the
conversation — state, queue, holds, accounting, commands. Linux owns code
execution — files, repositories, tools, and the model loop that drives them. A box
is an escalation, not the substrate. Today `!status` warms a container to print a
session title, and every turn needs one, so a cold or capacity-bound runtime turns
ordinary conversation into `Container busy`. Two slices close that: PORT-5c
answers harness-only commands from state, and PORT-7a serves chat-only turns
through a provider-neutral model port. Provider choice stays configuration, not
code: OpenAI-compatible is one adapter, and PORT-7 later replaces the transport
underneath. Neither slice may add a Cloudflare-only dependency to the conversation
core, and neither may fork the accounting path — a harness turn settles exactly
like an execution turn. Rivet/agentOS is a
runtime candidate/design reference, not the durable controller or workspace
authority. Commodity SQLite, Linux, language runtimes and standard protocols are
dependencies, not owners of product policy. No provider spend or infrastructure
purchase is authorized by this plan.

**Scope.** Replace every currently configured Cloudflare responsibility. First
qualify one team on one Linux host, one owning controller, private persistent
SQLite, native Stow, Vault, authenticated HTTP/SSE, Caddy and systemd. This has a
single-host failure domain; independent backup/restore is required and is not
high availability. Keep the existing Cloudflare installation supported until
cutover; do not operate two writers. Multi-host control-plane failover and shared
multi-tenant hosting require later evidence and explicit ownership design.

**Target relationships.**

```text
HTTP / reference client / Slack
              |
     Caddy -> Aboiteau controller
              |-- private SQLite: conversations, authority ledger, wake intents
              |-- Vault: encrypted credentials + separately held master keys
              |-- Stow: authoritative workspace + trusted encrypted archive store
              `-- execution adapter -> OpenCode coding harness
                        |-- native Linux profile
                        `-- qualified light profile (candidate, not yet supported)
```

Stow's native workspace exposes filesystem and local S3 access over the same
bytes. It does not supply distributed job ownership. Archive storage runs outside
the agent-writable workspace with separate credentials. A light profile must
preserve that authority, or explicitly detach, stop and hand off the workspace;
an independent virtual filesystem cannot become a second writable source.

**Component-by-component replacement.**

| Current responsibility | Planned replacement and code to reuse | Required proof |
|---|---|---|
| Workers HTTP/Slack/SSE + static assets | Our HTTP application on Bun, retaining `src/index.ts` routing/auth behavior and shared admission/control paths; Caddy provides TLS, static serving and reverse proxying | Same authentication, signature validation, errors and bounded SSE replay; disconnect does not cancel accepted work; trusted proxy headers cannot be forged |
| Conversation DO identity/storage/routing | Our conversation host and transaction-backed repository; extract composition from `src/conversation.ts`, reuse `ConversationStore`/pure decisions | Exclusive controller ownership, durable generation, restart reconstruction and per-conversation serialization; in-memory locks alone are insufficient |
| Global Settings DO | Our authority module backed by the private SQLite database; reuse settings, usage-source dedupe, reservations, leases and operator receipts from `src/settings-do.ts` | Cross-conversation spend/capacity decisions remain atomic; unknown markers and historical dates survive restart; no release on missing acknowledgement |
| Lifecycle SDK jobs / DO alarms / `waitUntil` | Our durable wake-intent table and bounded dispatcher; reuse job kinds, epochs, retry/backoff and recovery decisions | Domain state and required wake intent commit together; startup scans overdue work; stale jobs are fenced; timers/background promises are only wake optimizations |
| Cloudflare Containers + ports + snapshots | Our execution adapter using existing HTTP control contract; initial native profile via rootless Podman; evaluate embedded light runtime early | Generation-bound readiness, resource/network limits and confirmed shutdown; no VM-memory promise; snapshot caching optional and never the authoritative recovery path |
| R2 checkpoints/account archives | Our archive repository backed by a trusted Stow object service, with independent encrypted backup destination | Streaming get/put, size/metadata/head checks, listing/pruning, encrypted integrity and manifest publication qualified; same-host copies do not prove host-loss recovery |
| Optional D1 tenancy | Private SQLite identity/binding tables only if strict tenancy work is activated; otherwise keep dormant/remove it | No activation of incomplete tenancy or global-credential fallback; configured current installation has no D1 binding |
| Worker secrets + stored ciphertext | Our Vault backed by SQLite; master key delivered as a protected host credential; separately recoverable keys | Agent cannot read controller DB/keys; secret-free logs/exports; rotation and archive-key versions tested; encrypted storage alone is not credential containment |
| Provider Worker/RPC interception | Our trusted provider/Git broker and host-enforced execution egress | Fixed destinations/scopes, revocation and streaming; repository-controlled code cannot bypass broker or read long-lived credentials; retain R1-7a/R1-7 probes |
| Image registry | Verified, digest-pinned OCI archives loaded locally; optional standards-based registry for distribution | Fresh install works without Cloudflare registry or implicit pulls; provenance and image identity checked; light artifacts also pinned/verified |
| Wrangler build/deploy/config | Our release manifest, installer, schema migrations, systemd units and health/upgrade/restore commands | Fresh-host install, restart, upgrade and matched-data backout repeatable; no dependency on Wrangler at standalone runtime |
| Logs/traces/analytics | Our versioned correlated trace records, local query/export, private SQLite index + encrypted Stow bundles; journald logs and optional OTLP export | Operator can inspect/export offline without a vendor account; trace context survives queued work/restart; content/retention/access explicit; loss of diagnostic telemetry cannot lose authoritative usage/receipts |
| Rate-limit binding | Our authenticated-principal limiter; SQL-backed admission/quotas remain authoritative | Stable 429 contract, bounded limiter memory, restart behavior recorded; do not trust client-supplied forwarding headers; no platform DDoS-equivalence claim |
| Cron Triggers | Our persisted maintenance jobs; systemd timer can trigger an extra overdue sweep | Missed-run/coalescing policy explicit; no duplicate alert/maintenance effects or dependence on continuously alive process timers |

**Ownership and persistence rules.**

- Start with one controller process and an OS-enforced exclusive lock on a local
  database/host identity. Each workspace/execution also has a durable generation.
  Reconstruct and inspect existing executions before admitting replacements.
  Expired leases do not prove that old processes stopped. No shared-file SQLite
  across hosts, automatic failover or ownership stealing.
  Configure and qualify SQLite durability settings (including `synchronous=FULL`
  where required for acknowledged commits). Local commit durability does not
  cover loss of the host disk; PORT-0 must declare database/workspace backup RPO
  and restore-time targets separately. Workspace RPO is the last verified
  consistent checkpoint, not an assumed continuous copy. Freeze the retired-host
  retention window before cutover; no zero-data-loss/HA promise from local WAL.
- Commit a generation-bound creation intent before starting execution. Give each
  execution a discoverable immutable identity/labels so a lost create response or
  controller death before handle persistence can be reconciled. Inspect or
  quarantine an uncertain creation; never launch another writer because a local
  process handle is missing. Stop proof covers the execution/cgroup and its
  descendants, not merely the supervisor child exiting.
- Use explicit SQLite transactions for read/modify/write and domain-state/wake
  publication. Keep network calls outside transactions: commit intent, perform
  the effect, then record acknowledgement or uncertainty. Preserve the existing
  two-authority reservation handshake rather than assuming one DB makes a remote
  provider call atomic. `KeyValueStorage` plus process-local serialization is not
  sufficient as the complete replacement contract.
- Pass one transaction-bound repository/wake writer through mutations that must
  commit together. Current DO transaction joining is implicit; separate promise
  queues or separate SQLite connections cannot reproduce it. Inject failure
  between dispatch-state mutation and job insertion and prove both roll back.
- Preserve I1–I12, including bounded dedupe, unknown `null`, dated reservation
  ownership, terminal-usage acknowledgement, durable FIFO and privileged
  reconciliation. Runtime adapters report requested/observed stop separately;
  cancellation must account for descendants and external work.
- Keep DB, Vault, archive store, runtime-management socket and broker administration
  outside agent mounts/network reach. Expose only the scoped execution-facing
  broker endpoint to its authorized execution; it must not expose management or
  secret-reading operations. Retain honest one-team scope; rootless containers
  do not establish equivalent VM isolation or cross-tenant security.
- Preserve Aboiteau's full split workspace/state recovery format initially.
  Stow portable handoff defaults can omit `.git`/`.stow` and adopt a new identity;
  they are not a drop-in session backup. Publish a new manifest only after both
  encrypted parts verify; keep old manifests and handle orphaned uploads.

**Concrete extraction/restore handoffs.** PORT-2 splits portable job descriptors
from `LifecycleCapability`, supplies a host telemetry adapter, and separates the
router from CF class exports. Require an early model-free Bun import/start check
of the extracted supervisor/router without `cloudflare:workers` or `agents`.
Keep this check throughout PORT, not only during final decommissioning.

PORT-4 replaces `FixedLengthStream` with a counted standard stream or bounded
disk spool. Check declared length, truncation, excess bytes and cancellation;
unknown-length uploads must not buffer entire archives in RAM. Qualify the trusted
Stow object backend's actual archive/metadata contract and extend our primitive
if needed; the agent-facing Workspace S3 endpoint is not the archive store.
PORT-4/5a freeze guest workspace/registry/state paths, agent UID/GID and rootless
host mappings. Restore must preserve native Stow identity and working permissions,
or refuse an incompatible layout explicitly.

PORT-3/10 records legacy `ABO1` archive key references and original derivation
scope in an authenticated migration manifest: the archive header itself has no
key ID. Retain separately recoverable old keys or explicitly re-encrypt and
verify every retained archive before retiring them. Vault keyring rotation alone
does not migrate archives. Test old/new key restore and missing-key failure.

**Ordered implementation slices.** Each row requires an evidence receipt with
source/artifact revisions, commands, results and limitations. Sizes are relative,
not dates or completion promises. Core, storage, runtime, API/security and ops are
ownership roles; assignment happens when a slice starts.

| ID / size | Depends | Deliverable, touchpoints and acceptance | Owner |
|---|---|---|---|
| **PORT-0 / S** | Current source/invariant inventory | Freeze supported Linux architecture, data/release versions, API behavior, ownership/recovery contract, resource limits and threat model. Inventory existing data and needed keys without reading/exporting credential values. Freeze startup workload/thresholds below. Record authority/handoff decision; identify CF-specific assumptions before extraction. | core + storage |
| **PORT-1 / M** | PORT-0 | Implement transaction-backed conversation/authority repository, schema migrations, exclusive owner lock and generation checks. Extend `src/state.ts` and storage callers rather than emulate every DO API. Fault tests prove rollback, serialized mutation, stale-generation rejection, duplicate source handling and recovery after process kill. | core |
| **PORT-2 / M** | PORT-1 | Extract owned conversation supervisor and durable job dispatcher from `src/conversation.ts`, `admissions.ts`, `scheduler.ts`, `jobs.ts`, `event-stream.ts`. Same transaction commits required wake intent with state; startup sweeps overdue work; claims/epochs fence stale jobs. Prove accepted work survives controller death without prompt resend. CF-only Lifecycle classes remain in the temporary adapter. | core |
| **PORT-3 / M** | PORT-1, PORT-2 | Extract shared authority from `src/settings-do.ts`; attach portable Vault store and protected key delivery. Reuse usage/accounting/reconciliation/lease decisions. Test concurrent conversations, day rollover, unknown costs, duplicate usage, revoked authority and restarted holds. Serialize key rotation; preserve archive-key recovery separately. | core + security |
| **PORT-4 / M** | PORT-0, PORT-1 | Retain native Stow Workspace and full split archives; add trusted archive repository satisfying actual `checkpoints.ts`/restore needs, without R2 types. Test metadata/stream faults, partial uploads, corrupted/missing parts, failed keys and full restore on another machine. Qualify independent backup destination; do not expose it to agents. | storage |
| **PORT-5 / L, split** | PORT-0, PORT-2, PORT-4 | Define execution contract from `runtime.ts`, `readiness.ts`, control server, idle-close and upgrades. **5a:** native Linux adapter reuses existing OpenCode/Stow/control artifacts and proves restart/stop fencing. **5b:** early light-runtime qualification uses the same harness/task and Stow-authority requirements; record supported/unsupported tools and startup measurements. Ship only qualified profiles; no automatic broadening fallback. | runtime + storage |
| **PORT-5c / S** | PORT-0 | **DONE locally, 2026-11-16** — Harness-first commands: `!status`, `!stop`, `!help`, `!usage`, `!workspace*`, `!checks`, `!repo` answer from durable state with no execution running; session-dependent commands (`!sessions`, `!model`, `!answer`, `!cancel`, `!new`) say they need an execution instead of starting one. Acceptance: with no execution available each harness-only command answers in one round trip, `!status` reports `Runtime: cold`, and no lease, container start or checkpoint is observed. | core |
| **PORT-6 / M** | PORT-2, PORT-3, PORT-5a | Host existing HTTP/SSE and Slack operations through one engine; static assets/TLS via Caddy. Replace `waitUntil` correctness dependencies with persisted work. Test reconnect, approval delivery/retry, queue/steer/interrupt and slow subscribers. Preserve current public contracts; any R1-4 schema changes remain separately versioned/coordinated. | API |
| **PORT-7 / M** | PORT-3, PORT-5a; 5b for light claims | Replace Worker-specific provider egress with our trusted broker and execution-specific network enforcement. Reuse fixed-scope protocol and credential probes. Fresh secret-free execution; block direct bypass, redirects and cross-workspace access; exercise revocation and descendants. Inventory legacy credential-bearing seeds for explicit migration; never declare them safe by re-encrypting. | security + runtime |
| **PORT-7a / M** | PORT-0; PORT-7 for transport | Provider-neutral harness model port: base URL, auth style, request/response mapping and streaming are configuration; OpenAI-compatible is one adapter. Chat-only turns run in the harness through the port with the same reservation, accounting and settlement as execution turns; ambiguous turns escalate to execution. No provider host is hardcoded in `src/conversation*` or `src/provider-egress.ts`. Acceptance: two adapters (one synthetic) pass the same turn fixtures, harness and execution turns settle identically, and a misclassified turn escalates without double charging. | core + security |
| **PORT-8 / M** | PORT-3, PORT-4, PORT-6, PORT-7 | Deliver versioned install/release commands, Caddy/systemd configuration, verified OCI/software artifacts, protected secrets, rate limits, maintenance, local trace inspection/export, redacted logs/metrics/alerts and resource/disk caps. No mandatory registry, SaaS control plane or telemetry endpoint. An operator installs/backs up/upgrades/restores on a fresh Linux host. | ops |
| **PORT-9 / M** | PORT-1…PORT-8; light profile only after 5b passes | Run shared correctness, API/security and fixed fault matrix on standalone host; qualify startup/idle/memory/operator costs. Exercise real Linux processes, native Stow, archive service and restart boundaries with deterministic provider first. Any live provider test needs a separate recorded budget. Failures remain in denominators. | verification |
| **PORT-10 / M** | PORT-0 inventory; tooling after PORT-3/4; rehearsal after PORT-9 | Build privileged versioned export/import for conversation state, queue/approvals, ledger sources/holds/unknowns/receipts, settings, identity, checkpoints and key references. Map CF DO names/IDs and R2 keys without breaking reservation ownership or encryption scope. Rehearse on copies, compare counts/digests and prove unsupported/ambiguous records fail visibly. | core + storage + operator |
| **PORT-11 / S** | PORT-G below, PORT-10 rehearsal, current-scope security/release checks | Cut over once: freeze ingress/admission, stop or explicitly retain unresolved execution, prove no old writer, consistent DB/export + checkpoint backup, import/verify, then route callers. Retain unresolved work/holds without resending prompts. Record backout before and after first standalone dispatch; no stale-snapshot rollback. | operator |
| **PORT-12 / S** | PORT-11 + backout/restore drill + recorded retention window | Remove retired CF workers/DO/container apps/buckets/registry/cron/rate-limit resources only after retained-data inventory and recovery acceptance. Remove CF imports/build/config dependencies from supported release and CI. Verify supported startup/operation/restore with CF credentials and domains absent; retain historical receipts. | ops |

PORT-4 and PORT-5 qualification may proceed alongside core extraction where
their stated prerequisites permit. PORT-5b's model-free compatibility discovery
starts after PORT-0; full integration qualification still needs PORT-2/4.
Do not create both a Rivet controller and our
controller, a general multi-cloud SDK, or a new agent loop. An execution adapter
must preserve OpenCode behavior; an ACP/session wrapper is not assumed equivalent
to the currently pinned native server and durable usage log.

**API and migration details (PORT-0/5/6/10).** Preserve the native runtime-upgrade
API's `expectedPlanID` fence and digest-pinned OCI `targetImage`. A light profile
requires an explicitly versioned target/plan representation; never put a different
artifact kind in `targetImage`. Migrate or visibly block existing pending upgrades,
and verify restored session/history plus durable-event support before completing
one. Basic host extraction does not require new public message/status schemas;
R1-4 remains separately scoped.

Migration inventories must include separately persisted SSE `seq`/`events`, dated
`tombstones:*` with original retention, SDK-owned SQL wake jobs, pending runtime
upgrade/close intents, dedupe/usage cursors and permanent unknown/operator receipts,
not only `ConversationState`. Reconstruct jobs from supported intents with fresh
owner generations; do not copy SDK internals as an executable queue. Preserve
sequence continuity for existing `Last-Event-ID` clients, then test reconnect and
retry of a previously accepted request. Do not widen bounded dedupe into a
permanent exactly-once promise.

**Trace ownership — required product behavior (2026-11-15).** It must be easy for
an operator to own the records needed to explain an agent run. This includes
the execution timeline and available model/tool activity, not only infrastructure
spans. No Cloudflare dashboard, SaaS collector or external account is required to
capture, inspect, retain, back up or export the supported trace data.

- **Owned record contract (PORT-0/2).** Define versioned records with trace/span
  IDs, parent/link relationships, operation/attempt IDs, conversation/workspace,
  OpenCode session, reservation/job/runtime generation, timing, outcome and
  source sequence where available. Allocate/persist correlation locally even
  with tracing/export disabled; propagate context through our HTTP control
  calls and queued jobs. After restart, append a linked recovery attempt; do not
  pretend a crashed process completed its span. Validate incoming context and
  keep it separate from authorization. Use W3C Trace Context conventions and
  OTLP as an optional export protocol, not a supervisory dependency.
- **Coverage and honesty (PORT-2/5).** Correlate admission, queue/dispatch,
  OpenCode's exposed model/tool events, broker calls, approvals, Stow activity,
  checkpoint/restore, requested/observed stop and accounting/reconciliation.
  Capture available message/tool/usage identifiers rather than reconstructing
  missing events as facts. Record unavailable, omitted, truncated or dropped
  data explicitly. Owning traces does not grant access to a provider's private
  internals or make nondeterministic execution replayable.
- **Local operation (PORT-3/4/8).** Private SQLite holds the searchable index and
  bounded trace spool; Stow stores encrypted, versioned trace/payload bundles
  outside agent reach. An operator can inspect a run by ID, filter its timeline
  and export an integrity-checked bundle with a manifest, JSON/JSONL records,
  permitted payloads, artifact versions and capture/gap metadata. The index can
  be rebuilt from retained bundles. Ship one documented local inspect/export
  command; first acceptance is CLI/offline inspection, with no new dashboard
  platform required. Mark proposed commands as unimplemented until shipped.
- **Content and lifecycle (PORT-0/3/8).** Default to allowlisted operational
  metadata; captured prompts, completions, tool arguments/results and file
  contents require an explicit operator policy. Redact before persistence and
  export, bound payload/queue/disk sizes, and configure retention, sampling and
  deletion. Protect bundles/keys separately and scope access to the operator or
  authorized workspace. A trace ID is not a bearer credential. Trace deletion
  must not erase permanent accounting/reconciliation evidence or cross another
  workspace's data; migrations preserve trace references and retention policy.
- **Failure semantics (PORT-2/9).** Authoritative acceptance, usage and operator
  receipts remain durable under existing transaction/retention rules, separately
  from sampled diagnostic spans. Publish critical transition evidence through
  a transaction-bound local outbox; keep export asynchronous and idempotent.
  Remote collector failure cannot block execution or lose accounting. Local
  trace overflow/storage failure must surface a bounded, operator-visible gap
  with dropped-count/time information; if the authority DB cannot persist a
  required transition, normal admission fails closed. Never promise complete
  capture after a failure or sampling decision.

**Trace acceptance (PORT-9 / PORT-G).** With external collectors and Cloudflare
unavailable, run the deterministic task, approval, checkpoint, controller-restart
and ambiguous-dispatch cases. Locate each run locally and export/inspect its
timeline on a second machine without source-system access. Verify correlation
across attempts, ordering/gap metadata, content policy/redaction, access denial,
retention/deletion, index rebuild and encrypted backup restore. Stop the exporter
and exhaust its bounded spool: accounting remains correct and trace loss is
visible. Compare startup/latency/RSS with tracing enabled and disabled on the
frozen PORT workload; trace ownership must fit declared resource budgets.

**Current gap and standards.** `src/telemetry.ts` imports Cloudflare tracing and
returns no trace ID when that tracing is off. `src/conversation/telemetry.ts`
already provides a versioned allowlisted lifecycle envelope and optional sink,
while `src/log.ts` emits JSON lines. Reuse these paths, replacing platform context
and adding local persistence/correlation rather than building a second event
engine. These trace ownership features are planned, not present qualification.
[W3C Trace Context](https://www.w3.org/TR/trace-context/),
[OTLP](https://opentelemetry.io/docs/specs/otlp/),
[optional local Collector pattern](https://opentelemetry.io/docs/collector/deploy/agent/).

**Optional trace contribution for later training (TRAIN, 2026-11-15).** Offer a
separate, default-off permission to contribute selected traces for specified
Aboiteau model training/fine-tuning. Local trace ownership, ordinary operation,
support exports and evaluation do not imply training permission or upload. Do
not enable a cosmetic consent checkbox before the receiving/eligibility pipeline
exists. This optional track follows owned-trace capture/export; it does not block
PORT-G, authorize model training runs, or replace OpenCode as the harness.

**Operator opt-in intent recorded (2026-11-15).** The workspace operator stated
“Also we opt in to traces” for the active `#arfin-test` canary. Existing
operational tracing is already enabled; no capture policy was expanded. Record
this prospective participation intent in
[the operator receipt](evidence/arfin-trace-opt-in-2026-11-15.json). It is not an
executable training grant: eligible repositories/payloads, recipients and
retention/withdrawal terms remain unresolved, and the owned export/receiving
pipeline is unimplemented. No historical traces were selected, no training
upload or run was started, and no third-party provider training is authorized.
Resolve the remaining scope through TRAIN-0 before activating contribution;
this intent does not close TRAIN or owned-trace gates.

- **Specific choice and authority.** An authorized workspace/project operator
  chooses eligible repositories, content categories, recipients, stated training
  purpose, retention and whether future eligible runs may be contributed. Show
  this information at opt-in, independently of essential service terms. Keep
  evaluation-only use distinct from training use; no automatic permission for a
  third-party model provider's own training, redistribution or unrelated use.
  Check authority over code, conversations and third-party material; admin access
  or redaction alone does not establish all required rights/consents. Require
  suitable contribution terms/privacy review before external rollout.
- **No retrospective blanket grant.** Default to future eligible runs. Historic
  traces require separate selection/review. Local capture policy must explicitly
  permit any prompt/tool/code content needed for training; metadata-only traces
  are never silently expanded into full payload capture. Normal core/API use and
  local export continue when contribution is off or unavailable.
- **Controlled transfer.** Build a separate minimized/redacted contribution bundle
  from approved local traces; show what will leave the host. Initial delivery is
  explicit operator-reviewed export/upload. Automatic future delivery is a later
  explicit setting under the same scope checks. Keep project deny rules and
  exclusions for secrets, credentials and unauthorized/confidential content;
  scanning/redaction reduces exposure and is not an anonymity guarantee. Use
  authenticated encrypted transport and a separate receiver/store; owning local
  traces does not give Aboiteau remote access to them.
- **Provenance and eligibility.** Persist a versioned grant and revocation record:
  granting principal/authority, workspace/project scope, purposes, recipients,
  terms/policy revision, time/effective period and allowed payload classes. Bind
  each contribution to its bundle digest and receipt; retain derivation from
  source trace to sanitized sample, dataset snapshot and training/model version.
  Recheck current permission at export, ingestion, dataset assembly and job start;
  revoke queued eligibility on scope/permission changes. Quarantine missing or
  mismatched grants; never train from the operational trace archive directly.
- **Withdrawal and retention.** Off stops new contributions and future training
  eligibility for affected records. Define and implement deletion of retained
  contributed payloads/derived samples and backup expiry, while retaining only
  justified minimal consent/deletion receipts. Track already consumed datasets
  and trained model versions. Explain before opt-in how withdrawal affects each
  stage; do not promise that deleting a trace instantly removes its influence
  from already trained weights. Resolve trained-model handling and downstream
  processor obligations before launch, rather than treating opt-out as merely a
  UI flag. Local trace retention and central contribution retention are separate.
- **Useful learning data.** Where authorized, preserve task intent, exposed
  model/tool actions, final patch/artifact references, actual check results,
  human corrections and outcome labels, plus model/harness/policy versions and
  capture gaps. Distinguish observed success/failure from a self-reported agent
  claim. Keep training and held-out evaluation sets separated by task/repository
  to avoid learning/evaluating on the same contributed work.

| Slice | Depends | Acceptance |
|---|---|---|
| **TRAIN-0 — permission/data contract** | Owned-trace contract | Freeze purposes, contributor authority, recipients, categories, retention/withdrawal and rights terms; default-off configuration and project deny rules; no retroactive grant |
| **TRAIN-1 — contribution bundle** | Local trace export, TRAIN-0 | Operator can preview/redact selected content and explicitly export/upload; digest/grant bound to idempotent receipt; off/denied/unavailable sends nothing; failed transfer cannot block task execution |
| **TRAIN-2 — receiver and dataset eligibility** | TRAIN-1 | Separate store, access/retention enforcement and provenance index; fail closed on absent/revoked/wrong-scope grants; no operational-archive ingestion; withdrawal invalidates queued exports/dataset eligibility |
| **TRAIN-3 — qualification before offering opt-in** | TRAIN-0…2 | Synthetic end-to-end cases prove no upload/use when off, explicit historic selection, project isolation, redaction, revoke races, retry/dedupe, deletion/backup expiry and sample-to-dataset lineage; processing/notice terms reviewed; no real training needed to qualify contribution |

Design reference: Canadian privacy guidance calls for specific, understandable
collection/use/disclosure purposes and distinguishes optional uses from essential
service processing. This is a design input, not a finding of legal compliance in
every deployment or permission to use all trace contents.
[Meaningful consent](https://www.priv.gc.ca/en/privacy-topics/privacy-for-businesses/appropriate-handling-of-personal-information/collecting-personal-information-and-consent/consent/gl_omc_201805/),
[generative-AI privacy principles](https://www.priv.gc.ca/en/privacy-topics/technology/artificial-intelligence/gd_principles_ai/).

**Light-runtime and startup acceptance (PORT-5b).** Treat Rivet's compact runtime
as a technical reference/candidate outside the owned core. First qualify library
embedding (including its supported Node/Bun host), the pinned OpenCode execution
path, durable usage events, required shell/package/test operations, mounts,
permissions, symlinks, rename and SQLite state backup. A generic S3 mount does not
prove Stow-format or POSIX compatibility. Reject a profile that silently switches
the workspace authority or requires a new agent loop. Native-only commands may
use an explicitly selected native profile with fenced workspace handoff; an
unsupported command is visible, never an invisible widening of privileges.

Freeze at least 30 fresh-execution and 30 warm repetitions per compared profile,
same host resources/repo/restore bytes/harness, no provider needed. Measure runtime
creation, Stow-ready, OpenCode-ready and first useful command separately; report
p50/p95, RSS, failures and total host footprint. Proposed light target, frozen in
PORT-0 before execution: first workspace command p95 <=500 ms on a warm host with
cached artifacts; harness-ready p50 <=3.5 s / p95 <=5 s. Also report empty-cache,
new-host and restored-workspace costs separately. These are targets, not observed
results; a fast empty VM alone passes nothing. A failed light profile remains
unsupported and startup work stays open; native portability can qualify on its
own without being described as lightweight.

**PORT-G — standalone qualification and cutover gate (OPEN, not started).**
Require all of the following, with the supported execution profile named:

1. Fresh-host install and operation without Cloudflare or Rivet Cloud accounts,
   runtime credentials, endpoints or a hosted supervisory core; expected model,
   GitHub and explicitly configured connector traffic remains separate.
2. State + wake atomicity, controller kill/reboot, stale job/generation,
   lost dispatch/create acknowledgement, controller death with live descendants,
   failed whole-execution stop, failed checkpoint/restore,
   duplicate usage and unresolved-cost cases preserve I1–I12. Freeze case IDs
   before execution; raw receipts include unsuccessful attempts.
3. Native filesystem tests preserve `.git`, `.stow`, workspace identity, full
   OpenCode state and accounting references. Host-loss restore uses independent
   storage and separately recoverable keys; test missing/corrupt backups.
4. Public API/reference client and configured Slack behavior retain the same
   execution/accounting outcomes. Existing R1-4 and G1-C gaps remain named; a
   host move does not silently claim their completion. All existing required
   regression/build checks plus native host/runtime tests pass for changed code,
   following the host-specific gate transition in §7.
   Trace ownership/coverage, offline export, access/redaction, restart correlation
   and bounded failure behavior pass the trace acceptance cases above.
5. Real execution credential/egress and stop probes pass for the claimed profile.
   One-team scope is explicit. G1 tenancy claims still require R1-5/6/7/9; no
   rootless/WASM/security superiority claim follows from library docs.
6. Export/import ownership mapping, key recovery, consistent backups and backout
   rehearsed. Before new dispatch a quiescent original can be reactivated only
   after the target is fenced. After new dispatch, fence/stop target and migrate
   its latest authority/usage/unknown records back, or remain paused for operator
   reconciliation. Never reopen the old snapshot as an independent writer.
   Retaining unknown accounting/execution records does not authorize leaving an
   old writer running: if termination/exclusive handoff cannot be established,
   quarantine the old execution and keep replacement dispatch paused.

PORT-G does not close G0/G1/G1-C/C0. A controlled cutover needs current-scope
release checks; dependable-task/pilot claims retain their product gates. The
existing 150-attempt comparative matrix and its unapproved spend are unchanged.

**First actionable slice:** PORT-0, then a PORT-1/2 tracer: persist one synthetic
accepted request and wake intent, kill/restart the controller, observe it without
duplicate dispatch, and retain an unresolved reservation. In parallel after the
contract freeze, run model-free native-vs-light compatibility/startup probes.
Do not start with a broad file move or a Cloudflare-shaped API emulation.

**Design evidence, not a second schedule:**
[existing owned primitives](evidence/cloudflare-replacement-primitives-2026-11-15.md),
[standalone host research](evidence/cloudflare-replacement-host-research-2026-11-15.md),
[Rivet/agentOS layers and limits](evidence/rivet-agentos-replacement-fit-2026-11-15.md).

### 5.7 Product usefulness — complete the coding job

**Assessment (2026-11-15).** Portability, owned traces and optional contribution
enable the product. The next user-facing outcome remains R2-9: a request becomes
a checked change that a person can review and continue. That workflow is already
planned; refine its readiness, verification and revision acceptance below. These
are product hypotheses, not observed demand or implemented capabilities.

**Target experience.** Connect a repo, prove the environment ready, describe the
outcome and checks, work on an isolated branch, inspect the result/evidence, then
request a revision or explicitly publish a draft PR. Resume later at a known
commit or take a patch to a local checkout. Start with public API/reference CLI,
GitHub review and equivalent Slack outcomes. OpenCode remains the harness.

| Priority / parent work | Existing coverage | Missing acceptance to add |
|---|---|---|
| **1 — Repo readiness (R2-2/3/4, R2-9.1)** | General workspaces can start without a repository and carry requested work into child checkouts through agent tools; file/Git/session cold recovery and unbound Slack admission are verified in the internal canary. Read-only preflight and opt-in public root binding remain implemented; local sequential proofs and internal canary warm/cold binding/restore passed. Provider onboarding/legacy clone exist; private credential boundaries, setup and broader deployed qualification remain open | Extend readiness with approved setup/check commands and required services/network. Run authorized setup without service credentials, distinguish broken baseline from task regression, and invalidate caches by repo/lockfile/image identity. Measure ready-to-work time including clone/setup, not only VM boot; initial bound clone currently retrieves the selected branch's history. |
| **2 — Completion criteria (R1-4, R2-9)** | Public task repo/base/working-branch binding, messages and interactions exist; complete turn/status contracts remain planned | Add requested outcome, checks, constraints and publication authority to the bound task. Ask focused questions when needed; support investigation/plan before edits when requested. Use existing conversation/turn records. Results distinguish completed, partial, blocked and unverified work. |
| **3 — Exact-change evidence (R2-9.2, R0-2/3)** | Committed-object export, immutable intent, owned offline checker, separately authenticated service completion and durable Slack results implemented and verified in the internal canary. Warm-only export avoids ordinary preparation. HEAD stale/unknown and unverified worktree remain explicit; the approved login collector is running, with Mac/Docker availability required | Add baseline comparison, changed test/config review and independent CI/acceptance evidence. Preserve command/exit/log identity and confirmed cleanup for the exact committed input; subsequent edits must not inherit a current-pass claim. Dependency setup and broader runtime qualification remain separate. Passing repository-controlled commands alone is not complete correctness proof. |
| **4 — Review/local handoff (R2-9, R1-4c)** | PR URL and reference client are planned | Deliver base/head, focused diff/patch, rationale, checks, unfinished criteria/risks, cost/unknown usage and trace ID. Export a patch for a matching clean checkout; refuse dirty/base-conflicting application. Publication stays explicit. No in-app Git review platform required. |
| **5 — Requested revision (extend R2-9)** | Continuing sessions and publication reconciliation exist or are planned | Accept feedback against the same branch/PR, preserve context and produce a newly checked revision. Check remote head before writes; surface conflicting human edits. Feed authorized/deduplicated follow-ups through existing admission. No force-push, merge or unlimited self-repair loop. |
| **6 — Actionable status (R1-4b/c, R2-4, PORT traces)** | Queue, question/permission and recovery pieces exist; non-Slack parity is open | Show activity, last meaningful progress, blocker/waiting input, known/reserved/unknown spend and resume/stop action. Preserve work through steering and distinguish stop requested/observed/settled. Retain the user-confirmed observe-and-alert policy; no hidden automatic stop or hard-cap claim. |
| **7 — Project guidance (readiness/harness configuration)** | OpenCode documents project instructions, skills and integrations; our qualified configuration is narrower | Expose permitted repo guidance/skills/selected tools using the pinned harness, with effective configuration identity and visible missing capabilities. Store reusable knowledge as reviewed, versioned project guidance with provenance; no hidden cross-project memory. Add custom indexing only for measured retrieval failures. |

**Extend existing work.** Keep R2-9's four current slices and refine readiness and
check output above. Add **R2-9.5 review package/local patch handoff** and
**R2-9.6 caller-requested revision on an existing branch/PR**. The first revision
entry is explicit API/CLI input; automatic GitHub review/webhook ingestion is a
later scoped integration. Reuse the same workspace, queue, usage, trace and
permission contracts. Repository instructions/scripts remain untrusted inputs,
not authorization grants. No new task engine, agent loop, merge/force-push,
cross-repo publication or UI suite is introduced.

**Sequence and demonstration.** Continue correctness/credential repairs and the
PORT-0/1/2 core tracer. In parallel, design/exercise the shared R2-9 task/result
contract with deterministic providers and isolated fixtures. Do not wait for
complete host replacement to improve this workflow; qualify it on each supported
host. Live provider/publication and release/pilot prerequisites remain unchanged.

The first demonstration is one bounded bug fix: ready a repo, freeze base and
regression criterion, make the change, record checks, export a reviewable result,
accept a requested revision, and publish a draft PR only when authorized. Include
a controller restart and verify branch/evidence/trace/accounting continuity.
Repeat later without builder help. Local fixtures do not close a product gate.

**Measure usefulness (extend R0-3/G2).** Freeze tasks and acceptance before runs.
Report request-to-reviewable-change time, human intervention/review minutes,
accepted/partial/blocked/failed outcomes, revisions, setup/baseline failures and
full cost per accepted task, with unknowns and infrastructure explicit. Record
review rejection reasons and later reopen/revert signals; a merged PR is not a
correctness oracle. Keep failed/unsupported attempts in their proper denominator.
Existing independent install, later-day repeat use and non-Slack G2 criteria stay.

TRAIN follows useful permissioned traces and verified outcomes. Broad multi-agent
teams, custom context engines, arbitrary images, multi-repo changes and preview
platforms remain demand-gated. Browser/check artifacts for a web task can start
as bounded task outputs before building preview hosting.

**Evidence boundary.** Source inspection found onboarding/settings, global repo
defaults, shell access and lifecycle/accounting primitives, not the complete
task/review/revision experience. Upstream capabilities are reuse references and
must be qualified against our pinned integration:
[OpenCode instructions](https://opencode.ai/docs/instructions/),
[skills](https://opencode.ai/docs/skills/),
[MCP](https://opencode.ai/docs/mcp-servers/).
Iterative research/plan/diff/revision is also a peer capability, not a unique
feature claim: [GitHub workflow](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/research-plan-iterate).

### 5.8 Memory — soul, team, user, and a decision filter

**Authority and status.** User-directed, 2026-11-16. Design settled. MEM-1 deployed
2026-11-16 (inert until a decision credential is set); MEM-2 shipped 2026-11-16. Not a general memory platform, transcript search or context engine:
the session already owns compaction, and nothing here replaces it. Provider research
and API shapes: [decision-model providers](evidence/decision-model-providers-2026-11-16.md).

**Three layers, ordered by stability.** `soul` is who we are — voice, values and
boundaries — and lives in the repo as a reviewed constant, not in storage, because
character is a product decision and the agent may never rewrite it. `team` memory is
what is true about this place (environment, conventions, deploy traps). `user` memory
is who the harness is talking to (preferences, standing instructions). Team and user
memory are bounded records in the harness, injected by `buildPrompt` ahead of the
existing Slack and workspace context, so they answer while cold. Soul carries
instructions; memory carries statements, quoted as data. A remembered sentence never
gains authority over the soul.

**The filter is a decision model, not judgement prose.** After a turn, one typed
`Noul` question answers whether the turn states something worth keeping; a second
typed question picks the scope. The stored sentence is verbatim from the turn — the
model never authors memory — so a wrong accept is visible noise rather than an
invented fact. Provider: OpenCode Console System One (`jev-1.13`), through the
provider already configured; the neutral `DecisionPort` keeps OpenAI Decisions,
Cloudflare Clef and OpenRouter behind the same contract, and `rules` is the offline
fallback. Confirmed defaults: threshold `P(yes) ≥ 0.9` for unattended writes,
shadow mode first, no provider swappable without measurement.

**Constraints carried from this repo.** Writes are hard-capped with an error rather
than silent eviction; duplicates are rejected; entries are scanned for injection and
invisible characters; team writes require approval; each decision call is a spend and
therefore takes an auxiliary reservation with a per-turn token cap, recorded in the
ledger. Failure at any hop means no write and no turn impact. The call runs in the
harness, not through `src/provider-egress.ts`, which is chat-only by design.

| Slice | Depends | Work | Done when |
|---|---|---|---|
| **MEM-1 / M — decision port** | **IMPLEMENTED**; live proof pending `DECISION_API_KEY` | `DecisionPort` (`decide({state, questions})` → typed answers) with the System One adapter on OpenCode Console, `rules` fallback, and shadow recording. No host is hardcoded; the credential comes from the vault. | One real turn produces a `Noul` answer with probability and latency recorded; provider failure yields no decision and no turn impact; adapters pass shared fixtures. |
| **MEM-2 / M — memory + soul** | **DONE locally, 2026-11-16** — Soul constant; bounded team and user records in the Settings DO with provenance, caps, dedupe and injection scan; `!remember`/`!memory`/`!forget` (cold-capable, harness-only); `buildPrompt` injection in fixed order. | `!memory` answers with no execution running; soul/team/user appear in prompt order; cap overflow errors instead of evicting; no memory reaches the prompt as an instruction. |
| **MEM-3 / S — gated writes** | MEM-2 + shadow evidence | Candidate queue with `!memory pending`/`approve`/`reject`; unattended user-scope writes only after a shadow review shows acceptable precision. | Shadow decisions are reviewed against hand labels; auto-write stays off until that review is recorded. |

**Open questions.** Whether the existing Console key authorises `/systemone`;
whether gateway-served `gpt-6-luna-decision` and `gemini-decision-1` share Jev's
calibration; the retention of `jev-1.13-free`; and every request and response shape,
which is documentary only because research made no authenticated call. The first
adapter call settles the key question; the rest bind only the writes that rely on
them.

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
- Approval notifications recover from connector failure and restart (R0-21).
  Timeout policy is explicit (R0-22); overdue observation, requested stop,
  observed stop and settlement are not interchangeable. A $0.10 estimate never
  implies a provider-spend ceiling (R0-3/I4).
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
- At least one independent pilot completes R2-9's selected GitHub repo →
  workspace → tested branch → draft PR using only those public contracts, and
  receives a verified PR URL. Connector-specific access to server internals does
  not satisfy this requirement.
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

The commands below remain required while the Cloudflare adapter is supported.
PORT adds standalone controller/storage/native-runtime tests and the selected
light profile's compatibility checks; a shared-core change runs both supported
hosts' checks. At PORT-12, replace CF-only build/config/Worker test commands with
their qualified standalone equivalents and retire only tests for removed host
capabilities. Preserve shared domain, archive, API, credential and fault tests.
The final CF-free release must install/build/test without CF tooling or accounts;
historical CF qualification receipts remain evidence, not active dependencies.

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

**Comparative protocol (R0-23/C0).** Use the same inventory and cost record for
the equivalent Linux/OpenCode baseline. Freeze artifact/model/tool/repo/resource
conditions, success criteria, repetitions and decision thresholds before runs;
report unsupported or non-equivalent cases explicitly. Separate source/API
availability, local mocks, native runtime results and deployed task outcomes.
Keep maintenance/reuse recommendations distinct from demonstrated cost, speed,
security or coding-quality advantages. No comparative claim closes a product
gate, and no comparative decision alone authorizes a runtime cutover.

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
| `docs/evidence/code-assessment-2026-11-14.md` | **Local assessment evidence** | E7 permission-delivery failure, E8 observation-only timeout, E9 admission-budget exposure; 768 existing test passes and three diagnostic observations; no native/live gate closure |
| `docs/evidence/cloudflare-harness-comparison-2026-11-14.md` | **Comparative primary-source evidence** | E10–E12; upstream durable harness overlap, external credential placement, Exo peer and E2B/Daytona substrate boundaries; R0-23/C0 measurement/reuse decision; no benchmark or superiority result |
| `docs/evidence/r0-23-harness-edge-comparison-2026-11-15.md`, `r0-23-sdk-harness-peers-2026-11-15.md`, `r0-23-durable-harness-peers-2026-11-15.md` | **Broader harness primary-source comparison** | Exo, Cloudflare, OpenHands, LangGraph/Deep Agents, Open SWE, Claude and Codex overlap; integrated operating experience remains a hypothesis, with operator/recovery/cost proof criteria; no peer runtime qualification |
| `docs/evidence/cloudflare-replacement-primitives-2026-11-15.md`, `cloudflare-replacement-host-research-2026-11-15.md`, `rivet-agentos-replacement-fit-2026-11-15.md`, `cloudflare-replacement-plan-review-2026-11-15.md` | **PORT design evidence and plan validation** | Current Stow/Vault/control reuse, replacement-host requirements, lightweight-runtime limits and corrected migration/API/transaction handoffs; §5.6 alone owns status/order; no implementation or runtime qualification |
| `bench/comparison/README.md`, frozen protocol manifests, `docs/evidence/r0-23-smoke-2026-11-15.md`, raw live receipts and source archives | **Shared diagnostic inventory, code and live evidence** | R0-2/R0-3/R0-23 protocol, native tool/lifecycle qualification, retained failures/repairs and v11 4/4 model smoke; matched equivalence, full matrix, billing/infra/operator measurement and G0/C0 closure remain open |
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
14. **Custom orchestration versus upstream capability.** The baseline includes
    OpenCodeHarness plus Linux tools, not just a minimal Agent or DO-only file
    example. Existing FIFO/steer/interrupt and notification repairs establish
    parity; their completed status is preserved. R0-23 measures operator and
    recovery outcomes before expanding or replacing the supported stack,
    except the user-directed PORT track and its separate qualification gate.
15. **File/history restoration versus memory resume.** Compare the promised
    recovery boundary explicitly. Aboiteau's archives, container snapshots and
    E2B/Daytona memory-preserving modes are not interchangeable guarantees.

## 9. Deliberately not building

- Our own agent loop or model as part of PORT. OpenCode remains the harness;
  TRAIN plans optional trace contribution, not an authorized training run or
  harness replacement.
- Our own VM kernel or general-purpose scheduler. PORT owns only durable
  supervisory wake bookkeeping; execution runtimes remain replaceable.
- An unbounded execution rewrite, stow POSIX shim or full WASI/POSIX layer. PORT
  explicitly authorizes planning owned supervision and runtime adapters under
  §5.6; the separate Computer/workerd experiment retains SL-C/SL-D gates.
- Snapshot-first recovery or a second writable workspace.
- Per-tenant arbitrary Dockerfiles or broad image catalogues before G3.
- A general job/process manager, connector framework or large SDK before the
  public contract and reference client demonstrate the need.
- Billing, marketplace, managed hosting, previews or a Git review UI before their
  demand gates.
- A multi-tenant or credential-isolation claim before R1-5/6/7/9 pass.

## 10. Decisions locked by this revision

1. **One canonical plan**: this document; all others become evidence/design/research.
2. **W0 correctness first**: R0-17/R0-18/R0-21 repairs and the R0-20 delivery
   implementation retain their recorded local/native qualification; deployed
   checks and steering-consumption proof remain owed. R0-19 records the isolation
   gap as evidence, not a fix. R0-22 keeps the confirmed observe-and-alert/manual
   stop policy; observability is not cancellation.
3. **G1 order**: R1-7a before R1-7; R1-5/6/8 before R1-9; R1-3 before R1-4a.
4. **Caller contract**: lock the six R1-4a decisions before coding; bounded status,
   not a permanent receipt; snapshot output, not token deltas.
5. **Storage**: one supported native path; re-qualify on 0.4.0 + current shape;
   name retained/reset data at cutover.
6. **Sandbox**: keep the current container path and 300 s warmth until SL-A
   evidence or qualified PORT cutover; Computer spike stays bounded and optional.
7. **Truthfulness**: no gate closes on plans, builds, mocks or pattern strings.
8. **Comparative investment**: R0-23/C0 precedes optional backend and broad
   W5/R3 expansion; reuse R0-2/R0-3 evidence. Accounting/operator policy is the
   candidate distinction; generic durable harness features are parity. Retain
   the current production path until a separately reviewed cutover is justified.
   User-directed PORT is the explicit exception to the C0 prerequisite, not a
   comparative win or a product-gate closure.
9. **Owned core**: OpenCode remains the coding harness. Aboiteau owns supervision,
   scheduling, accounting and recovery; Stow owns workspace contracts and Vault
   supplies credential storage. Execution runtimes are adapters. Fast light
   startup is qualified end to end; no Rivet/agentOS supervisory core dependency.
10. **Owned traces**: local capture, correlation, inspection, retention and portable
    export are required. Optional OTLP/collector integrations never own the only
    copy; trace coverage/loss is explicit and accounting stays authoritative.
11. **Training permission**: optional, default off and separate from local capture,
    support and evaluation. Only authorized, specifically contributed data enters
    a provenance/permission-checked dataset; withdrawal and trained-model limits
    must be explicit. Owned-trace/PORT qualification never authorizes a training run.

12. **Useful coding outcome**: R2-9 owns the repo/task/check/review/revision path.
    Extend existing work with readiness, exact-change evidence, local patch
    handoff and requested revisions. Measure accepted work and human effort;
    portable hosting and training data do not substitute for task completion.

## 11. Change log

- **2026-11-15 (disposable and net-new persistent work)** — made repository-free
  work an independent product outcome; added names, persistent defaults,
  explicit disposable/keep/discard controls and durable replay protection.
  Full 466 Worker/type/config gates and 43 focused unit tests pass. Deployed
  only the internal canary and verified promotion/discard/successor replay in
  a new empty Slack thread without runtime/model/user files. No TTL or shared
  catalogue is implied; retained control records and external-history limits
  are explicit. Existing native persistence evidence and broad gates retained.

- **2026-11-15 (workspace-first correction)** — removed mandatory repository
  selection, added truthful general-workspace/transfer context and preserved
  existing work in repository controls. Full 454 Worker/type/config gates and
  25 command tests pass. Deployed the isolated canary, verified a real unbound
  Slack answer, and proved authored file carry/Git/Stow/session cold recovery
  offline on the frozen image. Root binding guards and trusted-check scope stay
  intact; nested registration, private credentials and autonomous transfer
  qualification remain open. Supersedes the preceding prerequisite policy.

- **2026-11-15 (Slack answer repair)** — corrected the earlier provider-only
  verification claim, required repository readiness before canary prompts, and
  added independent durable final delivery with chunk acknowledgements and
  restart/unseal recovery. Full 453 Worker/type/config gates passed; the final
  attempt-bound correction passed 9 delivery regressions and Worker-test types.
  Deployed only the isolated canary and read back distinct real model replies
  before/after deployment, plus repository guidance in the original thread.
  Callcaster remains unattached; broad release/product gates remain open.

- **2026-11-15 (read-only preflight implementation)** — implemented the portable
  bounded inspector, shared report validation, passive HTTP/DO/control route,
  local/remote CLI and usage/tests. Removed working-tree Git probes after a
  reproduced concurrent-filter execution risk; local changes stay unknown.
  Preserved frozen storage artifact pins/receipts and moved current-source
  rejection to the actual qualification preflight before side effects. Full local
  source/test/build gate passes; Docker image smoke is blocked by read-only build
  storage/100% host disk usage. No deployment, model call, publication or gate closure.

- **2026-11-15 (committed-check evidence)** — implemented immutable check intent,
  encrypted raw-object export, owned offline checker and local collector receipts.
  Final 562 Bun/409 Worker tests and six-case Linux smoke passed. Retained OOM,
  proxy and metadata deadline findings; removed duplicate Git verification and
  blocked implicit preparation/checkpointing through warm-only export. Baseline
  comparison, server-authenticated completion and deployed qualification remain
  open. No model inference, publication or deployment occurred.

- **2026-11-15 (public task repository binding)** — implemented intent-only API
  and reference CLI, durable immutable selection/base receipt, unprivileged
  public checkout, matching cold-restore proof and account-seed separation.
  Final checks: 530 Bun/394 Worker tests, full type/config/UI gates and rebuilt
  image binding smoke passed. Broader sequential native smoke also passed on
  its recorded image. Fixed metadata symlink races, Git worktree/ancestry
  ambiguity and non-idempotent repeated-`.git` URL normalization. No model
  inference, deployment, private credential boundary or release gate closed.

- **2026-11-15 (usefulness gaps)** — refined R2-9/R1-4/onboarding acceptance with
  repo readiness, completion criteria, exact-change evidence, review/local
  handoff, requested revision, actionable status and upstream guidance reuse.
  Added outcome/intervention measures and one bounded end-to-end demonstration.
  Existing host/security/pilot gates retained; no feature implementation, live
  provider run, publication, demand validation or comparative win claimed.

- **2026-11-15 (optional training contribution)** — added TRAIN-0…3 for a
  default-off, purpose-scoped contribution option, operator-reviewed bundles,
  consent/provenance checks, separate dataset eligibility, withdrawal/retention
  and synthetic qualification. Local ownership/use stays independent. No trace
  upload, permission grant, model training or harness replacement was performed.

- **2026-11-15 (trace ownership)** — made locally owned agent traces an explicit
  PORT requirement, with persistent correlation, versioned records, encrypted Stow
  bundles/index rebuild, offline inspect/export, payload/redaction/retention policy
  and collector/storage failure acceptance. Reuse existing lifecycle telemetry;
  no trace implementation or runtime qualification is claimed.

- **2026-11-15 (Cloudflare replacement / owned core)** — added PORT-0…12 and
  PORT-G with each configured Cloudflare replacement, private SQLite controller,
  owned wake intents, Stow/Vault reuse, native/light execution qualification,
  deployment/backup/security checks and fenced retained-data migration/backout.
  Incorporated user clarification that OpenCode remains the harness and execution
  runtimes stay replaceable. Superseded the blanket C0 prerequisite for this
  bounded user-directed track only. Source research/planning only; no replacement
  implementation, deployment, provider spend or gate closure.

- **2026-11-14 (comparative findings)** — added E10–E12 and the source-backed
  OpenCodeHarness/Cloudflare/Exo/substrate comparison. Scheduled R0-23 and C0
  within the shared R0-2/R0-3 measurement work before optional backend and broad
  W5/R3 expansion; strengthened R1-7a with inspected external-injection patterns.
  Preserved delivery-batch completion, confirmed timeout policy and native CI
  receipts. No comparative runtime result, superiority claim, rewrite, live run
  or product-gate closure is claimed.

- **2026-11-14 (R0-21 local repair)** — separated pending permission ownership
  from durable notification acknowledgement/backoff, isolated per-request failures
  from batch progress and terminal accounting, and pruned resolved/stale records.
  Five new regressions and all 356 Worker/DO tests pass locally. Existing
  assessment edits are preserved; no deployed repair or product gate claimed.

- **2026-11-14 (follow-up code assessment)** — added E7–E9 with reproduction
  details and local-check limits. Scheduled R0-21 as the next correctness repair,
  added R0-22 for explicit timeout/stop semantics, and expanded R0-3 to measure
  admitted-turn budget exposure. Preserved R0-17/R0-18 completion and the earlier
  native CI/storage evidence. No implementation, production rollout, hard
  provider-spend cap or product-gate closure is claimed.

- **2026-11-14 (R0-15 metadata remediation)** — added a source-pinned downstream
  refusal patch and SDK/selector regressions; native CI on `fa5411b` passed the
  complete consumer gate and independently verified the corrected binary hash.
  The corrected frozen image passed 17/17 live fixed outcomes. Recorded safe
  receipts and a no-reset cutover runbook; removed temporary resources. Live
  account-seed rehearsal and production cutover remain open.

- **2026-11-14 (R0-15 expanded live matrix)** — implemented the versioned
  17-case recovery probe, raw signed-path transport, imported synthetic history,
  bounded writer and registry fault recovery. Live Cloudflare/R2 preserved 14
  cases and safely refused 2 registry faults, but metadata failed before capture.
  Recorded both incomplete developmental local attempts and the live failure;
  removed temporary resources. Local Worker regression run had 5 timeouts and
  one assertion failure during host contention; it is not a green gate. No
  production cutover or product gate closure.

- **2026-11-14 (repo-to-PR scope)** — added R2-9 as the next product workflow:
  per-workspace repository/base selection, branch/edit/checks, credential-scoped
  push and draft-PR publication, recovery/retry reconciliation and HTTP/Slack
  parity. Scheduled before G2 pilots with R0-15/G1/G1-C prerequisites; added the
  public-API pilot acceptance criterion. No implementation or gate closure claimed.

- **2026-11-14 (R0-15 harness)** — centralized the frozen Stow 0.4.0 artifact
  pins, enforced the explicit custom profile, rejected stale receipts, and
  recorded requested resources with observed allocations unknown. Added the
  repeatable offline preflight and fixture coverage in the regular gate. All
  local checks passed; live qualification and production cutover remain open.

- **2026-11-14 (W0 native CI)** — pushed the specifically approved commit
  `7626726`; native `check` and `container-smoke` passed in `43633250236`.
  Canceled duplicate manual run `43633264827`. Later evidence/documentation
  commits remain local because upload approval covered only `7626726`.

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
