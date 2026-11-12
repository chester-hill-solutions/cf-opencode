# Roadmap — from harness to product

**Product name:** **Aboiteau** — an Acadian tidal gate that lets the useful tide in and keeps the
destructive one out, which is roughly the job of a sandbox boundary.

**Product statement:** a multi-tenant, self-onboarding sandbox platform for coding agents. A team
installs it into their own Cloudflare account (or ours), connects a repo and a model, and gets an
agent in Slack and over HTTP that runs in an isolated, configurable sandbox.

**Assumptions**

- One full-time engineer (the agent) plus a product owner at ~20% for decisions and dashboard work.
- Workers Paid plan; one Cloudflare account for staging and one for production.
- Local Docker may be unavailable; Workers Builds and a staging Worker provide the deployment
  validation path. Historical local container runs do not replace deployed-runtime checks.
- The commercial bet is the self-hosted / own-account segment, not a feature race with Devin or Cursor.
  If that bet changes, R2–R3 change; R0–R1 do not.

**Decision gates.** Each release ends with a gate. A failed gate stops the next release, not the whole
roadmap.

**Local repair update — 2026-11-11.** R0-10, R0-13 and R0-14 now pass their local
regressions and the full local gate. The original audit 30/31 reproductions are fixed,
but R0-11 remains partial. F1 now includes source accounting, foreground-only runtime
policy, execution-completion fences and previewed legacy cutover. Scoped F2 now adds
passive recovery inspection, safe pre-dispatch cancellation, alarm-only recovery
retry and permanent reservation retirement (371 tests in the latest gate).
Actual accounting cutover, deployed-container verification and unprovable
legacy/orphan/manual reconciliation cases remain open. Legacy opening balances remain
explicitly unreconciled with historical bills. Audit 32's trusted-repository
documentation/probe evidence is recorded; credential isolation and G1 remain open. G0
remains open pending deployed/container and real Slack/HTTP/model task validation. See the
[audit status and evidence](production-audit.md#local-repair-verification--2026-11-11)
and [local regressions and limits](testing.md#local-repair-verification--2026-11-11).

**Slack connection update — 2026-11-11.** With operator approval, the existing
OpenCode app in Team Nate uses the production Worker's verified HTTP event and
interaction URLs, with Socket Mode off. Mention, DM and engaged-thread event
subscriptions are saved. The credential-preserving restart fix is deployed and
a real HTTP model reply was observed, but accounting settlement did not identify
the corresponding execution/terminal events because stock CLI 2.2.5 does not
persist Bus events (`persist:false`). Its sequence 11 cursor is only a watermark,
not unrecognized event rows. The published server API supports event persistence,
and a custom Bun entrypoint was implemented and first verified on isolated canary
`event-retention-canary-20261111-02`. Its fresh HTTP task returned `READY` with
terminal usage evidence and exact ledger acknowledgement. With separate user
approval, fresh-conversation routing was enabled and the approved `#arfin-test`
thread passed `!help`, `!new`, `!model`, a text reply, question Continue and
permission approval. The task requested `SLACK_READY`; the final response
matched. The two older `$0.10` holds remain for operator/manual reconciliation;
do not auto-zero them. The operator approved a temporary cap of 3, including its
incremental runtime cost, until S8 reconciliation. Settings version 7 was verified
with two held runtimes and one available slot. Restore the cap to 2 after S8 safely
frees the held runtimes. G0 text-reply/button evidence is passed; the wider product
goal remains open for S8 and S10 image handling. See the
[connection record](runbook.md#slack-connection--2026-11-11) and
[current usability evidence](plans/slack-usability.md#current-evidence).

**Slack usability follow-up.** The deployed bot's `!help`, `!usage` and model
catalogue commands have been verified in the operator's DM. The paid model key is
connected and persisted across a real settings restart. A fresh HTTP conversation
answered `READY` with reported cost `$0.0017703`, but its usage replay failed to
reconstruct execution and terminal events because the stock CLI Bus uses
`persist:false`; sequence 11 is a watermark. Its hold remains, as does the
separate `$0.10` hold from the Slack DM that failed with `provider.no-route`.
Neither supports a zero-charge claim. A later isolated evented-image canary
returned `READY` and its usage was acknowledged; that does not reconstruct the
older turns. Fresh-conversation routing was enabled with separate approval. The
operator-approved `#arfin-test` thread passed `!help`, `!new`, `!model`, a text
reply, question Continue and permission approval. The two older holds remain for
S8 manual reconciliation. An approved temporary third slot provides capacity for
new work while the two older runtimes remain held. Slack image attachments remain
planned under
[S10](plans/slack-usability.md#s10--image-attachments-planned): authenticated image
delivery, model capability checks and an explicit response with compatible-model
suggestions when the selected model cannot read images. Selection stays unchanged
until the user switches models and resubmits. See the
[usability evidence](plans/slack-usability.md#current-evidence).

**Initial assessment — 2026-11-11 (historical).** The initial 269-test snapshot reproduced
checkpoint retention, budget reservation and malformed-input failures, and demonstrated
that repository-executed code could read synthetic provider state under the shared
identity. No fixes had been made at that assessment point. Later local repair evidence
supersedes its open status for locally verified findings, not its credential or deployment
limitations.

**Next iteration:** [R0 reliability execution plan](plans/r0-reliability-iteration.md)
keeps W1–W12 as reviewable slices, with W4a–W4c/W6a making broad edits manageable
for Luna. Luna handles bounded implementation, tests and documentation; the parent
locks decisions and integrates, with Terra/high for focused critical review. Targeted
[source research](plans/r0-simplification-research.md) removed a broader reservation
protocol from this pass. Local implementation and verification are complete for the stated
repair scope. The [F1 follow-up](plans/r0-reliability-iteration.md#f1-accounting-follow-up--2026-11-11)
adds verified local accounting repairs. The [policy/cutover follow-up](plans/r0-reliability-iteration.md#f1-policy-and-legacy-cutover--2026-11-11)
implements the remaining local F1 contract. Scoped F2 recovery is also locally
verified; R0-11 remains partial for unprovable legacy/manual cases and live
cutover/container verification.
Live validation has not started.

**Latest scoped implementation:** [F2 held-turn recovery](plans/r0-held-turn-reconciliation.md)
is implemented and reviewed locally, with Luna ownership for retirement, passive
inspection, safe pre-dispatch cancellation and existing recovery retries. It adds
no expiry or ambiguous prompt resend. Unprovable legacy/orphan cases remain
explicit blockers; no live recovery action has run.

| Gate | Question | If no |
|---|---|---|
| G0 | Do real tasks complete and survive recovery, with verified budget admission and acceptable cost per turn? | Fix reliability before tenancy |
| G1 | Can two tenants run concurrently without seeing each other? | No onboarding |
| G2 | Do five external teams self-onboard without help? | Fix onboarding before sandbox |
| G3 | Do tenants actually change image, size or network? | Sandbox is over-built; ship R4 |

---

## Releases at a glance

| Release | Theme | Outcome | Estimate | Gate |
|---|---|---|---|---|
| **R0** | Harness complete | Confirmed reliability defects closed; real Slack/HTTP tasks and recovery measured | 1–2 weeks | G0 |
| **R1** | Tenancy foundations | Per-conversation containers, tenants, isolation, secrets | 3 weeks | G1 |
| **R2** | Self-onboarding | A team signs up, installs, and runs a task unaided | 3–4 weeks | G2 |
| **R3** | Configurable sandbox | Image, size, workspace, network and lifecycle chosen per sandbox | 4–5 weeks | G3 |
| **R4** | Product | PR loop, Slack Code, billing, compliance, managed hosting | ongoing | — |

Indicative calendar (holiday-aware): R0 Nov 9–20 · R1 Nov 23–Dec 11 · R2 Dec 14–Jan 15 · R3 Jan 18–Feb 19.
These are planning assumptions, not verified delivery dates; re-estimate after R0-10/R0-11
and the deployed-container checks.

**Sequencing note.** The current configuration already selects `durable_object`, and the
code implements per-conversation containers, snapshots, inactivity handling and global leases.
Deployment/cutover verification remains in R1-2/R1-3; configuration alone does not close G1.
R3 adds configurability. Audit finding 24 (extract `ContainerRuntime` / `EventStream`) stays
in R1-4, after the reliability regressions protect the existing behavior.

## Runtime direction — retain the current stack

**Decision — 2026-11-11, confirmed by the product owner:** retain OpenCode in
Cloudflare Containers, the stow-s3 hot workspace and R2 recovery checkpoints.
Prioritize R0 reliability and measured recovery, R1 tenant/credential isolation,
then R2 onboarding. No alternative-runtime prototype is scheduled.

**Stow integration prerequisite:** source inspection found that current startup
selects the generic filesystem object store rather than Stow's registered
shared-directory Workspace. R0-15 repairs that wiring and proves bidirectional
file/S3 visibility plus R2-only cold recovery. This is work on the selected native
stack; the same-bytes claim remains unverified until its acceptance checks pass.
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
| Inspectable work | R1-3/R1-4 lifecycle/events; R2-4 admin surface | Stable turn/job references, runtime generation, running/finished/interrupted/unknown status, bounded replayable output and explicit cancellation results. Retain OpenCode's job/process ownership. |
| Clear recovery status | R0 recovery evidence; R1-3 lifecycle; R3-6 configurable policy | Show the last verified checkpoint and what was restored; distinguish recovered files/history from interrupted processes and uncertain side effects. |
| Scoped capabilities | R1-7 credential injection and egress | Enforce access outside repository execution; keep provider/git credentials outside that boundary and verify using repository-controlled probes. |
| Explicit resource limits | R1-8 quotas; R2-4 visibility; R3-9 per-sandbox controls | Bounded storage, output and execution lifetimes, with a named limit, observed usage and actionable warning/failure. Keep model admission estimates distinct from enforced caps. |
| Reproducible configuration | R3-1/R3-8 SandboxSpec and rollout | Record the applied configuration per turn and show saved versus running versions. |

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

## R0 — Harness complete (current work)

**Goal:** fix the reproduced reliability defects, then prove task completion, recovery and
cost with a real container. Keep the first rollout scoped to a trusted operator and trusted
repositories until R1-7 removes long-lived credentials from repository execution.

| ID | Ticket | Size | Owner | Status |
|---|---|---|---|---|
| R0-1 | Connect Workers Builds (root `.`, `bun install`, `npx wrangler deploy`) | S | user | recorded **blocked**; deployment status not rechecked on Nov 11 |
| R0-2 | Real Slack/HTTP tasks with observable outcomes; verify settle, files, restore and model usage | S | agent | blocked on R0-1 and remaining R0-11 work; same-workspace/S3 task claims additionally require R0-15; R0-10/R0-13 local prerequisites verified |
| R0-3 | `bench/measure.ts` + `bench/container.sh`: cold start, checkpoint size/time, restore, turn latency | S | agent | blocked on R0-1/R0-2 for live task measurements |
| R0-4 | Slack cutover: Event Subscriptions + Interactivity URLs, Socket Mode off, stop launchd bot | S | both | **partial**; app switched, engaged-thread replies enabled, old bot unloaded/disabled; help/usage/catalogue and text reply verified; question Continue and permission approval passed; two older holds remain for S8; temporary third slot approved and verified available for new work; image attachments unimplemented; broader product goal remains open |
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
| R0-15 | Correct native Stow Workspace startup/readiness/identity, preserve existing object-only data, and verify disk ↔ S3 plus R2-only cold recovery | M | agent | **planned**; source-level integration mismatch identified; [ordered slices and acceptance](plans/stow-workspace-integration.md) |

**Exit criteria**

- A Slack mention produces a real reply, and the same turn works over HTTP/SSE.
- A stated set of real coding tasks meets observable outcomes (files changed as requested,
  relevant checks pass, and changes survive a container restart); report successes/total,
  model/version, cold/warm conditions, latency and provider-reported cost.
- Cold start, checkpoint and restore numbers exist in `bench/RESULTS.md`.
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

**Verification limits:** the boundary design records a historical local image build/run on
Nov 7. The Nov 11 assessment could not rerun it because Docker was unavailable, and did not
verify deployed containers, live Slack/OAuth, model effectiveness or cost. R0-1 remains the
recorded deployment dependency; local retention, budget and input regressions can proceed
without it. The settings browser checks used synthetic API responses.

---

## R1 — Tenancy foundations

**Goal:** one container per conversation, tenant-scoped configuration, no shared global state, and a
network boundary that makes untrusted agent code safe to host.

**Why now:** containers are namespaced per conversation in the current code, but settings,
HTTP authorization and default account onboarding remain global. Optional channel/agent
namespacing does not provide a complete tenant boundary. A second team must not inherit
another team's configuration or credentials.

| ID | Ticket | Size | Depends |
|---|---|---|---|
| R1-1 | Stable checkpoint keys + legacy copy job — **partial:** split archives/manifest and local retention/restore repairs are verified; stable-key migration/copy job open | S | R0-10 |
| R1-2 | Verify deployed `durable_object` policy and replacement-app cutover — configuration and code already use the policy | L | R1-1 |
| R1-3 | Verify per-conversation lifecycle — start/snapshots/inactivity/global leases implemented; deployed isolation and inspect/monitor work unverified. Inspection should identify the current runtime generation, active turn and last verified recovery point. | M | R1-2 |
| R1-4 | Extract existing `ContainerRuntime` and `EventStream` from `conversation.ts` (audit 24); retain stable execution references and explicit interrupted/unknown outcomes. Keep the current backend. | M | R1-2 |
| R1-5 | Tenant model + tenant-scoped specs — **partial:** D1 schema, channel resolver, conversation namespaces and per-agent account-seed keys landed; per-agent Settings/API keys/strict mode open | L | R1-2 |
| R1-6 | Per-tenant API keys (hashed, revocable) and auth middleware; retire the shared `API_TOKEN` for tenants | M | R1-5 |
| R1-7 | Audit 32: default-deny egress + external model/git credential injection; repository commands cannot read long-lived secrets from files, environment or process state | L | R1-3 |
| R1-8 | Concurrency caps and quotas per tenant (containers, minutes, storage), with named limit/usage in rejection and status responses | M | R1-5 |
| R1-9 | Isolation tests: two tenants, cross-tenant probes (checkpoint, SSE, settings, container) | M | R1-5 |
| R1-10 | Dual-run v1/v2, cutover plan, rollback | S | R1-2 |
| R1-11 | Rename the deployment to Aboiteau during the v2 cutover: Worker name, package, repo, URL, Slack app URLs, secrets | M | R1-10 |

**Exit criteria (G1)**

- Two conversations in two tenants run at the same time in separate containers.
- A probe from tenant A cannot read tenant B's state, events, checkpoint or repo.
- No global `Settings` singleton in the request path; a spec change restarts only that sandbox.
- Egress: a sandbox cannot reach a host outside its allowlist; no provider token is readable inside it.
- Execute repository-controlled test/typecheck code that tries to read synthetic credentials;
  verify the boundary using OS/network enforcement, not just permission-rule strings.

**Risks**

- The scheduling policy is immutable: v2 is a replacement application. Dual-run and rollback are not
  optional.
- `durable_object` policy has no `max_instances`; R1-8 is the only thing preventing one tenant from
  consuming the account limit.
- Beta surface: pin the compatibility date and watch the Containers changelog.

---

## R2 — Self-onboarding

**Goal:** a new team goes from landing page to first agent turn without an operator.

| ID | Ticket | Size | Depends |
|---|---|---|---|
| R2-1 | Slack OAuth install flow: per-workspace token storage, uninstall, reinstall | L | R1-5 |
| R2-2 | Tenant signup + session (Cloudflare Access or GitHub OAuth), invite links | L | R1-6 |
| R2-3 | Onboarding wizard: connect repo → pick model → review permissions → first task | L | R2-1, R2-2 |
| R2-4 | Admin console: members, usage, limits, audit log, sandbox list; runtime-backed turn/job status, bounded output/replay and cancellation outcomes; scoped Stow live/saved artifact views after their qualification gates | L | R1-8, R1-4; artifact views: R0-15 and supported Stow reader profile |
| R2-5 | Tenant lifecycle: invite, remove member, export data, delete tenant (and checkpoints) | M | R2-2 |
| R2-6 | Usage metering: container-seconds, R2 bytes, model tokens per tenant | M | R1-8 |
| R2-7 | Security review and pen-test prep (egress, secrets, tenant boundaries) | M | R1-7 |
| R2-8 | Docs, status page, support runbook | S | R2-3 |

**Exit criteria (G2)**

- Five external teams self-onboard with no operator involvement.
- Time to first turn < 10 minutes, measured from signup.
- A tenant admin can see usage and revoke access without support.
- Security review signed off; no critical findings open.

---

## R3 — Configurable sandbox

**Goal:** the sandbox becomes a first-class, declarative object a tenant can configure, not a
deployment detail.

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

**Exit criteria (G3)**

- A tenant creates a sandbox with a chosen image, size, workspace and egress policy, with no redeploy.
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
  `API_TOKEN` location. Doing it during the dual-run avoids two migrations.
- **Rule:** no new `cf-opencode` string in user-facing copy. New code may keep the old identifier until
  R1-11.

## Workstreams

| Workstream | R0 | R1 | R2 | R3 | R4 |
|---|---|---|---|---|---|
| Platform (DO, container) | audit 22, perf | policy migration, runtime split | — | spec, lifecycle | fork, previews |
| Identity & tenancy | — | tenants, keys, quotas | signup, invites, admin | per-tenant specs | SSO/SCIM |
| Onboarding & UX | — | settings → specs | wizard, console | template editor | marketplace |
| Sandbox | — | egress, secrets | — | catalogue, sizing | previews |
| Security | — | egress boundary | pen-test | per-spec policy | SOC 2 |
| Ops | metrics, bench | isolation tests | metering | cost guardrails | status/SLA |
| Integrations | Slack cutover | — | Slack OAuth | — | Slack Code |

---

## Dependencies

```
R0-10 retention ──┐
R0-11 budgets ────┼─► R0-14 regression evidence ──► G0
R0-13 input ──────┘
R0-15 same-directory Stow + R2-only recovery ──► G0 / workspace-dependent R0-2 evidence
R0-1 deployed image + R0-10/R0-11/R0-13 ──► R0-2 real tasks ──► R0-3 measurements
                                                              └─► R0-4 Slack cutover / G0
R1-1 stable keys ──► R1-2 policy migration ──► R1-3 per-conversation containers
                                          ├─► R1-4 runtime split
                                          └─► R1-5 tenants ──► R1-6 keys ──► R2-2 signup
R1-3 ──► R1-7 egress ──► R2-7 security ──► G2
R1-5 ──► R3-1 spec ──► R3-2..R3-9 ──► G3
R2-6 metering ──► R3-9 budgets ──► R4 billing
```

---

## Metrics per release

| Release | Instrument | Target |
|---|---|---|
| R0 | turn latency p50/p95, cold start, checkpoint size/time, cost per turn | p95 < 60 s for a simple turn |
| R1 | concurrent tenants, isolation failures, container recycle rate | 0 cross-tenant reads |
| R2 | signup → first turn, activation rate, support tickets per tenant | < 10 min, > 50% activate |
| R3 | spec adoption, idle stop rate, cost per sandbox, restore success | > 30% change a default |
| R4 | weekly active tenants, retention, revenue | — |

---

## Deliberately not building

- Our own agent loop or model. OpenCode (and later Claude Code / Codex) stay pluggable runtimes.
- Our own VM or scheduler. Cloudflare Containers is the substrate.
- An alternative execution backend or full WASI/POSIX compatibility layer without
  the measured need in the [runtime revisit gate](#when-to-reconsider-execution-backends).
- A desktop IDE, a browser takeover, or a preview product before R4.
- Per-tenant arbitrary Dockerfiles. The catalogue plus a runtime install step is the contract.
- A marketplace before there are tenants.

---

## Immediate next actions

Dispatch details and the execution order are in the
[next-iteration plan](plans/r0-reliability-iteration.md#14-execution-gate).

1. **User/agent:** recheck Workers Builds (R0-1), verify the coupled Worker/policy-enabled
   image in a real container, and rehearse cutover/restore in staging. No deployment or
   production cutover was part of this local gate.
2. **Both:** assess retained legacy/orphan/manual-evidence cases before production
   rollout. The [scoped recovery API](plans/r0-held-turn-reconciliation.md) is verified
   locally; unknown charges and ownership remain preserved. External evidence import
   requires its own bounded design if actual cases need it.
3. **Agent:** run authorized Slack/HTTP tasks and recovery/cost measurements (R0-2/R0-3),
   recording provider/model, task outcomes and limits; simulated results do not substitute.
4. **Both:** keep R0-11 partial until the remaining manual cases and live
   cutover/container evidence are verified. Scoped F1 and F2 now pass local checks.
   Keep audit 32/R1-7 and G0/G1 open.
5. Review the expanded G0 evidence and estimates before tenancy rollout or R1-4 extraction.
6. **Agent:** execute [R0-15's native workspace integration slices](plans/stow-workspace-integration.md)
   using disposable storage fixtures before any workspace-dependent live task or
   artifact-browser adoption. Preserve existing generic-store data and all current
   accounting/credential rollout limits. Track Stow-side artifact qualification in
   its canonical plan; runtime research remains deferred.
