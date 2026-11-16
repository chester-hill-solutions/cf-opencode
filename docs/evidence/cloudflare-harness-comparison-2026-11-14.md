# Cloudflare harness comparison — 2026-11-14

This is primary-source research for the requested comparison, not a new plan or a benchmark. It compares the current Cloudflare
building blocks and examples to the code-assessed Aboiteau implementation. No external harness was deployed or run; no provider calls,
paid resources or credentials were used.

## Product-overlap update — 2026-11-15

The original infrastructure comparison remains useful, but product positioning
must also account for OpenCode Console's hosted agents. Current official sources
state that Slack agents (early access) run in isolated development sandboxes,
reply in threads and support in-message approvals. OpenCode also ships a remote
web/server workflow, and Console provides workspace/member/service-account
budgets and usage controls. These are documented vendor offerings; their hosted
runtime was not exercised by this assessment.

- [Hosted Slack agents and approvals](https://opencode.ai/console/integrations/slack)
- [Remote web/server](https://opencode.ai/docs/cli/web)
- [Console budgets](https://opencode.ai/docs/console/budgets/)
- [Hosted session/sandbox retention disclosure](https://opencode.ai/legal/privacy-policy)

Therefore Slack, browser access, sandbox execution, saved conversations and generic
budget controls are not defensible unique-feature claims. Console also documents
hosted session/sandbox retention; do not imply it has no persistence merely because
the small Cloudflare Linux runner example lacks snapshots.

The narrower implemented Aboiteau distinction is a self-hosted Cloudflare-specific
operating package with owner-controlled workspace/state archives, checkpoint/idle
close and guarded recovery workflows, plus application-level admission holds,
usage settlement and operator-reviewed reconciliation. OpenCode is itself
self-hostable; generic self-hosting is not unique either. Exact absence of equivalent
Console recovery/reconciliation behavior is unverified. Describe our implemented
controls and deployment model rather than asserting competitors cannot reproduce
them. Comparative failure recovery, operator effort and total cost remain unmeasured.
The completed two-task smoke establishes working coding paths, not a product moat.

## Conclusion

Cloudflare now supplies much of the durable agent machinery Aboiteau also implements: sessions, durable submission, queued follow-ups,
steering, abort, events, recovery wakes and tool integration. Full Linux execution is available by adding a sandbox; it is not unique
to Aboiteau. Aboiteau's potentially useful additional layer is its integrated operator workflow, explicit usage holds and
settlement/reconciliation, portable encrypted workspace/state recovery and Slack adapter. Those additions require demonstrated
outcomes, not just feature count. This comparison does not establish that Aboiteau is faster, cheaper, safer or better at completing
tasks.

**Aboiteau revision note:** the checkout advanced during this research to
`d428cf5` (delivery-batch qualification record). Source spot-checks show durable
permission-notification retries and FIFO/steer/interrupt handling are now present
in `src/conversation/turn-execution.ts`, `src/state.ts`, `src/index.ts` and the
admission code. The earlier assessment's singleton-queue and failed-notification
behavior describes its earlier snapshot, not an outstanding claim against this
revision. No new full Aboiteau test run was performed for this comparison.

## Separate the comparables

| Comparable | What it supplies | Boundary to keep explicit |
|---|---|---|
| Agents SDK runtime / Lifecycle | Durable Object state, capabilities, durable wake jobs and client plumbing | It is infrastructure on which a harness and product are built. |
| OpenCodeHarness + Workerd OpenCode | OpenCode's loop/transcript/recovery inside a DO; durable operations and events | The example's Worker-based file/JavaScript tools are not a Linux shell. |
| PiHarness / Think / ThinkHarness | Alternative DO-hosted loops with storage/recovery and reusable caller APIs | Choosing one changes loop/tool semantics; it is not automatically an OpenCode drop-in. |
| Agents harness + Linux sandbox | Durable control plane outside a Linux execution environment | Host applications still own identity, allowed tools/network, recovery policy and business rules. |
| Sandbox SDK Linux OpenCode runner | Repository clone, background OpenCode task, status/events and resulting diff | The inspected runner loses unfinished work on container loss; platform persistence mechanisms exist separately. |

Cloudflare's [harness overview](https://developers.cloudflare.com/agents/harnesses/) distinguishes the runtime from the loop and marks
several integrations experimental. Treat examples as compositions of those layers, not evidence of a fully operated service or
universal task reliability.

## OpenCodeHarness: close overlap in the control plane

The [official integration](https://developers.cloudflare.com/agents/harnesses/opencode/) hosts OpenCode in a plain Durable Object,
saves its state in SQLite and uses Lifecycle jobs to wake interrupted sessions. This is a different placement from Aboiteau's OpenCode
server in a Linux container.

In the inspected [harness source](https://github.com/cloudflare/agents/blob/main/packages/agents/src/harness/opencode/harness.ts),
`enqueue()` schedules a wake before submitting input, derives a message ID from the operation ID, checks whether it is known,
explicitly chooses `queue` or `steer`, and returns an operation receipt. `withdraw()` cancels a queued inbox entry or interrupts a
running operation. `wait()` cancellation stops the wait, not the underlying work. These are implemented paths, not only README claims.
The [public types](https://github.com/cloudflare/agents/blob/main/packages/agents/src/harness/opencode/types.ts) include pending
operation status, permission requests/replies, snapshots, text deltas and durable event log sequence numbers.

The [example server](https://github.com/cloudflare/agents/blob/main/examples/next/harnesses/opencode/src/server.ts) uses
`@opencode/sdk/workerd`, Workers AI through the `AI` binding and a durable `Workspace`. Its [workspace
plugin](https://github.com/cloudflare/agents/blob/main/examples/next/harnesses/opencode/src/workspace.ts) removes OpenCode's local
file/shell tools and installs Workspace tools. The configured `exec` backend runs JavaScript modules in a Worker Loader isolate, with
workspace filesystem operations and a host-mediated Git module; it has no shell, npm or package installation. That limits this
example's ability to build and test an ordinary repository. It does not mean OpenCodeHarness can never use a separate Linux tool
environment.

**Comparison implication:** durable operations, queue/steer/cancel and replay are substantial overlap. Aboiteau should not count all of
that as unique value. The full Linux development environment is a meaningful difference from this particular Workerd example, but not
from the harness-plus-sandbox composition.

## Cloudflare's base harness options are already substantial

The [Think overview](https://developers.cloudflare.com/agents/harnesses/think/) distinguishes `AIChatAgent` as message/stream plumbing
around an application-owned model call, while Think wires the loop, tools, sessions and context management. It exposes durable
submission/idempotency and recovery-aware turn APIs. These capabilities overlap with application code that would otherwise need to be
written for a cloud agent.

The newer [ThinkHarness implementation](https://github.com/cloudflare/agents/blob/main/packages/agents/src/harness/think/harness.ts)
owns persisted operation records, session transcripts and stream segments, wakes sessions through Lifecycle, and handles interrupted
tools using recovery policy. It rejects `whenBusy: "steer"` rather than silently changing its meaning. A shared interface does not
imply every harness has identical semantics.

[PiHarness](https://developers.cloudflare.com/agents/harnesses/pi/) integrates Pi Durable's transcript, inbox, retries and recovery
with DO SQLite and wake jobs. It provides operation IDs, queued follow-ups, steering and reconnectable session views. Its documented
recovery can repeat model calls, and only tools declared replay-safe are automatically rerun. Its current limitations include no
tool-approval step, and abort waits for a tool that ignores its abort signal. Its session `maxTurns` limits tool rounds; that is not a
hard dollar-spend cap.

**Comparison implication:** use the relevant harness as the baseline. Comparing Aboiteau only to a minimal `Agent` class would
overstate the amount of missing machinery Cloudflare leaves to the application.

## Linux and persistence are composable

The [Agents sandbox guide](https://developers.cloudflare.com/agents/tools/sandbox/) puts Linux commands and project files in a separate
attached container while the agent state remains outside it. Default network access is restricted. Files persist while that container
runs; stopping it loses unsaved files. The guide points to snapshots and durable execution for recovery. Thus a Worker-hosted loop can
drive real Linux tools without putting the entire loop in Linux.

Cloudflare's [snapshot example](https://developers.cloudflare.com/sandbox/files/save-and-restore-a-workspace/) serializes disk
operations, stores a snapshot ID and restores from it; a missing snapshot fails rather than silently creating an empty workspace.
Snapshot content excludes mounted directories, memory and running processes. The [automatic-save
example](https://developers.cloudflare.com/sandbox/files/save-a-sandbox-automatically/) adds idle saves and periodic checkpoints. These
are platform mechanisms and examples; they do not by themselves prove application-specific consistency, credential handling or
interrupted external-effect recovery.

**Comparison implication:** Aboiteau's encrypted split archives and explicit portable restore are more specific application behavior
than merely retaining a container, but Cloudflare already provides persistence building blocks. The fair comparison is recovery
guarantees and tested failure cases, including image changes and missing/corrupt checkpoints.

## The current Linux OpenCode runner is the most direct small example

The current [OpenCode runner](https://github.com/cloudflare/sandbox-sdk/blob/main/examples/coding-agents/opencode/src/index.ts) invokes
`opencode run --format json --auto` with a selected model and interprets text/error events. It delegates lifecycle to a [shared
runner](https://github.com/cloudflare/sandbox-sdk/blob/main/examples/coding-agents/runner/sandbox.ts) that clones a GitHub repository,
starts one background task, records PID/events/ exit code in files, polls through DO alarms and exposes task outcome and diff. If the
container is gone while a task marker remains, `readTask()` reports `lost`. A new container starts with fresh disk; this example does
not wire in automatic workspace snapshots or Aboiteau-style portable checkpoints.

The [HTTP handler](https://github.com/cloudflare/sandbox-sdk/blob/main/examples/coding-agents/runner/handler.ts) provides
repository/task/events/diff/reset routes, validates inputs and refuses a second running task. It selects a sandbox from a URL name
without implementing caller authentication. That is an inspected example limitation, not a statement that Cloudflare cannot
authenticate or isolate applications built on it.

Its [outbound handler](https://github.com/cloudflare/sandbox-sdk/blob/main/examples/coding-agents/runner/outbound.ts) is materially
relevant to Aboiteau's open credential boundary: the sandbox starts with `enableInternet: false`; intercepted HTTPS requests are
allowed only to the configured AI Gateway path or GitHub. The Worker adds gateway/GitHub credentials after the request leaves the
sandbox, and OpenCode receives a placeholder gateway credential. This supplies a concrete implementation pattern for keeping those
particular credentials out of repository-controlled code. It is not proof of universal secret safety: GitHub access here is
hostname-wide, not a complete per-repository/action authorization product, and user-provided files or agent output can still contain
sensitive data.

Cloudflare's [sandbox security model](https://developers.cloudflare.com/sandbox/concepts/security/) explicitly treats a sandbox as the
unit of trust: processes can access its files and localhost services, and a different Linux UID is not a security boundary on the
deployed platform. [Network guidance](https://developers.cloudflare.com/sandbox/network/) recommends external credential injection and
explicit egress. This is directly relevant to Aboiteau's already-recorded need for OS/network proof rather than permission-pattern
claims.

## Other close and adjacent comparables

### Exo: an architectural peer

The [Cloudflare adapter overview](https://developers.cloudflare.com/agents/harnesses/exo/)
describes a Rust/Wasm control plane in Workers and per-thread Durable Objects,
an account object with vault/storage/sandbox coordination, and separate Linux
execution. Its published adapter supports Exo's basic and Codex harnesses;
OpenCode compatibility is not established by this comparison.

The parent inspected source at commit
[`1eeab021a854dc8db502d82b9fe656cbaf044671`](https://github.com/exoharness/exo/commit/1eeab021a854dc8db502d82b9fe656cbaf044671):

- [`index.ts`](https://github.com/exoharness/exo/blob/1eeab021a854dc8db502d82b9fe656cbaf044671/exoharness/cloudflare/src/index.ts)
  authenticates with Cloudflare Access or a configured bearer token and routes
  managed turn/event requests to a thread object.
- [`provider.ts`](https://github.com/exoharness/exo/blob/1eeab021a854dc8db502d82b9fe656cbaf044671/exoharness/cloudflare/src/provider.ts)
  runs queue recovery at thread startup and from alarms; the account object
  owns shared records and vault operations. [`runtime.ts`](https://github.com/exoharness/exo/blob/1eeab021a854dc8db502d82b9fe656cbaf044671/exoharness/cloudflare/src/runtime.ts)
  bridges the portable Wasm runtime to asynchronous host I/O.
- [`stored.rs`](https://github.com/exoharness/exo/blob/1eeab021a854dc8db502d82b9fe656cbaf044671/crates/exoharness/src/turn_coordinator/stored.rs)
  persists FIFO entries, principal-scoped deduplication receipts and control
  state, with serialized ownership checks and idempotent acknowledgement.
- [`sandbox.ts`](https://github.com/exoharness/exo/blob/1eeab021a854dc8db502d82b9fe656cbaf044671/exoharness/cloudflare/src/sandbox.ts)
  verifies saved sandbox identity, intercepts outbound HTTP/HTTPS with direct
  Internet disabled, and snapshots before normal stop. These are filesystem
  recovery mechanisms, not proof of process-memory or external-effect recovery.
- [`network.ts`](https://github.com/exoharness/exo/blob/1eeab021a854dc8db502d82b9fe656cbaf044671/exoharness/cloudflare/src/network.ts)
  asks the trusted account provider for policy and credential headers outside
  the sandbox; failed lookup fails the request. This is an inspected placement
  pattern, not a complete security audit.

Exo is a closer comparison to Aboiteau than a minimal chat example: both add
application orchestration around persistent agent work and Linux environments.
Its adapter's documented recovery still permits repeated model calls after a
crash, and ambiguous tool outcomes require reconciliation. No comparative task,
cost, recovery-rate or implementation-quality winner was established.

### E2B and Daytona: alternative execution substrates

[E2B persistence](https://docs.e2b.dev/sandbox/persistence) documents pause/resume
with filesystem and memory, preserving running processes on resumable healthy
snapshots. It also documents refusal/reboot behavior when the guest was hung;
memory restoration is not unconditional. [E2B Secrets](https://docs.e2b.dev/secrets)
and its [request-injection explanation](https://e2b.dev/resources/introducing-e2b-secrets)
keep configured secret values outside the sandbox and insert headers on matching
outbound requests.

[Daytona snapshots](https://www.daytona.io/docs/snapshots/) distinguish container
filesystem-only snapshots from VM snapshots that can include memory, and provide
warm pools. These are documented substrate capabilities; neither vendor's
runtime was exercised or source-audited here.

These systems compete with infrastructure Aboiteau operates, not necessarily
with the whole operator application. Disk persistence, a shell or a resumable
machine alone does not supply Aboiteau's usage-settlement policy or prove a coding
task completed correctly. Conversely, Aboiteau's portable file/history archives
do not establish the same guarantee as preserving process memory.

## Comparative decision evidence still needed

The closest execution-equivalent baseline is OpenCodeHarness plus a Linux
sandbox, alongside Aboiteau with the same OpenCode/model/repository where
feasible. Exo is an architectural peer; a different harness/model confounds
coding-quality comparisons. A DO-only JavaScript tool example is a separate
workload class, not an equivalent Linux build/test baseline.

Use predeclared tasks and injected failures: client disconnect, DO eviction,
container loss, lost prompt acknowledgement and failed checkpoint. Report
accepted tasks/all attempts, duplicate external effects, recovered files/history,
operator interventions and model/container/storage cost. Hold model/tool access
and warm/cold conditions constant where supported; name non-equivalences.
These are proposed evaluation criteria, not a new execution authorization or
roadmap gate. Runtime speed, cost and task-quality superiority remain unknown.

## Source scope and version limitations

Inspected on 2026-11-14 from default-branch source using the connected GitHub reader. The repository can change after this date. File
Git blob identities:

| Repository/path | Inspected blob |
|---|---|
| `cloudflare/agents`, `packages/agents/src/harness/opencode/harness.ts` | `60a53571e9ab23f012a4fedbf5aed5255fad773e` |
| `cloudflare/agents`, `packages/agents/src/harness/opencode/types.ts` | `5a1aec11c3823b2723ac7e5e9bcb539987222edb` |
| `cloudflare/agents`, `examples/next/harnesses/opencode/src/server.ts` | `79dad9cfeccf1d1617bac0cdb23e34e3083c2ac4` |
| `cloudflare/agents`, `examples/next/harnesses/opencode/src/workspace.ts` | `8becea3dd80e12d0fdb8cdd0ac60ac28255d8898` |
| `cloudflare/agents`, `packages/agents/src/harness/think/harness.ts` | `691b81ffd8bc9013d9f7bfc772ca8a5674aa6e66` |
| `cloudflare/sandbox-sdk`, `examples/coding-agents/opencode/src/index.ts` | `f9331c5ca75268b7652052e9a75739edc13067f4` |
| `cloudflare/sandbox-sdk`, `examples/coding-agents/runner/sandbox.ts` | `ac416250c16511732ed44a55edd7b825e4019438` |
| `cloudflare/sandbox-sdk`, `examples/coding-agents/runner/outbound.ts` | `9cb80650360b188a3dcb431fd08ee3310a47685a` |
| `cloudflare/sandbox-sdk`, `examples/coding-agents/runner/handler.ts` | `1d49fb1436551888baa148fdea013ccfec27b13d` |

The current runner Dockerfile pins Sandbox shim `1.0.3` and OpenCode platform binary `1.18.32`. The corresponding official guide still
shows `1.0.1` and `1.19.4`; do not mix those artifacts in a claimed reproducible result. An older search-indexed `examples/opencode`
web-proxy example no longer exists at the current `main` path; it is not the basis of the current-runner comparison.

No whole-repository audit or comparative runtime/task test was conducted. Cost and latency comparisons, cold-recovery success rates,
model effectiveness, operator effort and equivalent security guarantees remain unmeasured. Missing capabilities are attributed only to
the inspected example or documented API, not asserted absent from the whole Cloudflare platform.
