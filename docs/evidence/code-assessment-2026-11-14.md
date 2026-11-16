# Code assessment — 2026-11-14

Evidence for E7–E9 in the [canonical plan](../roadmap.md#42-assessment-findings-and-dispositions).
This receipt records local observations; it does not schedule work or close a gate.

## Scope and provenance

The assessment traced Worker routing, conversation services, container control,
the custom runtime wrapper, settings/onboarding and selected test assertions.
Product docs, README files and ADRs were excluded. A manifest description was
visible but excluded from judgment. Reading the plan to reconcile these findings
occurred after the assessment.

Checks ran against a working tree containing storage-qualification edits. The
original full-tree revision was not captured, so these results are not an
immutable release qualification. At documentation reconciliation HEAD was
`674875f109fa4d524778aeef5768cd040fa0ba1e`; the finding paths still contain the
observed behavior. Their SHA-256 hashes at reconciliation are:

| Source | SHA-256 |
|---|---|
| `src/conversation/turn-execution.ts` | `39468e882ff1a01a3b14d1bc647530f81698c7396edb1922fb8e470ff25d8af3` |
| `src/conversation.ts` | `ebdddff077b321dcd59d89e0245c1dd3a1fd6600784c84af3cc80af848f8b12e` |
| `src/conversation/budget-reservations.ts` | `972f72669f081cc67d28e620e95d345fd217c432e1cffc3ae62b68ff60ef3b7c` |
| `src/settings-do.ts` | `60ace12880828f71a655a5c88d488e83b091f7c5fb384df2834971f357feaa9a` |
| `src/lifecycle.ts` | `c111af8064cbb594ded56ec3a838a072046c6f1f832a6b39f51269e4ff7fcbc5` |

Environment: macOS/Darwin arm64, Bun 1.3.5, Node 24.22.3, Vitest 4.1.12.
No provider, Slack, GitHub or deployed Cloudflare calls were made. Credential
files were not read. Temporary test configuration used `envDir: false`, a copy
of the test Wrangler config outside the credential-file directory, no build hook,
absolute fixture/assets paths and the existing synthetic test bindings.

## Existing checks

| Command | Result | Conditions |
|---|---|---|
| `bun run test` | 412 harness/probe tests + 5 runtime-options tests passed; zero failures | Initial restricted run: 408 pass / 4 socket-listener failures, so runtime tests were not reached. Rerun with loopback access: all 417 passed. Harness suite took 11.48 s; runtime suite 19 ms. |
| `node node_modules/vitest/vitest.mjs run --config .wrangler/evaluate/vitest.config.ts` | 351 tests in 58 files passed; zero failures; 46.75 s | Isolated config described above; local Worker/DO runtime with simulated containers and external APIs. Content-type warnings occurred. |
| `bun run typecheck` | Passed | Existing script's included projects; not a claim that every repository file is typechecked. |
| `bun run check:config` | Passed | Configuration shape agreement, not live binding verification. |
| `bun run build:ui` | Passed | JavaScript/CSS/assets build; no browser interaction or latency measurement. |
| `docker info --format '{{.ServerVersion}} {{.OSType}} {{.Architecture}}'` | Local Docker daemon unavailable | Native container smoke was not run in this assessment. Earlier native CI receipts remain separate evidence. |

There are **768 existing test passes** total. Mocked integrations do not establish
provider availability, task success, latency, billing accuracy or native recovery.
Real coding-task effectiveness remains **unmeasured** by this assessment.

## Diagnostic selection and reproduction

Three authored cases were selected from consequential code paths: persistence
before connector delivery, the overdue dispatched-turn branch, and fixed-hold
budget admission. They are targeted fault/boundary observations, not a random
sample or a product-accuracy estimate. All three assertions confirmed the
observed behavior, including undesirable behavior; they are not three repaired
defects or a green product gate.

The disposable tests ran with:

```sh
node node_modules/vitest/vitest.mjs run --config .wrangler/evaluate/probes.config.ts
```

Result: **3 passed / 0 failed**, one file, 2.09 s. They used local disposable
DO storage and synthetic SDK/connector responses. Temporary repository files
were removed. Local source/config copies remain at
`/tmp/cf-opencode-evaluation-diagnostics/`; original logs are
`/tmp/cf-opencode-eval-{unit,unit-unsandboxed,workers,types,build,probes}.log`.
Those local paths are ephemeral, not durable CI receipts. Recreate the isolated
test configuration before rerunning the copied probes; their relative source
imports assume `.wrangler/evaluate/` inside this repository.

### Approval delivery

**Trigger:** seed a running Slack conversation with an empty pending map.
The SDK returns a nonterminal user context and two pending permissions, `p1`
and `p2`. Make the first permission-event delivery throw a synthetic Slack
failure; later attempts would succeed. Call `pumpOnce`, recreate the
`ConversationTurnExecution` service over the same store, and poll again.

**Expected:** failed/unsent notifications remain eligible for delivery; pending
authorization ownership is retained independently.

**Observed:** first poll rejected; after the second poll there was **one delivery
attempt, zero successful deliveries, pending IDs `[p1, p2]`**. Both IDs were
remembered before the first send; the next poll filtered them out. The diagnostic
injected failure at the delivery port; the real `Conversation.deliver` persists
and publishes the event before awaiting Slack. Thus HTTP replay may retain the
first event while Slack misses it; later requests in the batch can be suppressed
before any event is emitted. This does not establish that every transport loses
all evidence.

Source: `src/conversation/turn-execution.ts:387-400`;
`src/conversation.ts:976-980`. Disposition: **E7 / R0-21**.

### Timeout behavior

**Trigger:** seed a running session with a dispatched reservation and
`runStartedAt = now - TURN_TIMEOUT_MS - 1000`. Invoke `processTurnObservation`
with its current-job guard satisfied. Supply nonterminal context and no pending
permissions through a synthetic client; count context reads and interrupts.

**Observed:** **zero interrupts, one context read, phase `running`, dispatched
hold retained, timeout reported, another observation scheduled**. The diagnostic
satisfied the scheduler guard directly to isolate this branch; it did not verify
real alarm timing, provider execution, child processes or physical cancellation.

This confirms an observation threshold, not enforcement of an execution deadline.
Keep that distinction explicit until the desired policy is locked. Manual
`!stop` has a separate `session.interrupt({resume:false})` path.

Source: `src/lifecycle.ts:9`; `src/conversation.ts:1041-1065`;
`src/conversation/slack-adapter.ts:405-425`. Disposition: **E8 / R0-22**;
R0-18's completed observability repair is not reopened.

### Budget exposure

**Trigger:** in disposable Settings storage set `dailyBudgetUSD` to `0.1`.
Reserve `0.1` for one conversation, report synthetic sourced usage of `5` USD,
read today's usage, then request a second `0.1` reservation for another
conversation. No provider request occurs.

**Observed:** first reservation **200**; usage report **200**; actual reported
usage **$5**; second reservation **429**. The application always requests a
fixed $0.10 hold. Accurate receipt of higher usage is necessary accounting; it
does not enforce a ceiling on a turn already admitted.

This is the existing I4 admission-versus-billing distinction, now concretely
probed. It is not evidence of actual provider spend or an authorized requirement
to build a hard-cap mechanism.

Source: `src/conversation/budget-reservations.ts:74-81`;
`src/settings-do.ts:431-446`. Disposition: **E9 / R0-3 acceptance**.

## Remaining verification

The canonical plan retains representative real tasks, current-artifact native
runtime/recovery checks, bounded deployed connector verification, explicit
timeout policy and measured provider-cost exposure. Existing security findings
and product gates remain open. This documentation update changes no product
code, credentials, live state or deployment.
