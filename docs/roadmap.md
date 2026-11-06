# Roadmap — from harness to product

**Product name:** **Aboiteau** — an Acadian tidal gate that lets the useful tide in and keeps the
destructive one out, which is roughly the job of a sandbox boundary.

**Product statement:** a multi-tenant, self-onboarding sandbox platform for coding agents. A team
installs it into their own Cloudflare account (or ours), connects a repo and a model, and gets an
agent in Slack and over HTTP that runs in an isolated, configurable sandbox.

**Assumptions**

- One full-time engineer (the agent) plus a product owner at ~20% for decisions and dashboard work.
- Workers Paid plan; one Cloudflare account for staging and one for production.
- No Docker on the developer machine: images build in Workers Builds, containers are validated on a
  staging Worker.
- The commercial bet is the self-hosted / own-account segment, not a feature race with Devin or Cursor.
  If that bet changes, R2–R3 change; R0–R1 do not.

**Decision gates.** Each release ends with a gate. A failed gate stops the next release, not the whole
roadmap.

| Gate | Question | If no |
|---|---|---|
| G0 | Does a real turn work end to end, and is cost per turn acceptable? | Fix reliability before tenancy |
| G1 | Can two tenants run concurrently without seeing each other? | No onboarding |
| G2 | Do five external teams self-onboard without help? | Fix onboarding before sandbox |
| G3 | Do tenants actually change image, size or network? | Sandbox is over-built; ship R4 |

---

## Releases at a glance

| Release | Theme | Outcome | Estimate | Gate |
|---|---|---|---|---|
| **R0** | Harness complete | A real Slack turn, measured, audit closed | 1–2 weeks | G0 |
| **R1** | Tenancy foundations | Per-conversation containers, tenants, isolation, secrets | 3 weeks | G1 |
| **R2** | Self-onboarding | A team signs up, installs, and runs a task unaided | 3–4 weeks | G2 |
| **R3** | Configurable sandbox | Image, size, workspace, network and lifecycle chosen per sandbox | 4–5 weeks | G3 |
| **R4** | Product | PR loop, Slack Code, billing, compliance, managed hosting | ongoing | — |

Indicative calendar (holiday-aware): R0 Nov 9–20 · R1 Nov 23–Dec 11 · R2 Dec 14–Jan 15 · R3 Jan 18–Feb 19.

**Sequencing note.** The `durable_object` scheduling-policy migration lives in **R1**, not R3. It is the
only way to get one container per conversation, and multi-tenancy without per-conversation isolation is
not multi-tenancy. R3 is the *configurability* layer on top of that isolation. Audit finding 24
(extract `ContainerRuntime` / `EventStream`) is folded into R1-4 so the refactor happens once.

---

## R0 — Harness complete (current work)

**Goal:** prove the harness works with a real container, close the audit, and stop changing the core.

| ID | Ticket | Size | Owner | Status |
|---|---|---|---|---|
| R0-1 | Connect Workers Builds (root `.`, `bun install`, `npx wrangler deploy`) | S | user | **blocked** |
| R0-2 | First real turn: `POST /messages` + `curl -N /events`, verify settle and checkpoint | S | agent | blocked on R0-1 |
| R0-3 | `bench/measure.ts` + `bench/container.sh`: cold start, checkpoint size/time, restore, turn latency | S | agent | blocked on R0-1 |
| R0-4 | Slack cutover: Event Subscriptions + Interactivity URLs, Socket Mode off, stop launchd bot | S | both | blocked on R0-2 |
| R0-5 | Audit 22: explicit conversation state machine (`idle → admitting → running → settling → idle`, guarded transitions) | M | agent | **done** |
| R0-6 | Audit cluster 1: performance pass (hot paths, SSE fan-out, R2 sizes) | S | agent | **done** (findings 25–28) |
| R0-7 | Finish audit 23: turn latency, queue depth, checkpoint bytes, failure classes | M | agent | **done** (OTel export deferred) |
| R0-8 | Handover: README limits, runbook, cost-per-turn note | S | agent | **done** (runbook) |
| R0-9 | ~~Audit 24~~ | — | — | moved to R1-4 |

**Exit criteria**

- A Slack mention produces a real reply, and the same turn works over HTTP/SSE.
- Cold start, checkpoint and restore numbers exist in `bench/RESULTS.md`.
- `bun run typecheck`, `check:config`, unit and workerd suites green.
- No open audit finding except the two deferred to R1.

**Known blocker:** the container image has never been built, so `/messages` returns
`{"ok":true,"queued":true,"error":"container port 4001 did not become ready"}`. R0-1 is the gate for
every measurement and for the Slack cutover.

---

## R1 — Tenancy foundations

**Goal:** one container per conversation, tenant-scoped configuration, no shared global state, and a
network boundary that makes untrusted agent code safe to host.

**Why now:** the current design has one container (`max_instances: 1`), one global `Settings` object,
and one shared bearer token. Onboarding a second team onto that would give them the first team's repo,
model and permissions.

| ID | Ticket | Size | Depends |
|---|---|---|---|
| R1-1 | Stable checkpoint keys (`workspaces/<conversationKey>.tar.gz`) + copy job for existing checkpoints | S | — |
| R1-2 | Migrate to `scheduling_policy: "durable_object"` with the current image, behaviour unchanged | L | R1-1 |
| R1-3 | Per-conversation container lifecycle: `start({image, instance, enableInternet})`, `inspect`, `monitor`, `setInactivityTimeout` | M | R1-2 |
| R1-4 | Extract `ContainerRuntime` and `EventStream` from `conversation.ts` (audit 24) | M | R1-2 |
| R1-5 | Tenant model + tenant-scoped specs: `tenants`, `sandbox_specs`, `conversations.tenant_id` | L | R1-2 |
| R1-6 | Per-tenant API keys (hashed, revocable) and auth middleware; retire the shared `API_TOKEN` for tenants | M | R1-5 |
| R1-7 | Egress default-deny + `EgressProxy` WorkerEntrypoint: allowlist per spec, inject model/git credentials outside the sandbox | L | R1-3 |
| R1-8 | Concurrency caps and quotas per tenant (containers, minutes, storage) | M | R1-5 |
| R1-9 | Isolation tests: two tenants, cross-tenant probes (checkpoint, SSE, settings, container) | M | R1-5 |
| R1-10 | Dual-run v1/v2, cutover plan, rollback | S | R1-2 |
| R1-11 | Rename the deployment to Aboiteau during the v2 cutover: Worker name, package, repo, URL, Slack app URLs, secrets | M | R1-10 |

**Exit criteria (G1)**

- Two conversations in two tenants run at the same time in separate containers.
- A probe from tenant A cannot read tenant B's state, events, checkpoint or repo.
- No global `Settings` singleton in the request path; a spec change restarts only that sandbox.
- Egress: a sandbox cannot reach a host outside its allowlist; no provider token is readable inside it.

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
| R2-4 | Admin console: members, usage, limits, audit log, sandbox list | L | R1-8 |
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
| R3-1 | `SandboxSpec` v1: validation, canonical hash, pinning per turn | M | R1-5 |
| R3-2 | Image catalogue (`base`, `node`, `python`, `full`), split Dockerfiles, digest pinning, image rollout on `inspect` mismatch | L | R1-2 |
| R3-3 | Instance sizes incl. custom `{vcpu, memoryMib, diskMb}`, cost guardrails | M | R3-1 |
| R3-4 | Workspace plans: multi-repo, branch/ref, empty scratch, install steps | L | R3-1 |
| R3-5 | Agent config per spec: model, permissions, MCP servers, `AGENTS.md` | M | R3-1 |
| R3-6 | Lifecycle: inactivity TTL, retention, snapshot fast path with R2 tar fallback | L | R3-1 |
| R3-7 | Sandbox API (`/api/sandboxes`, `/api/specs`) + template editor in the UI | L | R3-1 |
| R3-8 | Spec-change rollout: restart the sandbox, checkpoint before destroy, resume the session | M | R3-6 |
| R3-9 | Cost guardrails: per-sandbox budget, warn and stop at limit | M | R3-3, R2-6 |

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
R0-1 image build ──► R0-2 first turn ──► R0-3 measurements ──► R0-4 Slack cutover
                                     └─► G0
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
- A desktop IDE, a browser takeover, or a preview product before R4.
- Per-tenant arbitrary Dockerfiles. The catalogue plus a runtime install step is the contract.
- A marketplace before there are tenants.

---

## Immediate next actions

1. **User:** connect Workers Builds (R0-1). Nothing downstream can be measured without it.
2. **Agent:** R0-5 (state machine) and R0-6 (performance) while waiting; R0-7 metrics next.
3. **Both:** review G0 criteria and the R1 estimate before starting the policy migration.
