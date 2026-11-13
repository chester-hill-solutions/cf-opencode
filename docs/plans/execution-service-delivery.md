# Execution-service delivery

Status: R0-16/R0-15A/B1/C1 verified; B2 direct native startup integration in progress.
Updated: 2026-11-12. S8/S10 completion is recorded in their owning plans.
Authority: [roadmap](../roadmap.md), especially G0, G1, G1-C, G2 and the pre-investment G3 gate.

## Outcome and constraints

Another application can drive continuing coding work through a stable public API,
and a team can install, upgrade and recover Aboiteau in its own Cloudflare account
without builder intervention. Slack is the first connector, not the execution model.

Retain OpenCode in Cloudflare Containers, native Stow working storage and R2
workspace/state recovery. Reuse Conversation admission, event storage, alarms,
owned reservations, source accounting and recovery receipts. Preserve one active
turn plus one queued follow-up. No alternate runtime, general scheduler, parallel
job engine or connector framework is included.

The tenant → agent identity model and [boundary decisions](../design/r1-agent-boundary.md)
remain authoritative. Own-account pilots do not waive credential/tenant isolation.
Operator reconciliation remains a distinct privileged capability; ordinary
connectors cannot import usage or close uncertain holds.

Pre-customer decision (2026-11-12): hard cuts are allowed where they simplify
delivery. Implement one supported storage/runtime/API path and update bundled
clients together. Legacy copy jobs, dual writers, dual-run deployments and
compatibility adapters are conditional on a specific retained-data or caller
requirement, not default deliverables. Record any operator data to retain or
intentionally reset before cutover; this policy performs no deletion and does
not waive current-format recovery, isolation or truthful accounting.

## Delivery order and ownership

| Slice | Owner | Depends on | Deliverable / acceptance |
|---|---|---|---|
| Completed S8/S10 | Existing reconciliation and connector owners | Scoped approvals and live checks completed | [S8](operator-reconciliation.md) retired both approved holds, preserved the original DM and restored cap 2; the accepted unknown remains visible. [S10](slack-usability.md#s10--image-attachments) passed live interpretation/refusal checks. These results do not close G0/G1/G1-C. |
| R0-15 | Storage/runtime owner | A/B1/C1 verified; production startup and R2 proof remain open | Follow the [canonical Stow slices](stow-workspace-integration.md); integrate native Workspace startup directly, then prove selected-image and R2-only recovery. Export/migration only for named operator data to retain. |
| R0-16 | API owner | Existing replay store | Forward the public reconnect cursor; test through the Worker that cursor N excludes earlier events, expired history produces reset, and the documented current-state path works. Reconnect never resends a prompt. |
| R0-1/2/3 remaining evidence | Platform + operator | Correct coupled image, R0 storage/accounting prerequisites, authorized staging/task resources | Rehearse upgrade/backout and complete the frozen task/fault matrix. Record accepted changes, accounting uncertainty, recovery and cost rather than only connectivity replies. |
| R1-7a | Security/runtime owner | Disposable current container; may run alongside tenant/API design | Prove credential injection and default-deny egress feasibility before committing to the full R1 schedule; record tested artifact, unsupported traffic and residual API self-approval risk. |
| R1-5/6/7/8/9 | Identity/security/platform owners | Existing R1 lifecycle prerequisites; R1-7a for enforcement | Scoped settings/credentials/keys, strict resolution, revocation, quotas and cross-boundary tests close G1. No implicit legacy fallback on resolver errors. |
| R1-4a–4d | API + connector + platform owners | See bounded contract slices below | Deliver G1-C through existing lifecycle machinery; protect behavior before extracting runtime/event responsibilities. Local fixture work need not wait for live R0 checks. |
| R2-2/3/4/6/8 | Pilot/operator-experience owner | G1 + G1-C before external use | Own-account bootstrap, install, minimal operator visibility, operating measurements and versioned upgrade/rollback/restore guide. Slack OAuth is optional. |
| R2 pilot evidence → G3 | Pilot owner + product owner | Controlled pilots after G1/G1-C; G2 may remain open | Record failures and interventions; select R3 options only against an actual blocked workload or measured operating burden. A failed G2 attempt may supply demand evidence. |

S8/S10 source ownership has been released. Assign file ownership before dispatch;
preserve unrelated working-tree edits. Keep implementation slices reviewable
and use one bounded consequential review of new authorization, dispatch,
accounting and recovery behavior rather than repeated broad redesigns.

## Next execution batch — 2026-11-12

Outcome: public reconnects resume after the supplied event ID, and a disposable
native fixture establishes the actual Stow integration and recovery gap. The
second item follows the [canonical R0-15 plan](stow-workspace-integration.md);
its startup/migration slices remain gated by artifact and data-preservation proof.

The parent owns scope, contract decisions and acceptance in the fixed parent
chat. Reuse the existing Luna agents; no new context or larger-model assignment
is needed for this batch. The assignments below use the delegation runtime's
supported `gpt-6-luna` model. The two implementations may run in parallel because
their files and disposable fixtures are disjoint; each owner retains its tests
and evidence update rather than handing them to another agent.

| ID | Owner / model | Write scope | Depends on | Done when |
|---|---|---|---|---|
| R0-16 — locally verified | Existing inventory owner, `gpt-6-luna` / medium | `src/index.ts`, `test/worker.test.ts`, README HTTP/SSE section | Locked brief below | Implemented; public-route cursor, reset and legacy-state inspection regressions pass; production rollout remains separate |
| R0-15A — characterized | Existing dispatch owner, `gpt-6-luna` / high | Disposable probe scripts and evidence in the canonical Stow plan | Selected-image access and preflight | Exact Linux artifact facts, generic-store separation and archive/fingerprint exclusions verified; actual Workspace CLI is present, readiness/recovery contracts remain open |
| Batch acceptance | Parent; reuse the same Luna owners for checks/evidence | Owning plans and roadmap status only after results | Relevant implementation and focused review | Checks pass for the integrated revision; source, disposable-runtime and live-release evidence remain distinct |

### R0-16 brief — repair the existing public boundary

Source check at baseline `69c98f0`: `src/index.ts` forwards only the `Accept`
header to `/events`. `Conversation.onEvents` already reads `Last-Event-ID`, and
`ConversationStore` persists monotonically numbered events, retains 200 and
selects only IDs greater than the cursor. Extend those paths; do not replace the
event store or edit the Conversation lifecycle/accounting machinery.

Locked choices:

- Forward the incoming `Last-Event-ID` unchanged when present, retaining
  `Accept: text/event-stream`. Forward only these selected headers, not the
  caller's authorization or arbitrary request headers. Leave absent-header
  behavior and the existing DO cursor parser unchanged in this repair.
- Use `SELF.fetch` through the authenticated public route and a seeded keyed DO.
  Cover a retained cursor excluding IDs at/before it, no-header replay, and a
  stale positive cursor producing an id-less `reset` before retained frames.
  Read through the initial `: connected` frame and cancel the reader; do not
  wait for the never-ending stream to close.
- After `reset`, a caller discards assumptions about complete incremental
  history and inspects existing `GET /api/conversations/:key`. Test that public
  path against seeded current state without posting another message. Document
  `/context` as optional runtime history inspection, which can be unavailable.
  Reconnection or inspection never automatically resends a prompt.
- State inspection and replay are separate reads, not an atomic snapshot with
  an attached cursor. Typed status, consistent projection recovery, turn
  correlation and malformed/future-cursor policy remain explicit R1-4 work.
  This small fix does not close G1-C or prove a full caller recovery protocol.
- Correct README's statement that every frame has an ID: replayable events do;
  reset/control frames and heartbeat comments do not advance the cursor.

Keep code and its public regressions together in the same reviewable repair.
Parent review checks the header allowlist, unchanged admission/auth behavior and
test observability once; recheck only concrete fixes. There is no default Terra
review for this route-only change. After two failed bounded Luna attempts, the
parent narrows the missing fact before escalating that fact alone.

### Checks, backout and execution boundary

For R0-16, run `bunx vitest run test/worker.test.ts` during the repair. At the
integrated gate run existing `bun run typecheck`, `bun run test`,
`bun run test:workers`, `bun run check:config`, `bun run build:ui` and
`git diff --check`. R0-15A additionally requires its real disposable native
probe; local unit tests or a macOS binary do not qualify the selected Linux image.
Do not repeat image builds for the HTTP-only repair. Record actual commands,
artifact/platform hashes, failures and remaining blockers in the owning plan.

R0-16 changes no stored schema; backout is the route/documentation revision.
R0-15A leaves production startup and existing stores untouched; clean up only
its disposable resources and retain its evidence. No rollback may erase the
completed S8 receipts or unknown marker.

The operator's November 12 `Go` authorized the R0-16 repair and R0-15A disposable
qualification. Production deployment, a new storage artifact/cutover, live data
changes and paid coding-task runs are outside this batch. Existing S8/S10 action
approvals do not authorize those new operations. G0/G1/G1-C/G2 remain open.

### R0-16 implementation record

The working-tree repair over `69c98f0` changes only the selected header forwarding,
its public Worker regression and the README HTTP/SSE explanation. Parent review
found no remaining issue. The focused Worker file passed 21 tests. The integrated
gate passed 307 Bun tests (including 5 runtime tests), 255 Worker tests, all five
typechecks, configuration consistency, UI build and `git diff --check`. Logs are
`/tmp/cf-opencode-r0-16-*.log` and `/tmp/cf-opencode-next-*.log`.

Worker tests required localhost-listener access; the restricted attempt failed
before tests started, and the authorized rerun passed. These are local checks,
not a deployed reconnect test or a completed G1-C recovery protocol.

### R0-15A implementation record

The reviewed disposable runner and signed Bun probe passed on the configured
evented image digest, `linux/amd64` under ARM emulation. The actual Stow binary
reports `0.3.7`; its hash, image identity, CLI help, prior failed attempts and
successful receipt are recorded in the [canonical plan](stow-workspace-integration.md).
Direct files and generic S3-only objects were distinct. The workspace archive
omitted the S3 store, and a new signed object write after the baseline fingerprint
still produced HTTP 204. This reproduces the recovery gap; it does not repair it.

The native public MCP command bootstrapped only the synthetic bucket before
server startup. Existing Bun signing then exercised object PUT/GET. No new SDK
or signature implementation was needed. Actual CLI help shows prepare, adopt,
resume and serve plus a readiness descriptor; Go help exits are not capability
absence. A full readiness payload, registered-workspace startup, existing-data
preservation and R2-only cold recovery still require the next slices. No
production startup, image binding, provider state or stored user data changed.

### Continuation — R0-15B1 Workspace contract

Commit `5481825` contains the completed reconnect repair and A characterization;
its CI application and container-smoke jobs passed. The operator then requested
continuation. Reuse the existing dispatch owner, `gpt-6-luna` / high, for B1 in
the existing two probe scripts and canonical Stow plan. The inventory owner,
`gpt-6-luna` / medium, researches archive/identity requirements read-only.

B1 uses the same pinned disposable image and prepares one synthetic Workspace,
then consumes actual versioned readiness to configure signed S3 operations.
Verify both direct-file → S3 and S3 → direct-file bytes, stop the owned server
gracefully, and serve the same ID again with preserved data and fresh readiness.
Keep credentials inside the container and test schema/identity/path/endpoint
rejections before client calls. Preserve the default A mode and its regression.
Candidate source documentation must be proved against the actual binary.

This is a process restart on the same disposable disk, not R2-only cold recovery.
Production startup integration, archive changes, live inventory/migration and
cutover remain behind their identity/readiness/data-preservation checks. B1
does not close B–D or a broader product gate. Parent reviews before execution
and records the actual results in the canonical storage plan.

### Continuation — R0-15C1 split-archive recovery

Commit `d36bcec` records B1: the exact pinned native binary passed identity,
readiness, bidirectional byte equality and same-container process restart with
one prepare. C1 now tests a fresh disposable container using the existing split
workspace/state checkpoint and restore endpoints. It is a local archive test,
not proof of deployed R2 transport or production startup integration.

Reuse the dispatch owner (`gpt-6-luna` / high) for the native harness and canonical
evidence, and the inventory owner (`gpt-6-luna` / medium) for the bounded controller
repair and existing workspace fingerprint regressions. Reproduce the baseline
omission before editing: the current recursive `.stow` exclusion drops native
metadata beneath `/workspace/stow-workspace`. Narrow exclusion to the legacy
top-level `/workspace/.stow` only, preserving nested native metadata; keep
`node_modules` excluded at every depth. Both Git and non-Git fingerprints must
cover the included metadata. The state archive already includes the registry.

The baseline omission was reproduced in
`/tmp/stow-workspace-c1-20261112T070441Z.jpH1I0/`. Initial candidate archive
restoration passed, including native identity, completed-object bytes and public
content type. Review found a Git fingerprint gap for nested independent repos
and tracked gitlinks; both must be covered before accepting the final revision.
The final integrated gate passed 314 Bun/runtime and 255 Worker tests; type, configuration and UI checks passed.

CI for `d36bcec` passed application checks but the container smoke stalled twice
at different restore/start boundaries. Diagnostic-only commit `fddce34` adds
bounded requests, operation labels and failure process/log capture. That diagnostic run stalled in the initial `/start` while Stow health returned
200 and OpenCode logged ready. Commit `002983b` adds an absolute readiness budget,
per-request aborts and re-probes of surviving children; this repairs a proven
missing bound without claiming the original individual fetch was observed.
Final CI run `43175201864` passed both application checks and rebuilt-container smoke for code commit `002983b`.

Commit `002983b` contains the completed C1 repair and evidence. The final native
receipt at `/tmp/stow-workspace-c1-20261112T072309Z.4laibN/` passed against
controller SHA `b9ede64c69599945d48b1ad22bd0a161cdc48d9cc3301f3c05cb77d7caaeea76`.
The original container was removed, both archives restored into an explicitly
empty replacement, and the saved Workspace ID served without prepare with exact
bytes and content type. All disposable containers were removed. Local C1 is
complete; the release and broader R0-15 gates below remain open.

Acceptance: quiesce the synthetic Workspace, capture both parts, remove the
original container, restore into a fresh empty container at the same absolute
paths, and serve the same ID without preparing again. Verify completed-object
bytes and supported nondefault metadata. Record the exact controller overlay
hash separately from the pinned base image and unchanged Stow binary. Preserve
baseline failures. Multipart recovery, legacy generic-store migration, production
startup/cutover and Cloudflare/R2-only recovery remain open. No live storage or
provider calls are authorized by this disposable test.

### B2 — direct native Workspace startup (2026-11-12)

The operator's hard-cut decision and subsequent `Go` authorize implementation and
local disposable verification. Keep `/workspace`, so current HTTP and Slack
session locations need no compatibility adapter. The root preflight passed on the
exact selected Linux binary: an empty-directory input to `.` prepares the absent
root without user-visible seed files; handing the workspace and entire new
state-root Stow subtree to the agent allows native serve and same-ID restart.
Receipt: `/tmp/stow-workspace-b2-20261112T140559Z.uXONtX/`.

Reuse the existing dispatch owner (`gpt-6-luna` / high) for controller lifecycle,
entrypoint/image wiring and env/fingerprint regressions. The inventory owner
(`gpt-6-luna` / medium) owns the pure identity/readiness validator, account-seed
separation and integrated container smoke. Controller edits are sequenced. The
parent locks contracts and source freeze; one focused stronger review is reserved
for persistent identity, credential custody and restore invariants.

Fresh startup prepares only a verified empty root, saves selected nonsecret
identity in `state/stow/identity.json`, and serves that ID as the agent. Existing
or restored state must resume its saved identity or fail visibly; no automatic
legacy migration, deletion or replacement identity. A root-only readiness file
outside checkpointed state supplies validated dynamic endpoint/region/bucket and
credentials to OpenCode. Readiness failure retires the owned child and prevents
prompt startup. New native credentials require a new OpenCode process.

Conversation state checkpoints retain Stow identity/registry; account snapshots
exclude both Stow state and the initialization marker. Account seeding is fresh
and stopped only, rejects Stow state, and cannot initialize the recipient. Root
`.stow` now contains required native metadata and must be included in fingerprint
and archive. Keep `node_modules` excluded. Do not change the Worker's cached
runtime/generation lifecycle implicitly during a checkpoint.

Acceptance: real `/start`, dynamic OpenCode env, agent UIDs, bidirectional bytes,
completed-object metadata through ordinary split checkpoint/restore, distinct
identity after account seeding, and rejection of unsupported/missing identity.
Record exact image/binary/controller artifacts; perform one frozen-source native
run after focused checks. Local verification does not establish Cloudflare/R2
transport, live cutover or arbitrary background-writer recovery. No deployment,
provider task or deletion of existing operator data is part of this batch.

## R1-4 — Public caller contract and connector proof

### R1-4a: define and persist caller-visible work identity

Extend the existing admission/idempotency path in `src/conversation.ts` and
`src/state.ts`. A conversation is the continuing workspace/session context; a turn
identifies one accepted request within it. Neither the current OpenCode session
nor an SSE sequence alone identifies that request. Retain OpenCode's native
execution identity and map it to the caller-visible reference.

Before implementation, inventory existing request/response types, HTTP routes,
Slack handlers and stored-state migrations. Freeze the smallest contract covering:

- Accepted and queued responses return a persistent turn reference. An identical
  idempotent retry returns the original work/reference while queued, running or
  terminal and after DO restart; it must not identify a newer session/turn.
- Reusing a key for different request content yields a conflict before work.
  Specify key scope, retention, expired-key behavior and bounded storage. Expiry
  must not silently turn a replay of uncertain/dispatched work into a fresh prompt.
- Typed status correlates turn, native session/execution, runtime generation,
  applied credential-free configuration identity, output and accounting state.
  Preserve execution/accounting distinctions: finished execution may still have
  unresolved usage. Unknown execution or side effects remain explicit.
- Record applied settings version plus the effective configuration identity and
  selected image/runtime evidence at execution. Never include credential values;
  record unavailable identity explicitly rather than inventing a digest. A full
  SandboxSpec catalogue or editor is not a prerequisite.
- Status reports the last verified checkpoint/recovery point and what was
  restored. Recovered files/history do not imply resumed processes or replayed
  external effects. Avoid exposing raw `ConversationState` as the public schema.

Choose the supported public contract directly while pre-customer; breaking
changes may update bundled callers and fixtures together without compatibility
adapters. Record contract/event changes and explicit unsupported-version errors.
Freeze the external compatibility policy before integration pilots. Internal
storage format and public API version remain separate responsibilities.

Acceptance: accepted/queued/retried/restarted work retains one reference; output,
usage and recovery status correlate to it; a stale or conflicting request cannot
dispatch again or mutate a newer turn. Review contract examples before coding.

### R1-4b: neutral interactions and recoverable output

Reuse `stopSlackWork`, `pendingForms`, `replyToForm`, permission replies,
`ConversationEvent`, `ConversationStore` replay and existing admission/usage locks.
Move shared behavior into neutral handlers; Slack renders their outcomes and the
HTTP API exposes them. Do not reproduce provider dispatch or settlement in adapters.

- Poll and expose pending questions for HTTP-driven work as well as Slack work.
  Validate typed answers against the current pending form/session/turn and reject
  stale or foreign answers. Unreadable pending state is not proof there is none.
- Expose permission and question decisions under the authenticated caller's
  tenant/agent/conversation scope. Carry the originating actor for attribution;
  a caller-supplied display name is not authorization. Preserve Slack membership
  verification in its adapter.
- Cancellation targets exact work and returns structured outcomes. Distinguish
  request acknowledgement, observed execution stop and accounting settlement.
  Cancelling queued work compare-clears that item only; a delayed action cannot
  clear a newer follow-up. Disconnecting a client only unsubscribes output.
- Do not release usage ownership because of timeout, interrupt acknowledgement,
  missing output or caller disconnect. Continue existing settlement/recovery
  rules; no automatic resend of ambiguous provider work.
- Reuse bounded, ordered event replay. Correlate events with turns, document
  retention/reset semantics and provide current status after a replay gap.
  Subscriber slowness must not stop execution or create unbounded output storage.
- Separate permission failure, unsupported action, stale state, quota/capacity
  refusal and uncertain dispatch in typed responses. Keep operator-only
  reconciliation out of this ordinary interaction surface.

Acceptance: public-route tests cover question/permission decisions, targeted
cancellation before/after dispatch, late actions, disconnect/reconnect, expired
history and DO restart. Verify caller return, runtime stop and accounting state
independently; no universal child-process-stop claim from an interrupt response.

### R1-4c: reference client and connector conformance

Build a small CLI/example client using only public HTTP/SSE. It must not import
server internals, call private DO routes, read Slack configuration or implement
its own queue/accounting engine. A large SDK and another commercial integration
are not prerequisites.

The same conformance cases exercise public HTTP and the applicable Slack adapter
paths: submit/follow-up, accepted/queued identity, retry, question answer,
permission allow/reject, cancellation, disconnect/replay, runtime restart,
recovery inspection and scoped authorization. Compare underlying outcomes rather
than requiring identical presentation or overriding S10's immediate-image limits.

Acceptance: no Slack credentials are configured for the reference-client run;
all mandatory cases pass, existing Slack regressions pass, and a clean example
shows how to integrate without editing the server. Complete the shared cases
before expanding the connector list.

### R1-4d: extract only protected runtime/event responsibilities

After the shared contracts and regressions identify actual seams, extract the
existing `ContainerRuntime` / `EventStream` responsibilities from Conversation
(audit 24). Keep the current container API, checkpoint format, source accounting
and recovery ownership. Do not add speculative backend interfaces or a process
manager. This extraction must not delay the early credential/egress proof.

Acceptance: shared behavior remains unchanged under contract, lifecycle,
accounting and recovery tests. Adapters call one lifecycle implementation.

## R1 boundary proof and strict identity

R1-7a uses disposable synthetic provider/git credentials and the actual selected
Linux image. Verify the supported Container-to-trusted-service route, outbound
enforcement, injection and failure behavior for provider HTTP/SSE, clone/fetch,
package access and any supported DNS/WebSocket traffic. Record unsupported paths
explicitly and reject them rather than assume an HTTP proxy covers them.

Repository-controlled test/typecheck code must fail to recover long-lived
credentials through files, child environments, process inspection, clone args or
accessible internal APIs. A proxy failure must stop affected work, not enable
direct credential-bearing fallback. Use real runtime probes, not glob-rule tests.
Record the OpenCode API self-approval residual separately; external provider
credential custody alone does not establish a secure approval boundary.

R1-5/6/9 must test absent binding, unknown binding, invalid identity and resolver
unavailability distinctly. Strict mode never creates legacy work, reads global
settings/seeds or dispatches provider work after resolution failure. Migration
compatibility requires explicit operator configuration. Exercise cross-tenant
HTTP, SSE, questions, permissions, cancellation, recovery, quotas, checkpoints
and key revocation; own-account deployment is not a substitute for these checks.

## Measurement and pilot protocol

R0-3 owns the baseline; R2-6 extends it. Keep one task/fault inventory and results
record rather than separate connector benchmarks with incompatible definitions.

Before any paid/live run, record the approved destination/resources, workload,
case selection, runtime/image/model versions, cold/warm conditions, success
criteria, numeric pass thresholds and spend budget. This document does not set
new provider-spend or production-action authorization.

- Use at least ten predeclared coding tasks across at least two representative
  repositories. Include file changes, a defect/regression test, multi-file work
  and continuation after restart. Accepted means the requested observable change,
  relevant checks and required persisted result pass review. Report all attempts
  and failures; `READY`/text canaries measure connectivity only.
- Exercise duplicate delivery/lost acknowledgement, client reconnect, runtime
  restart, checkpoint failure and ambiguous dispatch separately. Include
  cancellation with unfinished accounting. Define recovery success and its
  clock for each case; do not infer automatic replay or zero spend.
- Record accepted/attempted tasks, unattended completions, first-output and
  completion latency, restore time, operator interventions and hands-on minutes,
  oldest unresolved hold and cancellation/accounting outcomes. Small authored
  samples describe these tasks, not overall model accuracy or a production SLA.
- Record provider actuals where available, container runtime, storage/requests
  and failed-attempt costs. Allocate shared infrastructure over a stated window.
  Cost per accepted task includes unsuccessful attempts; unresolved costs stay
  unknown, never zero. Report operator time separately; any monetary valuation
  requires an explicit rate. Do not claim a cost advantage from model tokens alone.

G2 recruits five external own-account teams after G1/G1-C. Freeze time/effort
targets before their attempts. Time prerequisite setup separately from install
with ready prerequisites; retain failed attempts and every builder intervention.
Each team completes an accepted task, repeats useful work on a later day, and
performs the prescribed upgrade and rollback/restore rehearsal. At least one
independent developer integrates a non-Slack application using public docs/examples
without server-source imports or a bespoke backend patch. Report elapsed and
hands-on time, support required and measured costs. The builder's reference CLI
alone does not prove low integration effort.

Do not commit the broad R3 package first. Record each configuration-blocked task,
affected teams and workaround, then try the smallest supported preset. Select a
catalogue/sizing/spec/UI slice only if it enables that task or reduces a named
operating burden without weakening G1/G1-C. Billing, marketplace, managed hosting,
PR review UI and alternative runtimes remain separately justified later work.
Do not require all five teams to pass G2 before evaluating a configuration-blocked
pilot; controlled pilot observations can justify its smallest remedy while G2
remains open. They do not authorize a broader rollout or close G2.

## Verification and completion record

Documentation work checks links, ticket dependencies and contradictory gate
claims. Implementation slices run the relevant existing tests, then the required
integrated type/config/unit/Worker/UI checks when source integration is complete.
Run container/staging checks appropriate to the boundary and record environmental
limitations; local mocks never close a runtime or external-pilot gate.

Each completed slice updates the roadmap gate ledger with artifact/revision,
commands/case results, evidence link, remaining uncertainty and next owner/action.
Keep exact S8 receipts and approvals in their canonical plan/runbook. Never mark
G0/G1/G1-C/G2 passed merely because a plan, build or local test suite is complete.
