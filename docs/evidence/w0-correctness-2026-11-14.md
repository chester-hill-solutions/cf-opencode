# W0 correctness receipt — 2026-11-14

Status and sequencing remain in [the roadmap](../roadmap.md). This receipt records
local R0-17/R0-18 checks and R0-19's known-open G1 finding. No deployment, paid
provider call, production mutation, or product-gate closure occurred.

## Revision and verification

Base revision: `39a42d59683c806b1b15c3ff000c948b94b314ee`; the originally tested
working-tree changes were committed and published as
`7626726994cd9f3b8f74603d179a82d586b48449`. The earlier `3d71de1` local receipt
remains historical. Existing documentation edits were preserved.

| Command | Result |
|---|---|
| `bun run typecheck` | Pass: all five projects, including runtime |
| `bun run check:config` | Pass |
| `bun run test` | 401 Bun tests + 5 runtime tests pass |
| `bun run test:workers` | 351 tests / 58 files pass |
| `bun run build:ui` | Pass |
| `git diff --check` | Pass |
| `bunx vitest run test/turn-question-delivery.test.ts test/conversation-jobs.test.ts test/turn-settlement.test.ts` | 22 tests pass; rerun after final source adjustment |

The sandbox initially prevented local servers: Vitest could not bind loopback,
and two Bun readiness tests failed for the same reason. Both suites passed when
rerun with local networking permitted. No product failure was inferred from those
sandbox errors. The subsequent native qualification is recorded below.

A final full-suite repeat produced 350 pass / 1 fail in the unchanged
`test/lifecycle-recovery-faults.test.ts:205`: the sealed recovery rearm test saw
two scheduled jobs where it expected one. Its isolated repeat passed all 4 tests.
The first full run passed all 351 tests. No recovery implementation or assertion
was changed to suppress this intermittent result; native CI must also check it.
The subsequent full-suite repeat passed all 351 tests / 58 files.

## Native CI — 2026-11-14

After explicit approval to upload commit `7626726`, it was pushed to the existing
`codex/conversation-lifecycle` branch. [Run `43633250236`](https://github.com/chester-hill-solutions/cf-opencode/actions/runs/43633250236)
completed successfully: `check` and native amd64 `container-smoke` both passed.
[Structured receipt](w0-native-ci-2026-11-14.json) binds the run, head SHA and jobs.
The run's Worker suite passed 351 tests / 58 files, including the recovery test
that intermittently failed locally. That pass does not prove the flake is fixed.

The container smoke reported a 156 MB image on the native runner and passed
health/auth, startup, Stow binary verification, S3/file parity, workspace/state
checkpoint and restore, registry refusal, account-seed isolation, lifecycle
serialization, and fresh-container recovery from both archives. This is a local
container test on native Linux, not a deployed Cloudflare/R2 qualification.

The push automatically started the PR workflow; the explicit dispatch created a
duplicate run `43633264827`, which was canceled. No CI rerun was needed to obtain
the passing result. Automatic approval review refused including the later
documentation-only commit in the upload because the approval named only
`7626726`; that evidence follow-up and this receipt remain local.

No production resource was changed; no product gate closed. R0-15 current-shape
Cloudflare/R2 qualification and deployment remain open.

## Tested source hashes

Source SHA256 values identify the tested working tree:

| File | SHA256 |
|---|---|
| `src/alerts.ts` | `ac1d46a122a80874096c1c0537681d2133f342cca701d0e02abd5dd82d89200e` |
| `src/conversation.ts` | `ebdddff077b321dcd59d89e0245c1dd3a1fd6600784c84af3cc80af848f8b12e` |
| `src/conversation/turn-execution.ts` | `39468e882ff1a01a3b14d1bc647530f81698c7396edb1922fb8e470ff25d8af3` |
| `test/turn-question-delivery.test.ts` | `e2149f7f7ea1664992a22d9d9421d62ab2a0850f52dcbf2efced325986e73c1c` |
| `test/conversation-jobs.test.ts` | `bc701b970c447e9dad3a5bd0a4267dfac2ac5ba0f55daeee4257f22aa7c308e0` |
| `tests/alerts.test.ts` | `a53b07547fab700cf2943557cb51a546f2b28017b03be1912d7051ca9ccc918d` |

## R0-17 — question delivery

The new tests first reproduced both `internal_error` and `missing_scope` escaping
`pumpOnce` before settlement. Question-post failures now persist a per-session,
per-pending-form retry with exponential delays of 5 seconds up to 5 minutes.
Service recreation preserves backoff; resolved forms and previous sessions are
pruned on the next question poll. Announcement state changes only after Slack
acknowledges the post.

Every failed attempt increments `slack.form.failed`, writes a structured log, and
emits a public error event with Slack delivery disabled for that event. The
scheduled alert evaluator reports new failure counts. Retry bookkeeping failures
also cannot abort settlement. Retries occur while the turn is being observed;
there is no background replay of obsolete questions after settlement.

Tests cover transient failure → restart/backoff → one successful card, permanent
failure with terminal usage acknowledgement and reservation release, no repeat
card after acknowledgement, and the five-minute cap. This is local fault
injection, not a live Slack receipt or an exactly-once guarantee for an ambiguous
external post acknowledgement. Terminal reply and permission delivery policies
are outside this slice.

## R0-18 — timeout and settlement signals

Both dispatched and reservation-less timeouts count and log `turn.timedout`.
A durable session/start-time marker suppresses repeat counts across observation
polls. Dispatched reservations remain held until ordinary usage settlement.

Entering a paused settlement immediately increments `settlement.paused` and logs
the conversation/session and reason. The alert threshold is the first new paused
episode; the scheduled 15-minute check (or manual alert check) reports it. Repeated
polls and reason changes do not increment again until a successful settlement
clears `settlementError`. The clear now includes reservation-less turns.

Tests exercise both timeout paths through real Lifecycle wake jobs, assert one
counter and log across repeated observations, retain dispatched holds, check
pause deduplication and success-path clearing, and verify alert high-water marks.
The existing reserved release-retry regression also passes.

## R0-19 — KNOWN_OPEN_G1

Run separately from the normal test gate:

```sh
IMAGE=cf-opencode-shape-ab:stow040-3d71de1 bun scripts/probe-credential-boundary.ts
```

**Result: exit 2, `KNOWN_OPEN_G1`.** [Raw receipt](r0-19-2026-11-14.json) includes
the probe hash, base revision, image ID, platform, command policies, and artifact
hashes. Image `sha256:dc0856170d9a60aa1f9c9766435031ddfdf9e2688f5c9b8b0cec2d08153ad630`
ran as linux/amd64 under Docker on an arm64 host. The container used its normal
entrypoint, disabled networking, mounted no volumes, and contained only synthetic
credential/control markers. Probe children ran as UID/GID 1001 with `CONTROL_TOKEN`
removed. The normal OpenCode session/server was not started; this proves the OS
read path, not an end-to-end model/tool execution.

The pinned OpenCode matcher evaluated default shell rules on the host. Before
accepting the combined result, the harness verified image/source SHA256 equality
for `permissions.ts`, `entrypoint.sh`, and the OpenCode runtime lockfile.

| Probe | Policy | Observation |
|---|---|---|
| Literal `cat` of the state credential | deny | Not executed |
| `find /var/lib/aboiteau -name opencode.json -exec cat {} \;` | allow | Synthetic credential recovered; exit 1 because the root-only sibling run directory is inaccessible |
| Repository-controlled `bun test credential-probe.test.ts` | allow | Synthetic credential recovered; exit 0 |

Three preliminary harness attempts exited 137 because the new container lacked
the control token required to keep its control server alive. Increasing the bound
and moving matcher evaluation to the host did not solve that setup error. Adding
a disposable synthetic control token did; the final receipt repeats the probe
after removing that token from the agent environment and aligning the command
working directory. All disposable containers were removed.

This records the existing credential exposure; it does not fix it. R1-7a must
prove external credential injection and egress behavior, and R1-7 owns enforcement.
G1 remains open. No deny patterns were added.
