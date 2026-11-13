# Roadmap — from harness to product

**Product name:** **Aboiteau** — an Acadian tidal gate that lets the useful tide in and keeps the
destructive one out, which is roughly the job of a sandbox boundary.

**Product statement:** an operator-owned, durable coding-agent execution service on Cloudflare.
A team installs it in its own account, connects a repository and provider, and drives continuing
work through a public API or connectors. Slack is the first connector. OpenCode remains the
execution runtime; the service owns admission, persistence, accounting and recovery.

**Advantage to prove:** another application can integrate reliably, and its operator can deploy,
upgrade and recover the service with little intervention. Ownership and lifecycle handling are
implemented strengths; lower operating effort, lower cost and better coding outcomes remain
measurement questions. Tenant and credential isolation remain release gates, not current claims.

**Assumptions**

- One full-time engineer (the agent) plus a product owner at ~20% for decisions and dashboard work.
- Workers Paid plan; one Cloudflare account for staging and one for production.
- Local Docker may be unavailable; Workers Builds and a staging Worker provide the deployment
  validation path. Historical local container runs do not replace deployed-runtime checks.
- The commercial bet is the self-hosted / own-account segment, not a feature race with Devin or Cursor.
  If that bet changes, R2–R3 change; R0–R1 do not.
- One team per Cloudflare account is the first pilot topology. Preserve the tenant → agent identity
  model and G1 isolation requirements; managed shared hosting, billing and commercial signup are
  later work. Installing Slack is never required to deploy or use the public execution API.
- Pre-customer hard cuts are permitted (product-owner decision, 2026-11-12).
  Prefer one supported path over legacy copy jobs, dual-run deployments or compatibility
  adapters. Update internal clients and wiring together; reject unsupported old state
  explicitly. Name operator data to retain or intentionally reset before an actual cutover.
  Current-format recovery, isolation and truthful accounting remain required.

**Decision gates.** G0/G1/G1-C/G2 control dependent rollout milestones. A failed
gate blocks the corresponding expansion, not independent design or disposable
fixture work. G3 is an entry decision before broad sandbox investment, using
controlled pilot evidence even when G2 remains open.

## Current gate ledger

Updated: 2026-11-12. Status reflects recorded evidence and the active checkout;
this planning revision did not rerun deployments, provider tasks or live recovery.
Historical checkpoints are preserved in the [evidence history](plans/roadmap-evidence-2026-11-11.md).
Update this table with an evidence link when a gate changes; keep operational
receipts and test counts in their owning plan/runbook rather than appending status narratives here.

| Deliverable / gate | Current evidence | Remaining uncertainty / next action | Owner |
|---|---|---|---|
| R0-1 deployment path | Coupled Worker/image deployment and evented canary are recorded in the [Slack evidence](plans/slack-usability.md#current-evidence) | Recheck reproducible Workers Builds path and staging upgrade/backout; prior “deployment blocked” status does not negate recorded deployments | operator + platform |
| R0-2 / G0 tasks | HTTP and Slack text, question and permission round trips passed in the recorded evented rollout | Representative coding outcomes, injected-failure recovery and total cost per accepted task remain unverified | platform + operator |
| R0-10/11/13/14 repairs | [Local F1/F2 repairs](plans/r0-reliability-iteration.md) and subsequent evented canary evidence exist | Retain per-case limits; no universal legacy-accounting or recovery claim | platform |
| S8 reconciliation | [Completed approved retirements and original-DM migration](plans/operator-reconciliation.md); same session/history and a fresh reply verified; cap restored to 2 | No active holds in the recorded final check. One historical amount remains explicitly unknown; retain its permanent warning rather than treating it as zero | reconciliation owner + operator |
| S10 Slack images | [Deployed and live verified](plans/slack-usability.md#s10--image-attachments): exact PNG interpretation and text-only-model refusal | First slice remains one PNG/JPEG up to 5 MiB with immediate admission; durable image queues and multiple attachments remain deferred | connector owner |
| R0-15 workspace / recovery | [B2 native amd64 CI and C2 Cloudflare/R2 proof](plans/stow-workspace-integration.md): native startup, identity, bytes and content-type restore passed | Qualify additional S3 operations, unusual keys, multipart and active writers, then name the production cutover and retained/reset operator data | storage/runtime owner |
| R0-16 public replay | [Implemented and locally verified](plans/execution-service-delivery.md#r0-16-implementation-record): forwarding, public replay/reset tests and legacy-state inspection | Production rollout and stronger R1-4 recovery/status guarantees remain separate | API owner |
| R1 boundary / G1 | Per-conversation containers and optional namespacing exist; [boundary design](design/r1-agent-boundary.md) records credential/self-approval residual | Prove early egress feasibility, then scoped credentials, strict identity, quotas and cross-tenant failure probes | security + platform |
| R1-4 caller contract / G1-C | HTTP messages, permissions and SSE exist | Stable turn identity, neutral questions/cancellation/status, public replay and non-Slack client conformance remain planned | API + connector owners |
| R2 own-account pilot / G2 | Planned | Independent install, integration, repeat use and upgrade/rollback evidence required; Slack installation is optional | pilot owner + external teams |
| R3 demand gate / G3 | No configuration-demand pilot recorded | Collect blocked workloads before committing to catalogue, sizing or template-editor projects | product owner |

| Gate | Question | If no |
|---|---|---|
| G0 | Do representative coding tasks complete and survive defined failures, with correct admission/accounting and measured cost per accepted task? | Continue trusted-operator repairs; no broader rollout |
| G1 | Do credential, egress and strict tenant boundaries hold, including resolver outages and repository-controlled probes? | No external or untrusted-workload rollout |
| G1-C | Can a non-Slack client use stable turns, questions, permissions, cancellation, reconnect and recovery solely through the public API? | Fix the caller contract before external integration pilots |
| G2 | Can five external teams install in their own accounts, integrate, repeat work, and upgrade/restore without builder intervention? | Fix installation and operation before expanding scope |
| G3 | Before broad R3 investment, do pilot workloads demonstrate a need for specific image, size, workspace or network changes? | Retain supported presets and continue improving the execution service |

---

## Releases at a glance

| Release | Theme | Outcome | Estimate | Gate |
|---|---|---|---|---|
| **R0** | Dependable existing stack | Bounded reconciliation/storage repairs; coding-task and recovery evidence | Re-estimate remaining live work | G0 |
| **R1** | Safe execution service | Early boundary proof; scoped identity/credentials; stable caller contract and reference CLI | Re-estimate after boundary proof and contract inventory | G1 + G1-C |
| **R2** | Own-account installation and operation | External teams install, integrate, repeat work and upgrade/restore unaided | Re-estimate after reference-client conformance | G2 |
| **R3** | Demand-led sandbox options | Implement configuration changes justified by pilot workloads | Commit slices only after demand evidence | G3 before investment |
| **R4** | Optional product expansion | Git review UI, connector ecosystem, billing, compliance, managed hosting | Unsized; separate demand decisions | — |

The earlier calendar and release estimates are superseded. Set dates after measuring the
remaining R0 work, resolving the credential/egress feasibility proof and scoping the caller
contract. Gate order constrains rollout, not all development: contract design, disposable
fixtures and reference-client work may proceed while live checks await their prerequisites.

**Sequencing note.** The current configuration already selects `durable_object`, and the
code implements per-conversation containers, snapshots, inactivity handling and global leases.
Deployment/cutover verification remains in R1-2/R1-3; configuration alone does not close G1.
R1-4 now owns the caller contract and non-Slack proof as bounded slices, followed by audit 24's
extraction of existing `ContainerRuntime` / `EventStream` responsibilities under regressions.
It does not add a job engine or new runtime. R3 adds only demonstrated configurability.
See the [execution-service delivery plan](plans/execution-service-delivery.md).

## Runtime direction — retain the current stack

**Decision — 2026-11-11, confirmed by the product owner:** retain OpenCode in
Cloudflare Containers, the stow-s3 hot workspace and R2 recovery checkpoints.
Prioritize R0 reliability and measured recovery, R1 tenant/credential isolation,
then R2 onboarding. No alternative-runtime prototype is scheduled.

**Stow integration evidence — 2026-11-12:** native Workspace startup now passes
the full rebuilt-container smoke on native amd64. An isolated Cloudflare test
restored the same identity, exact file/S3 bytes and content type from encrypted
R2 archives after destroying the old container, without snapshots or model calls.
Production cutover, additional S3 operations, unusual keys, multipart and active
writer consistency remain open under R0-15.
See the [integration plan](plans/stow-workspace-integration.md).

The [runtime feasibility research](plans/wasm-sandbox-feasibility.md) remains a
reference for a later decision. Moving the OpenCode loop into a Durable Object,
adding isolate/JavaScript/WASM execution, adopting AgentOS or Cloudflare Computer,
and replacing the workspace backend are deferred. R1-4 extracts the current runtime
and event responsibilities; it does not introduce a generic backend framework.
The earlier suggestion to spend two days on a prototype is superseded.

Borrow useful AgentOS concepts through the existing stack and release sequence:

| Improvement | Existing work | Reviewable outcome |
|---|---|---|
| Inspectable work | R1-3/R1-4 caller contract and reference client; R2-4 consumes it | Stable turn references, runtime generation, running/finished/interrupted/unknown status, bounded replayable output and explicit cancellation results. Retain OpenCode's job/process ownership. |
| Clear recovery status | R0 recovery evidence; R1-3 lifecycle; R3-6 configurable policy | Show the last verified checkpoint and what was restored; distinguish recovered files/history from interrupted processes and uncertain side effects. |
| Scoped capabilities | R1-7 credential injection and egress | Enforce access outside repository execution; keep provider/git credentials outside that boundary and verify using repository-controlled probes. |
| Explicit resource limits | R1-8 quotas; R2-4 visibility; R3-9 per-sandbox controls | Bounded storage, output and execution lifetimes, with a named limit, observed usage and actionable warning/failure. Keep model admission estimates distinct from enforced caps. |
| Reproducible configuration | R1-4 applied identity; R3-1/R3-8 configurable policy if demanded | Record credential-free applied settings/image/runtime identity per turn now; add validated SandboxSpec changes and saved-versus-running controls only when required. |

These are planned acceptance details, not claims of implemented job APIs or closed
release gates. Apply each through a bounded slice of its owning ticket; do not delay
isolation or onboarding for a broader process manager. Previews remain R4 work.

### When to reconsider execution backends

Reopen the investigation only when repeated representative workload measurements
show container startup materially breaches the agreed turn-latency target, idle
container cost breaches the operating budget, or container capacity/admission queues
prevent required concurrency after tuning the existing lifecycle and limits.
Record the baseline, affected workloads and target improvement before selecting a
runtime. Existing R0-3/R2-6 measurements provide the evidence; vendor benchmarks
and technical feasibility alone do not trigger a project.

A future prototype must compare the same tasks against the current stack and
preserve isolation, storage/recovery behavior and required tool compatibility.
Evaluate the smallest suitable backend, including native JavaScript isolates,
before investing in a full WASI/POSIX environment. This revisit gate adds no release
dependency or delivery date to R0–R3.

---

## R0 — Dependable existing stack (current work)

**Goal:** fix the reproduced reliability defects, then prove task completion, recovery and
cost with a real container. Keep the first rollout scoped to a trusted operator and trusted
repositories until R1-7 removes long-lived credentials from repository execution.

| ID | Ticket | Size | Owner | Status |
|---|---|---|---|---|
| R0-1 | Verify reproducible Worker/image build, staging upgrade and backout; retain Workers Builds setup where needed | S | user + agent | **partial**; deployed canary recorded; reproducible build/staging rehearsal remains open |
| R0-2 | Representative coding tasks through Slack/HTTP; verify accepted changes, checks, restore, model usage and interventions | M | agent | **partial**; text/question/permission canaries passed; coding-task and failure-recovery matrix open; storage-dependent evidence requires R0-15 |
| R0-3 | Extend `bench/measure.ts` + `bench/container.sh`: cold/warm latency, checkpoint/restore, recovery time, interventions and total cost per accepted task | M | agent | simple-turn instrumentation exists; representative outcomes and operating-cost baseline open |
| R0-4 | Slack cutover: Event Subscriptions + Interactivity URLs, Socket Mode off, stop launchd bot | S | both | **done for the scoped trusted-operator cutover**; commands, replies, question/permission controls and images verified; S8 retired both approved holds, preserved the original DM and restored cap 2. One accepted historical unknown remains visible. This does not close G0 or the broader product gates |
| R0-5 | Audit 22: explicit conversation state machine (`idle → admitting → running → settling → idle`, guarded transitions) | M | agent | **done** |
| R0-6 | Audit cluster 1: performance pass (hot paths, SSE fan-out, R2 sizes) | S | agent | **done** (findings 25–28) |
| R0-7 | Finish audit 23: turn latency, queue depth, checkpoint bytes, failure classes | M | agent | **done** (OTel export deferred) |
| R0-8 | Handover: README limits, runbook, cost-per-turn note | S | agent | **partial** — runbook present; measured cost per turn remains open |
| R0-9 | ~~Audit 24~~ | — | — | moved to R1-4 |
| R0-10 | Audit 29: classify actual split-archive names, protect all objects referenced by the active manifest, and reject incomplete split restores | M | agent | **done locally**; deployed/container verification remains open |
| R0-11 | Audits 30–31: atomic owned hold, durable accounting/cutover, terminal-usage release, permanent retirement and guarded recovery inspection/actions. | M | agent | **partial**; original 30/31, F1 and scoped F2 verified locally; unprovable legacy/manual cases, actual cutover and deployed-container/model checks remain open |
| R0-12 | Audit 32: record the trusted-repository rollout boundary and add a synthetic repository-code probe; track credential removal in R1-7 | S | agent | **documentation/probe evidence done**; audit 32 credential isolation remains open until R1-7 |
| R0-13 | Audit 33: controlled 400 responses for malformed JSON/body shapes across HTTP JSON routes | S | agent | **done locally**; deployed verification remains open |
| R0-14 | Retain the assessment reproductions as regression tests; cover retention, queue recovery, concurrent reservations and malformed input | M | agent | **done locally**; broader G0 criteria remain open |
| R0-15 | Native Stow Workspace startup/readiness/identity and disk ↔ S3 plus encrypted R2-only cold recovery; legacy retention only for named operator data | M | agent | **B2/C2 bounded proofs passed**; native amd64 CI and isolated Cloudflare recovery verified. Production cutover, further S3 operations, unusual keys, multipart and active writers remain open in the [canonical plan](plans/stow-workspace-integration.md) |
| R0-16 | Forward the public SSE reconnect cursor; regress replay, expired-cursor reset and recovery from current status | S | agent | **implemented and locally verified**; route/README/public tests pass the integrated gate. State inspection remains separate from replay; production rollout and the stronger R1-4 recovery contract remain open |

**Exit criteria**

- A Slack mention produces a real reply, and the same turn works over HTTP/SSE.
- A stated set of real coding tasks meets observable outcomes (files changed as requested,
  relevant checks pass, and changes survive a container restart); report successes/total,
  model/version, cold/warm conditions, latency and provider-reported cost.
- Cold start, checkpoint and restore numbers exist in `bench/RESULTS.md`.
- Freeze representative tasks, observable acceptance, fault cases, runtime/model versions and
  numeric evaluation thresholds before live execution; report successes/total, retry/intervention
  counts, recovery time and known versus unknown costs. A `READY` reply is a connectivity check.
- Public SSE reconnect after event N returns later events only; expired history yields an explicit
  reset and a documented current-state recovery path. No reconnect automatically resends a prompt.
- R0-15 proves direct files and S3 use the same registered Workspace, with reported
  readiness configuration and no lost supported data after R2-only cold recovery.
  Preserve OpenCode state and Git data; full-disk snapshots cannot substitute for this check.
- `bun run typecheck`, `check:config`, unit and workerd suites green.
- Local R0-10/R0-13/R0-14 regressions and the original R0-11 audit 30/31 reproductions pass;
  remaining manual F2 cases and live cutover/container evidence remain open. Every active checkpoint
  object survives local cleanup tests.
- Reservations cannot block their own queued retry or pass the available admission budget
  concurrently. A fixed reservation is not a hard cap on an already-running model turn;
  document that remaining spending limit and measure actual turn cost.
- Audit 32 remains an explicit trusted-operator/trusted-repository limitation until R1-7;
  no untrusted-repository or tenant-isolation claim before G1. Audit 24 stays in R1-4.

**Verification limits:** the assessment's Docker limitation and synthetic settings-browser
checks remain scoped to that assessment. Later image/canary deployments and text/button
outcomes are recorded in the [current gate ledger](#current-gate-ledger) and linked evidence;
they do not establish representative coding effectiveness, full recovery or operating cost.
Do not infer a fresh deployment verification from this planning update.

---

## R1 — Safe execution service

**Goal:** verified per-conversation lifecycle, scoped configuration/identity/credentials, and a
public execution contract that another application can use. Prove the documented threat-model
boundary before external or untrusted-workload rollout; preserve explicit residual risks.

**Why now:** containers are namespaced per conversation in the current code, but settings,
HTTP authorization and default account onboarding remain global. Optional channel/agent
namespacing does not provide a complete tenant boundary. A second team must not inherit
another team's configuration or credentials.

| ID | Ticket | Size | Depends |
|---|---|---|---|
| R1-1 | Stable checkpoint keys — **partial:** split archives/manifest and local retention/restore repairs are verified; implement the target layout directly. Legacy copy job only for named data to retain | S | R0-10 |
| R1-2 | Verify deployed `durable_object` policy and replacement-app cutover — configuration and code already use the policy | L | R1-1 |
| R1-3 | Verify per-conversation lifecycle — start/snapshots/inactivity/global leases implemented; deployed isolation and inspect/monitor work unverified. Inspection should identify the current runtime generation, active turn and last verified recovery point. | M | R1-2 |
| R1-4 | Public caller contract, neutral interactions, reference CLI and protected runtime/event extraction; slices R1-4a–R1-4d in the [delivery plan](plans/execution-service-delivery.md#r1-4--public-caller-contract-and-connector-proof) | M slices; re-estimate total | R1-3 for runtime proof; design/fixtures may start earlier; external use requires G1 |
| R1-5 | Tenant model + tenant-scoped configuration — **partial:** D1 schema, channel resolver, conversation namespaces and per-agent account-seed keys landed; per-agent Settings/API keys/strict mode open. Missing/invalid/unavailable resolution cannot select legacy identity in strict mode | L | R1-2 |
| R1-6 | Per-tenant API keys (hashed, revocable) and auth middleware; retire the shared `API_TOKEN` for tenants | M | R1-5 |
| R1-7 | Audit 32: default-deny egress + external model/git credential injection; early R1-7a feasibility proof, then enforcement and repository-controlled credential/escape probes | L; bound proof first | R1-7a uses disposable current runtime; full enforcement requires R1-3; before G1 |
| R1-8 | Concurrency caps and quotas per tenant (containers, minutes, storage), with named limit/usage in rejection and status responses | M | R1-5 |
| R1-9 | Isolation tests: two tenants, cross-tenant probes (checkpoint, SSE, settings, container) | M | R1-5 |
| R1-10 | Single cutover to the supported version, coupled-client checks and backout to a matching recovery point; no mandatory dual-run | S | R1-2 |
| R1-11 | Rename the deployment to Aboiteau during the v2 cutover: Worker name, package, repo, URL, Slack app URLs, secrets | M | R1-10 |

**Exit criteria (G1)**

- Two conversations in two tenants run at the same time in separate containers.
- A probe from tenant A cannot read tenant B's state, events, checkpoint or repo.
- No global `Settings` singleton in the request path; a spec change restarts only that sandbox.
- Egress: a sandbox cannot reach a host outside its allowlist; no provider token is readable inside it.
- Execute repository-controlled test/typecheck code that tries to read synthetic credentials;
  verify the boundary using OS/network enforcement, not just permission-rule strings.
- Strict resolution handles absent, unknown, invalid and unavailable identities explicitly.
  Resolver outages never start legacy work or select global settings/account credentials.
  No legacy fallback is required; any retained migration behavior is explicit and cannot be an error fallback.
- Tenant scope holds through HTTP, SSE, permissions, questions, cancellation, recovery and
  checkpoints; revoked credentials cannot steer new or existing work.

**Exit criteria (G1-C)**

- A persistent turn reference identifies accepted/queued work, idempotent retries and terminal
  outcomes across DO restart. Preserve the existing single-active/single-queued policy.
- Public status identifies execution state, cancellation progress, accounting state, runtime
  generation and last verified recovery point without exposing raw internal DO state or secrets.
- A non-Slack reference CLI submits/follows up, answers a question, approves/rejects a permission,
  requests cancellation, reconnects output and inspects recovery using only public HTTP/SSE.
- Shared conformance cases cover retries, queueing, expired replay, runtime restart, ambiguous
  dispatch, cross-tenant requests and cancellation. No duplicated lifecycle/accounting engine.
- Applied configuration identity is recorded per turn; a full SandboxSpec editor is not required.

**Risks**

- The scheduling policy is immutable: v2 is a replacement application, so cut over in one step and
  back out to the previous image with a matching saved recovery point. Dual-run is not required.
- `durable_object` policy has no `max_instances`; R1-8 is the only thing preventing one tenant from
  consuming the account limit.
- Beta surface: pin the compatibility date and watch the Containers changelog.

---

## R2 — Own-account installation and operation

**Goal:** a new team installs in its own Cloudflare account, integrates an application, repeats
useful work and operates upgrades/recovery without builder help. Slack installation is optional.

| ID | Ticket | Size | Depends |
|---|---|---|---|
| R2-1 | Optional Slack OAuth install flow: per-workspace token storage, uninstall, reinstall; consume the shared execution contract | L; demand-sequenced | R1-5, R1-6; not a core onboarding prerequisite |
| R2-2 | Own-account operator access and scoped key bootstrap; member sessions/invites through selected Access or GitHub auth. Commercial signup stays deferred | M slices | R1-6 |
| R2-3 | Repeatable install/setup: prerequisite diagnostics → provision/configure → repo/provider → permissions → verified coding task through the public API; optional connector step | M slices | G1 + G1-C, R2-2; no dependency on R2-1 |
| R2-4 | Minimal operator view consuming R1 status/replay/cancel contracts: active work, recovery point, held/unknown usage, named limits and credential revocation. Broader members/audit/artifact UI is separately demand-scoped | M slices | R1-8, R1-4; artifact views additionally need R0-15 and qualified Stow readers |
| R2-5 | Tenant lifecycle: invite, remove member, export data, delete tenant (and checkpoints) | M | R2-2 |
| R2-6 | Operating measurements: container-seconds, R2 bytes, model usage, intervention time and cost per accepted task; extend R0 baseline and distinguish measured costs from estimates/unknowns | M | R1-8, R0-3 |
| R2-7 | Security review and pen-test prep (egress, secrets, tenant boundaries) | M | R1-7 |
| R2-8 | Install/integration guide, diagnostics, supported-version matrix and upgrade/rollback/export/restore runbook; record independent pilot attempts and support interventions | M | R2-3; builds on R0-1 rehearsal |

**Exit criteria (G2)**

- Five external teams install in their own accounts and complete a predeclared coding task without
  builder intervention; report every attempt and help request. Separately time prerequisite setup
  and ready-prerequisites → verified task; freeze a numeric target before pilot recruitment.
- Each team repeats useful work on a later day and completes the prescribed upgrade plus
  rollback/restore rehearsal without builder intervention; preserve history and accounting evidence.
- At least one independent developer integrates a non-Slack application using public contracts
  and published examples, without server-source imports or a bespoke backend patch. Record elapsed
  and hands-on time against a target frozen before the attempt.
- An operator sees actual/reserved/unknown usage and named limits, inspects recovery and revokes
  access without support. Cancellation/replay behavior matches G1-C.
- Security review signed off; no critical findings open.

---

## R3 — Demand-led sandbox options

**Goal:** remove configuration constraints demonstrated by pilot workloads, while keeping
installation and operation simple. The tickets below are options, not a committed package.

**Entry gate (G3, before investment):** record the blocked workload, affected pilot teams,
existing-preset workaround, smallest required change and expected measurable benefit. Test a
small number of operator-provisioned presets before building a catalogue or template editor.
If demand is absent, keep the supported defaults and improve the core service. R1's applied
configuration identity and existing lifecycle/limit correctness do not wait for this gate.

| ID | Ticket | Size | Depends |
|---|---|---|---|
| R3-1 | `SandboxSpec` v1: validation, canonical hash, applied version pinned per turn; show saved versus running configuration | M | R1-5 |
| R3-2 | Image catalogue (`base`, `node`, `python`, `full`), split Dockerfiles, digest pinning, image rollout on `inspect` mismatch | L | R1-2 |
| R3-3 | Instance sizes incl. custom `{vcpu, memoryMib, diskMb}`, cost guardrails | M | R3-1 |
| R3-4 | Workspace plans: multi-repo, branch/ref, empty scratch, install steps | L | R3-1 |
| R3-5 | Agent config per spec: model, permissions, MCP servers, `AGENTS.md` | M | R3-1 |
| R3-6 | Lifecycle: inactivity TTL, retention, snapshot fast path with R2 tar fallback; surface recovery point and interrupted processes without implying process-memory restoration | L | R3-1 |
| R3-7 | Sandbox API (`/api/sandboxes`, `/api/specs`) + template editor in the UI | L | R3-1 |
| R3-8 | Spec-change rollout: restart the sandbox, checkpoint before destroy, resume the session | M | R3-6 |
| R3-9 | Per-sandbox guardrails: budget plus storage/output/execution limits, named warnings and enforced stop/rejection where supported; distinguish admission estimates from hard caps | M | R3-3, R2-6 |

**Acceptance for each selected R3 slice**

- The selected option enables its predeclared blocked workload or measurably reduces operating
  effort; record the pilot's result and support cost. Only that option requires user configuration.
- Changing a spec restarts only that sandbox and resumes the session from checkpoint.
- Idle sandboxes stop; retention deletes checkpoints on schedule.
- Cost per sandbox is visible to the tenant.

---

## R4 — Product

Not scheduled in detail; each item is its own project.

- **Git loop:** branch → commit → PR → CI → review, with a diff view in Slack.
- **Slack Code API:** `code_channels:manage`, agent manifest, `agents.sessions.*` status, diff tab,
  Marketplace listing.
- **Parallelism:** fork a conversation, run N sandboxes on the same repo, compare diffs.
- **Previews:** expose a port from the sandbox on its own hostname.
- **Billing:** Stripe, plans, usage caps, invoices.
- **Compliance:** SOC 2 path, DPA, audit export.
- **Managed hosting:** the same Worker in our account, for teams that do not want to run it.

---

## Naming

- **Product:** Aboiteau. Used in docs, UI copy, the roadmap and anything a customer reads.
- **Code identifiers:** stay `cf-opencode` until the v2 cutover (R1-11). Renaming the Worker changes
  the deployed URL, which invalidates the Slack app request URLs, API clients and the stored
  `API_TOKEN` location. Update those bindings together in the single cutover; no dual-run is required.
- **Rule:** no new `cf-opencode` string in user-facing copy. New code may keep the old identifier until
  R1-11.

## Workstreams

| Workstream | R0 | R1 | R2 | R3 | R4 |
|---|---|---|---|---|---|
| Platform (DO, container) | storage/recovery correctness | caller contract, lifecycle proof, protected extraction | repeatable install/upgrade | demanded spec/lifecycle options | fork, previews |
| Identity & tenancy | trusted rollout limits | strict tenants, scoped keys, quotas | own-account bootstrap, revoke/export | demanded per-tenant specs | SSO/SCIM, commercial signup |
| Onboarding & UX | recovery evidence | public status, reference CLI | API-first install guide, minimal operator view | demanded template controls | marketplace |
| Sandbox | Stow wiring and R2-only restore | early egress/credential proof and enforcement | supported presets | demand-qualified catalogue/sizing | previews |
| Security | repository-code probe | egress boundary, tenant failure matrix | independent review | per-spec policy | SOC 2 |
| Ops | accepted-task/cost baseline | isolation/recovery conformance | pilot intervention, upgrade/restore and total cost | measured benefit per option | status/SLA |
| Integrations | bounded Slack completion, public replay fix | neutral interactions, non-Slack reference client | independent application integration; optional Slack OAuth | demand-selected connectors | Slack Code |

---

## Dependencies

```
R0-10 retention ──┐
R0-11 budgets ────┼─► R0-14 regression evidence ──► G0
R0-13 input ──────┘
R0-15 same-directory Stow + R2-only recovery ──► G0 / workspace-dependent R0-2 evidence
R0-16 public replay correction ──► G0 / R1-4 conformance
R0-1 staging rehearsal + R0-10/R0-11/R0-13 ──► R0-2 coding tasks ──► R0-3 measurements / G0
R1-1 stable keys ──► R1-2 policy cutover ──► R1-3 per-conversation containers
                                          └─► R1-5 strict tenants ──► R1-6 keys ──► R2-2 bootstrap
Disposable current runtime ──► R1-7a feasibility ──► R1-7 enforcement + R1-9 probes ──► G1
R1-3 + R0-16 ──► R1-4a contract ──► R1-4b interactions ──► R1-4c client ──► G1-C
G1 + G1-C + R2-2 ──► R2-3 install + R2-8 upgrade/runbook ──► G2 own-account pilots
R1-7 ──► R2-7 security review ──► G2
R2 pilot workload evidence (including failed G2 attempts) ──► G3 demand decision ──► selected R3 slices
R2-6 metering ──► R3-9 budgets ──► R4 billing
```

The R1-4b → R1-4c edge is a completion dependency; the reference client may be
developed against contract fixtures alongside R1-4b. Audit 24 extraction (R1-4d)
follows protected seams and conformance tests, without blocking boundary proofs.
G3 may use controlled pilot observations before all five teams pass G2; a
configuration-blocked pilot must not require G2 completion to justify its remedy.
External pilots still require G1/G1-C, and broader expansion still requires G2.

---

## Metrics per release

| Release | Instrument | Target |
|---|---|---|
| R0 | accepted task successes/total, cold/warm p50/p95, checkpoint/restore, recovery time, interventions and known/unknown task costs | Freeze representative task/fault thresholds before execution; retain p95 < 60 s only for the defined simple-turn latency check |
| R1 | isolation failures, duplicate dispatch, replay/interaction conformance, recovery point and cancellation/accounting state | 0 observed cross-tenant accesses or duplicate dispatches in the declared matrix; all mandatory conformance cases pass |
| R2 | prerequisite/setup/install time, integration hands-on time, later-day repeat use, upgrade/restore success, intervention count and total cost per accepted task | Five independent own-account teams pass G2 without builder intervention; freeze time/cost targets before attempts, retain failures in denominator |
| R3 | blocked-workload completion, operating effort saved, incremental cost and recovery behavior | Evidence before commitment; each selected slice achieves its predeclared benefit without weakening G1/G1-C |
| R4 | repeated useful work, retention and commercial demand; revenue when relevant | No adoption or willingness-to-pay claim from build/test counts |

The [measurement protocol](plans/execution-service-delivery.md#measurement-and-pilot-protocol)
defines case selection and evidence. No accepted numeric target is implied where
the baseline is missing; fixing targets before runs is a required planning deliverable.

---

## Deliberately not building

- Our own agent loop or model. OpenCode remains the current runtime; connector independence does
  not imply implemented support for Claude Code, Codex or arbitrary execution backends.
- Our own VM or scheduler. Cloudflare Containers is the substrate.
- An alternative execution backend or full WASI/POSIX compatibility layer without
  the measured need in the [runtime revisit gate](#when-to-reconsider-execution-backends).
- A desktop IDE, a browser takeover, or a preview product before R4.
- Per-tenant arbitrary Dockerfiles. The catalogue plus a runtime install step is the contract.
- A marketplace before there are tenants.
- A general job/process manager, connector framework or large SDK before the public contract and
  reference client expose a demonstrated need.
- Broad image catalogues, arbitrary sizing, template editors or extra connectors without pilot
  workload evidence. Keep already-authorized S8/S10 work within its existing acceptance scope.

---

## Immediate next actions

The completed [R0 repair plan](plans/r0-reliability-iteration.md) remains historical
implementation evidence. New sequencing and bounded briefs live in the
[execution-service delivery plan](plans/execution-service-delivery.md).

1. **API owner, Luna/medium:** R0-16's repair and local checks are complete. Retain its
   public-route regressions and existing-state inspection limits through a separately scoped
   rollout; keep R1's stronger caller/status guarantees open.
2. **Platform/storage owner, Luna/high:** A/B1/C1 are verified. Integrate the supported native
   Workspace startup directly, then rehearse selected-image and R2-only recovery. Do not build
   legacy migration or dual writers by default; handle only named operator data to retain or
   intentionally reset at the separately scoped cutover.
3. **API/security owners:** inventory and freeze R1-4a's caller contract and R1-7a's smallest
   credential/egress proof. Contract fixtures may proceed alongside remaining live R0 work.
4. **Platform + operator:** freeze task/fault cases and numeric targets, then run only authorized
   representative coding/recovery/cost checks. Connectivity canaries do not close G0.
5. **API/connector owners:** deliver neutral questions/cancellation/status and the reference CLI
   through existing handlers; pass G1-C and strict-identity failure cases before external pilots.
6. **Pilot owner:** prepare independent own-account install/integration/upgrade attempts after G1
   and G1-C. Record failures, interventions and uncertain costs; use results to decide G3 scope.

This planning revision authorizes no new deployments, provider spend, messages, live ledger
adjustments, migrations or resource destruction. Existing session authorizations and the scoped
plans' concrete rollout/approval boundaries continue to apply.
