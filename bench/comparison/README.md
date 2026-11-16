# R0-23 comparison preparation

This directory implements the task protocol, trusted evaluator, evidence schema
and a model-free OpenCodeHarness/Linux-adapter fit probe. The
[canonical roadmap](../../docs/roadmap.md) schedules the work. **There are no
head-to-head coding results yet. C0 remains open.**

The [frozen preparation manifest](protocol.freeze.json) and
[v3 hardening receipt](../../docs/evidence/r0-23-hardening-2026-11-14.json)
identify the checked revision. The manifest intentionally leaves live execution
ineligible until its named prerequisites are resolved.

The suite is authored for diagnostic control: two small, dependency-free Bun
repositories exercise parsing, numeric boundaries, CLI publication, concurrency,
cancellation and lifecycle behavior. They are not a random sample of real
projects and do not complete G0's representative-workload qualification. Broader
task selection must be frozen before making broader product-quality claims.

## Frozen cases

Every task starts from its repository's original base, independently of other
tasks. Acceptance requires its trusted oracle and the public fixture tests.

| ID | Repository | Change and observable result |
|---|---|---|
| L1 | ledger | BOM/CRLF/blank/final-line NDJSON handling; malformed input names its physical line |
| L2 | ledger | Exact signed decimal cents; reject malformed and unsafe values |
| L3 | ledger | Safe prototype-like currency keys; reject invalid or overflowing totals |
| L4 | ledger | Stable ID deduplication, conflict refusal and independent returned records |
| L5 | ledger | CLI validates before atomic publication; failures preserve the prior output |
| Q1 | queue | Rejection/synchronous throw releases the slot and later work completes |
| Q2 | queue | Stable queued priority order without preempting running work |
| Q3 | queue | Pre-start cancellation removes only its job; running work keeps its slot |
| Q4 | queue | Validated live concurrency changes, preserving running jobs |
| Q5 | queue | Multiple idle waiters include queued work and work across repeated batches |

Exact prompts and expected observations live in `protocol.ts`. `fixtures.ts`
contains the base source and trusted reference repairs. **Never copy the whole
benchmark directory into an agent's workspace.** `prepare` emits only the base
repository, its public test and a separate prompt; references and oracles remain
outside the agent checkout. Evaluate after stopping agent writes. This is a
correctness evaluator, not an adversarial-code security sandbox.

```sh
bun bench/comparison/cli.ts selfcheck
bun bench/comparison/cli.ts manifest
bun bench/comparison/cli.ts prepare L1 /tmp/r0-23-L1-empty
bun bench/comparison/oracle.ts L1 /tmp/r0-23-L1-empty
bun bench/comparison/cli.ts summary /path/to/attempts.jsonl
```

The oracle command is expected to fail on the unchanged base. Selfcheck proves
all ten base cases fail their target check and all ten trusted references pass,
and runs the public tests on both forms. It reports zero provider calls and
leaves model effectiveness unmeasured. It also verifies reproducible Git base
commits. Do not convert these reference checks into agent task successes.

## Trial design and decision rules

The primary arms are Aboiteau and OpenCodeHarness plus native Linux tools. The
first stratum compares complete configurations with tool/system-prompt/provider
differences disclosed. A matched-orchestration stratum is unrated until those
definitions and the upstream model route are proved equivalent.

- Ordinary matrix: 10 tasks × 3 repetitions × cold/warm × 2 arms = **120 attempts**.
- Fault matrix: 5 named faults × 3 repetitions × 2 arms = **30 attempts**.
- Total: **150 attempts**, with a fresh base per trial and alternating arm order.
- Warm trials prime only the runtime, without a previous model task or solution.
- Faults: client disconnect, DO eviction, container loss, lost acceptance response,
  failed checkpoint. Exact triggers and expected evidence are in `protocol.ts`;
  native injection endpoints are not yet implemented/qualified.
- A client deadline bounds observation; it does not prove model or child work
  stopped and is not a dollar-spend ceiling. Preserve unknown cost as `null`.

The predeclared candidate threshold is at least 90% accepted attempts, no
accounting/security/false-recovery violations, no more than 5 percentage points
acceptance regression, and at least 20% reduction in measured cost or operator
interventions without more than 10% regression in other measured cost/latency.
These are decision criteria for this diagnostic workload, not an SLA or an
automatic migration instruction. Unknown costs/equivalence leave the decision
inconclusive. No per-task p95 is reported from three repetitions; a mixed-task
distribution must be labeled as such even when it has at least 20 samples.

`results.ts` validates trial identity, frozen source/protocol identity and evidence
shape; rejects duplicate trial rows and false acceptance without oracle/public
checks; keeps failures/refusals/unsupported cases visible; separates unrecorded
trials; and propagates unknown cost. A receipt's assertions still require review
against actual artifacts. The summary deliberately does not pick a winner.

The protocol digest covers task/threshold definitions, fixture/evaluator code,
baseline runtime code and lockfile, and the pinned native artifact. A change to
those inputs invalidates earlier attempt identities. Freeze a new revision and
retain earlier observations rather than rewriting their evidence.

## Baseline fit checks

Production dependencies and the production entrypoint are unchanged. Install the
separate exact package/lock with scripts disabled, then generate/bundle offline:

```sh
bun install --cwd bench/comparison/baseline --frozen-lockfile --ignore-scripts
bun bench/comparison/baseline/preflight.ts
./node_modules/.bin/tsc -p bench/comparison/tsconfig.json
./node_modules/.bin/tsc -p bench/comparison/baseline/tsconfig.json
bun test bench/comparison/results.test.ts bench/comparison/linux.test.ts bench/comparison/task.test.ts bench/comparison/runtime.test.ts
bun bench/comparison/baseline/local-smoke.ts
```

Pins: Agents 0.33.0, OpenCode SDK/plugin 2.2.5, AI SDK provider types 3.0.8 and
OpenAI-compatible provider adapter 2.0.93 (V3; exact transitive types in lock). The
native template uses the already qualified image/profile imported from
`scripts/native-storage-qualification/artifact.ts`. Preflight uses an all-zero
account and `wrangler deploy --dry-run`, creates no resources, and generates
`baseline/bindings.generated.d.ts` and the derivative `baseline/freeze.generated.ts`.
The latter is excluded from its own digest to avoid a hash cycle. Install scripts remain blocked; the Workerd
probe does not need the native optional package postinstalls.

The local smoke starts only a disposable loopback Worker from the precompiled
bundle, runs the real SDK with an in-process synthetic streaming model and an
explicitly simulated tool plane, checks the five-tool sequence, authentication,
one-shot refusal, labeled cached receipts and cleanup, then stops its owned server
and removes local state. A second probe runs the general task plugin and the
actual OpenAI-compatible request/parser adapter against mocked HTTP/SSE: five
tools, six synthetic model requests and terminal usage receipts. A task API check
proves missing native bindings fail durably without a provider call; retrying the
same trial and cleanup preserve its tombstone. It makes no external model-provider
calls. Local compatibility is 2026-11-11 because that
is the installed Workerd binary's newest date; the native template targets
2026-11-14. Vite source-loading failed before test execution; the precompiled
Worker is the verified local path. Neither result qualifies native Linux.

`LinuxToolPlane` executes a fixed Bun file handler or an intentional shell
command, bounds input/output, rejects file escape/symlink paths and ambiguous
edits, and propagates direct-process cancellation. Local process checks run on
the host platform; they do not prove deployed sandbox security or that descendants
stop. The original model-free plugin accepts only its fixed probe sequence.
The separate general task adapter below is implemented, with local evidence;
its native deployment and real-provider equivalence remain unqualified. No
native recovery/checkpoint fault adapter has been wired for the comparison arm
yet; do not label the arm execution-ready.

## Task controller (v3)

`TaskBaseline` gives each frozen ordinary trial its own DO and native container.
The API is authenticated with the benchmark control token; it accepts only
task ID, protocol hash, cold/warm condition, repetition and the deterministic ID
from `taskAttemptID(...)`. Aliases cannot create another execution of the same
trial. Client-supplied prompts, models, endpoints, credentials and fault cases are
rejected. Changed configuration, protocol or provider credential conflicts with
the retained attempt identity, including when the SDK boots after a restart.
Only a digest is retained; the credential is never stored in the receipt.

| Endpoint | Behavior |
|---|---|
| `POST /tasks/:id` | Durably admit once, prepare only base fixture files, then submit the frozen prompt; return 202 for new or 200 for cached admission |
| `GET /tasks/:id/receipt` | Passive labeled receipt; does not boot/resume the model |
| `POST /tasks/:id/observe` | May resume the original SDK operation, then observe for up to one second; never resubmits the prompt; a missing pre-admission result stays unconfirmed |
| `GET /tasks/:id/snapshot` | Bounded file export after a done operation; explicitly reports unproven descendant quiescence |
| `POST /tasks/:id/cleanup` | Fence new work, independently attempt container stop and SDK teardown, retain the journal/tombstone and report partial confirmation; provider stop remains unproven |

Task configuration is empty and the provider credential is absent by default. The service
requires an explicit `BENCH_TASK_CONFIG` JSON object with `enabled: true`, the
generated protocol hash, positive `spendBudgetUSD`, `deadlineMs` (1–900 seconds),
and `model`: `{model, baseURL, temperature, maxOutputTokens, contextTokens,
maxModelCalls, requestTimeoutMs}`. Only HTTPS OpenAI-compatible chat routes are
implemented. Unknown settings fail closed. Pin those settings in the protocol
before a real run; setting this configuration is not runtime qualification.
Supply `BENCH_TOKEN` and `BENCH_PROVIDER_KEY` as Worker secrets when authorized; never put a real
credential in the checked-in template or container environment. The offline
preflight uses only noncredential stubs to generate their binding types. The
adapter sends only to the configured chat-completions URL and refuses redirects.
Responses, tool output, durable cached output and receipt counts are bounded.
Run trials serially. Durable Object-managed containers reject Wrangler's
`max_instances` field; this template does not enforce a shared instance cap.

The spend value records scope; it is **not an enforced dollar ceiling**.
The model-call count and request deadlines bound particular operations, without
proving billing or termination. Usage tokens are recorded from terminal stream
events; prices stay `null`. A missing/error/truncated terminal stream leaves
usage unknown and blocks automatic model continuation. Started tool calls are
stored before execution. Repeated completed calls return bounded cached output;
started, failed or uncached outcomes refuse replay. This policy is a comparison
adapter choice and must be disclosed when comparing upstream defaults.

Unconfirmed launch, process, output or cancellation outcomes mark the tool
`uncertain` and the attempt `ambiguous`, blocking subsequent model/tool effects.
An observed nonzero process exit still permits corrective coding work. A lost
tool-receipt acknowledgement preserves the unresolved effect rather than
rewriting a successful execution as a failed tool.

SDK submission has separate `pending`/`accepted` evidence. A `not_found` query
started before admission cannot invalidate a later acceptance. Cleanup cancels
the local attempt signal before I/O, fences startup/submission continuations,
and lets container stop proceed even if SDK or receipt storage stalls.
`runtimeStopped`, `coordinatorDisposed`, `cleanupRecorded` and
`stopFenceRecorded` describe separate observations; 503 preserves partial proof.
SDK-close retries observe the same underlying operation until all prior calls
settle and final disposal completes. A timed-out observer is not completed
teardown. Successful teardown also disables Lifecycle alarms; terminal/native
attempts reject SDK boot on later wakes. These are local code checks, not native
termination or provider-cancellation qualification.

Setup interrupted before SDK submission is not automatically repeated. Container
loss refuses a fresh replacement; recovery/checkpoint controls remain open.
The controller's `done` means an SDK operation ended: `oraclePassed` stays `null`.
Export to a separate trusted checkout, verify public test files against the base,
stop agent writes and run the external checks before assigning a task outcome.
An exported snapshot alone proves neither quiescence nor fault recovery.

The [v1 manifest](protocol.freeze.v1.json) retains the original preparation
identity; [v2](protocol.freeze.v2.json) adds the task controller, provider adapter
and journal. V3 hardens cancellation, admission/observation ordering and cleanup.
Earlier observations are preserved, not relabeled as v3 results. The
[scoped audit](../../docs/evidence/r0-23-hardening-2026-11-14.md) records the
reproduced defects and remaining limits.

## Live smoke runner (2026-11-15)

`bun bench/comparison/live.ts all` owns one explicitly frozen disposable scope.
It deploys, observes authenticated readiness, runs the model-free native gate,
dispatches the four authorized cold L1/Q1 cells serially and removes the scope.
The selected paid model is `opencode/deepseek-v4.1-flash`; the user approved a
$5 total provider budget for this smoke. The common broker records terminal
usage, estimates cost at published rates and blocks after pending/unknown usage.
This gate does not establish actual billing or a provider-side dollar cap.
No full-matrix spend is authorized. Configuration/source edits require a new
freeze; completed scope evidence cannot be silently overwritten or redispatched.

The Aboiteau arm extends the actual Conversation and uses its normal message,
stream, checkpoint and cleanup paths with a frozen fixture overlay. Provider
credentials stay in the Worker; the native runtime sees only an expiring scoped
placeholder. The baseline uses OpenCodeHarness/Workerd with equivalent Linux
access. Tools, system prompts and runtime differences remain disclosed product
configuration differences; the matched stratum is unrated.

Agent snapshots are stopped and copied as plain bounded files to a separate
credential-free, network-disabled grading VM. Its public tests and private oracle
are external to each agent checkout. This protects the controller host; it is
not an adversarial anti-cheating guarantee for code sharing the grading VM.
Each receipt retains task errors and independent runtime-stop confirmation.

## Full-matrix prerequisites

Before any native or paid run, record approved staging names/account, exact image
and source pins, common provider/model endpoint and request settings, numeric
spend/time bounds, grant scope/expiry, model-free native qualification, fault
controls and verified resource cleanup. Start with a four-attempt smoke before
the full matrix. The manifest retains unresolved native/fault qualification and refuses to
imply full-matrix execution readiness. The smoke authorization is separate from
the full matrix.

Cloudflare's inspected credential-injection patterns should be reused; this
baseline creates only a scoped staging broker when explicitly authorized; it
does not change the production dispatcher. Exo,
Pi/Think and E2B/Daytona remain architectural/substrate references unless another
specific decision needs their runtime measurement.

## Qualified smoke and active credentials

The [v11 four-cell smoke](../../docs/evidence/r0-23-smoke-2026-11-15.md) passed
both arms on L1/Q1. The selected account was already signed in through device
OAuth. `operator-credential.ts` uses targeted `opencode auth export opencode`
and selects the one active approved workspace connection; legacy `auth.json`
may contain an inactive key and is never a fallback. Config/catalog are verified
without inference before deployment. Only the access token reaches the Worker;
refresh tokens stay local. The inference workspace header comes from Console's
provider configuration. A readiness gate observes secret/config propagation
before scored admissions.

The native build profile allows owned-VM shell work and retains product hard
denials. Baseline shell is broader, so exact permission/tool/prompt equivalence
is still unrated. Unknown permission requests are recorded for review; they are
not auto-approved. Model and grading failures remain in the evidence.

The frozen scope is one-shot and fully removed. A continuation requires a fresh
manifest/scope and explicit reconciliation of all prior usage, within the user
budget. The full 150-attempt matrix has no execution-budget authorization.
