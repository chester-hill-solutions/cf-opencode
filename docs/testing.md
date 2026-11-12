# Testing

The layers below verify different boundaries. Simulated container/model tests do
not establish live provider accuracy, availability, latency, cost or task success.

## Verified snapshot — 2026-11-11

Assessed the current working tree, including existing local edits, on macOS arm64
with Bun 1.3.5 and Node 25.9.0. No product fixes were made during the assessment.

| Check | Result | Scope |
|---|---|---|
| `bun run test` | 210 passed, 0 failed; 33 files | Unit/helper tests, including disposable filesystem fixtures |
| `bun run test:workers` | 59 passed, 0 failed; 23 files | Worker/DO runtime; container and model behavior largely simulated |
| `bun run typecheck` | Passed | Worker, unit tests, Worker tests and UI |
| `bun run check:config` | Passed | Existing production/test config comparisons |
| `bun run build:ui` | Passed | Bundles and static assets generated locally |
| `bun test --coverage tests` | 95.44% lines reported | Imported files only; main Worker, Conversation and Settings orchestration absent |
| Disposable workerd diagnostic probes | 4/4 reproduced investigated defects | Retention, self-blocking reservation, unchecked concurrent reservations, malformed JSON |
| Disposable repository-code probe | Synthetic sibling-state marker readable | Local shared-identity execution path; not production credential extraction |
| Disposable Chrome settings checks | 5/5 passed; no page errors | Save, failed-save draft retention, reload, no horizontal overflow at 1280/390 px; synthetic API |

At this initial snapshot, the first Worker test attempt could not open local listeners;
rerunning with local network access passed. All temporary diagnostic/browser fixtures
were removed. Diagnostic assertions confirmed defective behavior; desired-behavior
regressions were still open at that point. This snapshot does not claim that probes ran
in CI or that repairs had been made.

## Local repair verification — 2026-11-11

The later repair gate passed: `bun run test` (212 passed, 34 files),
`bun run test:workers` (100 passed, 26 files), `check:config`, `typecheck`, `build:ui`
and `git diff --check`. The gate used injected Worker/container fixtures; it did not
deploy or exercise a real container, provider, Slack app or live coding task.

Meaningful regressions now include:

- [Checkpoint retention, pagination, active old references, both unchanged-part directions,
  preflight and legacy restore](../test/checkpoint-split.test.ts) and
  [checkpoint integrity](../test/checkpoint-integrity.test.ts).
- [Queued admission and concurrent requests](../test/budget-gate.test.ts),
  [HTTP admission and dispatch](../test/budget-http-admission.test.ts),
  [owned reservations and legacy compatibility](../test/budget-reservations.test.ts),
  [queue/dispatch/alarm races](../test/concurrency.test.ts),
  [settlement cost acknowledgement and recovery](../test/turn-settlement.test.ts), and
  [reset/delete guards](../test/reset.test.ts).
- [Malformed public JSON and mutation boundaries](../tests/http-json.test.ts) and
  [Worker route behavior](../test/worker.test.ts).

The table below retains broader G0 acceptance criteria. The later F1 verification
below supersedes the first repair's accounting deferral. Actual live conversion,
deployed policy verification, unsupported manual reconciliation cases, credential isolation
(audit 32/R1-7), deployed validation and G0/G1 remain open. The $0.10 estimate is not
a provider spend cap.

### F1 accounting verification — 2026-11-11

The latest integrated gate passed **213 unit tests / 34 files** and **114 Worker
tests / 27 files**, plus `check:config`, all four typecheck configurations,
`build:ui` and `git diff --check`. Local logs are `/tmp/cf-opencode-accounting-*.log`.
These counts supersede the earlier 312-test repair gate, which remains historical.

- [Source ledger](../test/usage-sources.test.ts): reordered/duplicate reports,
  concurrent sources, separate sessions, immutable source dates, invalid input,
  atomic overflow rejection, monotonic legacy reports and conversion conflicts.
- [Durable replay](../test/usage-ledger.test.ts): step plus auxiliary charges counted
  once, acknowledged cursor and terminal evidence, failed reports/incomplete logs,
  late auxiliary replay, expired history, midnight allocation, actual reset followed
  by a new session, and cleanup serialized against a queued background refresh.
- [Reservation helper](../test/budget-reservation-helper.test.ts): definitive legacy
  migration denial leaves no new local or central hold. Existing ownership conflicts
  retain their conservative recovery behavior.
- [Usage validation](../tests/usage.test.ts): explicit zero, invalid sources and
  cumulative snapshots excluded from additive accounting. Existing provider mocks
  now serve finite, cursor-aware logs through [one fixture helper](../test/helpers/usage-log.ts).

Matching upstream 2.2.5 source established that cumulative `usage.updated` already
includes auxiliary calls. The former arithmetic test asserted an incorrect contract;
the new tests use individual durable events instead. See the
[source research](plans/r0-simplification-research.md#f1-source-correction--2026-11-11).
Focused independent review accepted the implemented accounting and cleanup invariants.
No live provider, container, Slack or deployment check ran. Finite replay does not
prove detached auxiliary work cannot publish charges later; legacy conversion and
that quiescence guarantee remain release gates, alongside F2 and G0/G1.

### F1 policy and cutover verification — 2026-11-11

The latest integrated gate passed **217 unit tests / 35 files** and **134 Worker
tests / 29 files** (351 total), plus configuration, all four TypeScript configs,
UI build and diff checks. Logs are `/tmp/cf-opencode-cutover-*.log`. This supersedes
the earlier 327-test gate above. An initial parallel run hit the checkpoint pagination
fixture's five-second timeout; running Workers alone passed all 134 tests without
changing its assertions or timeout. Test fixture type errors were corrected before
the final all-config typecheck passed.

- [Effective policy validation](../tests/accounting-policy.test.ts) and
  [child environment](../tests/control-env.test.ts): project settings cannot override
  the fixed runtime policy; later unsafe managed settings are rejected.
- [Settings cutover](../test/usage-cutover.test.ts): dry run writes nothing; apply
  preserves opening balances/metadata and budget headroom; holds, malformed rows
  and stale snapshots block; retries are idempotent; old/stale writers cannot cross
  the ordering boundary; receipts survive daily pruning.
- [Caller cutover](../test/accounting-cutover.test.ts): actual DO/Settings interaction
  with injected provider responses, changed plans, execution-fence validation,
  rollback detection, receipt recovery across reset/replacement, public JSON
  validation, safe settings-change handling and crash-interrupted reconstruction.
- [Turn settlement](../test/turn-settlement.test.ts): an output-limit step retains
  its hold through compaction and continuation; all usage is acknowledged before
  the later execution-terminal event permits release. [Replay tests](../test/usage-ledger.test.ts)
  also cover execution fences and cleanup refusal while execution remains active.

Separately, the official SHA-256-verified OpenCode **2.2.5 Darwin arm64** binary ran
with isolated temporary data and no credentials. Its real config endpoint showed
the runtime override after a conflicting project document; its agent endpoint
omitted the disabled title agent. The process was stopped. See
[probe and source evidence](plans/r0-simplification-research.md#pinned-binary-configuration-check).
This was a configuration-only provider API check, with **no model calls**. It does
not prove Linux privilege behavior, container restore, paid-task effectiveness,
Slack/OAuth integration or live deployment compatibility. Docker's daemon was
unavailable. No production cutover or deployment ran.

Independent review accepted the scoped runtime, ordering, conservation and recovery
invariants. F1 tooling is locally verified. Opening balances retain
`historicalUsageUnreconciled: true`; old bills cannot be reconstructed from aggregate
rows. Actual quiesced-data cutover, deployed-container checks, F2 reconciliation,
credential isolation and G0/G1 remain open.

### F2 held-turn recovery verification — 2026-11-11

The latest integrated gate passed **222 unit tests / 36 files** and **149 Worker
tests / 31 files** (371 total), plus `check:config`, all four typecheck configurations,
`build:ui` and `git diff --check`. Logs: `/tmp/cf-opencode-recovery-*.log`. This
supersedes the earlier 351-test gate. Workers ran separately from heavy builds;
all checks passed without weakening assertions or test timeouts.

- [Reservation retirement](../test/reservation-retirement.test.ts): both acquire/cancel
  orders, late acquisition after a normal release, owner/date conflicts, malformed
  and legacy holds, stale cancellation snapshots, absent holds, immutable receipts,
  and retention across daily pruning with actual spend unchanged.
- [Recovery classification](../tests/recovery.test.ts): strict never-dispatched
  proof, queued/live/unfinished cancellation blockers, dispatched retry with a queued
  follow-up, ownership/date/retirement contradictions and snapshot binding.
- [Recovery API](../test/recovery.test.ts): passive/authenticated inspection, invalid
  controls rejected before effects, matching/absent cancellation, lost acknowledgement
  and newer-generation protection, alarm-only retry, real DO/Settings settlement
  with injected terminal provider evidence, and rejection of a later old-ID acquire.
  A barrier case makes normal release win before cancellation; recovery accepts the
  original valid retirement decision and preserves spend.
- Existing [reservation tests](../test/budget-reservations.test.ts) retain the original
  first receipt on repeated release. Existing F1 accounting, execution completion,
  reset, checkpoint and cutover regressions also pass in the full gate.

Independent Terra review accepted the scoped ordering, ownership, passive inspection
and recovery invariants; a focused recheck accepted the acknowledgement-race fix.
Luna owned implementation and check execution. No provider startup/model call,
Slack/OAuth action, container test, production recovery or deployment was performed
by this pass. No new effectiveness or coverage percentage was measured.

Unknown legacy/orphan/mismatched holds remain blocked. This verifies the scoped
recoverable F2 cases, not every historical hold or a billing-evidence import flow.
Actual cutover/recovery in staging, deployed-container/model checks, audit 32 and
G0/G1 remain open.

## 1. Unit — `bun run test`

Exercises pure rules and local helpers: signatures, tenancy keys, permission-rule
construction, state transitions, message selection, SSE parsing/formatting,
encryption, archive validation, retries, budgets, leases and settings state.
Some tests use disposable Git repositories and filesystem fixtures. UI kit tests
check registry/export/theme contracts rather than rendered interaction.

High unit coverage does not verify the principal orchestrators or prove that
OpenCode enforces policy against arbitrary code inside an allowed command.

## 2. Worker integration — `bun run test:workers`

`@cloudflare/vitest-plugin` runs the Worker and Durable Objects in workerd via
Miniflare. Existing tests include authentication, input/key checks, Slack routing
and approvals, admission/deduplication, queueing, settlement, usage accounting,
settings atomicity, session recovery, encryption and checkpoint integrity/restore.
Read test assertions to distinguish actual DO/R2 behavior from injected container
responses. These tests do not start the real container or call a model provider.

## 3. Container smoke — `bun run smoke:container`

The `container-smoke` CI job already builds an image and invokes
`scripts/smoke-container.sh` after the standard check job. It verifies the control
token, configuration, local S3, OpenCode proxy, checkpoint/restore round trips,
unchanged-workspace deduplication and refusal of an escaping workspace symlink.
It does not call a model provider.

The Nov 7 container results in `docs/design/r1-agent-boundary.md` are historical
evidence. The Nov 11 assessment could not rerun this layer because the Docker
daemon was unavailable. The existence of the CI job is not evidence of its latest
run status; that status was not checked.

## 4. Live end-to-end — deployed Worker + provider + Slack

Unverified in the Nov 11 assessment. After R0-10/R0-11/R0-13 are fixed, use
disposable conversations/repositories and explicit authorization for live provider
or Slack activity. Record observable outcomes for:

- HTTP message → assistant events → settled → requested files/checks succeed.
- Permission request → authorized approve/reject → correct continuation/block.
- Checkpoint → stop/restart → restore → both workspace changes and session state survive.
- SSE reconnect after disconnect/DO eviction, including replay gaps.
- Slack mention → reply in the correct thread; no duplicate task execution on retry.
- A small declared set of coding tasks, selected to cover file edits, test execution,
  failed-task reporting and recovery. Report successes/total and the selection limits;
  do not generalize a small diagnostic set into overall model accuracy.

Record model/provider/version, runtime/image, cold/warm conditions, sample size,
commands, latency and provider-reported cost. A reply containing “ok” is only a
connectivity check. Coding effectiveness remains **unmeasured** until task outcomes
are checked.

## Required regressions before G0

These are broader acceptance criteria for G0; the repair-specific regressions listed
above cover only the locally implemented scope. Keep fixtures disposable and use
synthetic credential markers.

The [simplified next iteration](plans/r0-reliability-iteration.md) first targets the
original failures with an owned active hold and no queue-waiting hold. Automatic
expiry/reconciliation remains deferred. The subsequent F1 follow-up verifies local
source accounting across resets/days. The policy/cutover follow-up implements the
local runtime fence and opening-balance conversion. Scoped F2 now adds guarded
recovery/retirement; actual live cutover, unresolved manual cases and
the broader criteria below remain open. These local passes do not close
G0 or all of R0-11. Reuse the recorded credential diagnostic rather than repeating it unchanged.

| Work | Regression cases | Required assertions |
|---|---|---|
| R0-10 / audit 29 | At least five checkpoints with changing workspace and unchanged state; reverse which part changes; exceed five versions in each part | Every object named by the active manifest exists after each prune; old active parts remain protected beyond the retention count; unreferenced old parts can be removed |
| R0-10 / audit 29 | Remove a required state/workspace object, then cold restore; exercise legacy fallback separately | No silent partial split restore; either use a verified complete recovery point or fail visibly; successful restore preserves both roots |
| R0-11 / audit 30 | $0.10 budget, temporary initial-start failure, queued retry without actual usage | Waiting work holds no reservation; recovery acquires once immediately before dispatch; spent remains zero before model usage; no false “daily budget reached” block |
| R0-11 / audit 31 | Two synchronized $0.10 admissions against $0.10 available budget, through both HTTP and Slack | One reservation succeeds and the other is denied before model work; check-and-reserve is atomic; retries of one admission do not create another reservation |
| R0-11 / audits 30–31 | Queue full, failed admission, retry exhaustion, settlement/retry, reset/delete, expired/crashed reservations and UTC day rollover | Defined reservation ownership/release/expiry is idempotent; no leaked or double-counted reservation; measured spend and reserved amounts remain distinct; reconciliation uses the originating reservation/date |
| R0-13 / audit 33 | Malformed JSON, null, arrays and invalid field types on HTTP JSON routes | Controlled 400 response, no uncaught exception, no admitted work or unintended state mutation |

Reservations limit estimated admitted work, not the eventual cost of a running
model turn. Document the estimate and overshoot behavior; do not claim a hard
provider-spend ceiling without separately verifying runtime enforcement.

## Required credential-boundary checks before G1

R0-12 records the initial trusted-operator/trusted-repository restriction. Audit 32
remains open until R1-7's external credential injection and egress boundary pass
real-container tests:

- Execute repository-controlled tests and a repository-controlled typecheck script
  under the normal default-allowed command paths.
- Attempt to recover synthetic long-lived provider/git markers through filesystem,
  environment and process state; verify they are absent or inaccessible.
- Verify allowed upstream requests work through the credential-injecting proxy and
  direct/unlisted egress fails. Use fixtures; never probe real credential files.
- A direct-path tool denial or a matching permission-rule string is insufficient.
  The local shared-identity diagnostic already demonstrated that code inside an
  allowed program can read state without naming it in the shell command.

## Measurements

- `bench/measure.ts`: deployed Worker/SSE overhead and live turn latency. Its default
  turn calls a provider; inspect configuration and authorization before running it.
- `bench/container.sh`: container cold start, checkpoint size/time and restore time.
- Settings JS measured 581.7 KiB raw / 184.8 KiB gzip; onboarding JS 561.6 / 179.0
  KiB; shared CSS 179.3 / 27.9 KiB in the Nov 11 build. These are local artifact sizes,
  not measured browser transfer sizes or evidence of user-perceived speed.

## CI

`.github/workflows/ci.yml` runs dependency installation, `check:config`, `typecheck`,
`build:ui`, `test` and `test:workers`, followed by the separate container smoke job.
The new failure probes must be retained as regressions before closing their tickets.

## Remaining verification gaps

- No fresh deployed/container/model/Slack/OAuth validation in the Nov 11 assessment.
- Permanent regressions cover the listed local repairs. Rendered settings browser
  scenarios still have only the earlier disposable diagnostic evidence.
- No live-load/cost measurement: the code uses per-conversation containers and global
  leases, not the historical `max_instances: 1` configuration.
- Live SSE reconnect/stream recovery and applying settings across a real container
  restart still need end-to-end checks.
- Unit coverage excludes the main orchestrators; Worker tests with injected
  transports do not verify upstream model or container effectiveness.
