# R0 budget simplification research

> Historical scope decision for the first repair pass. The separately authorized
> F1 implementation follows the source correction below; the narrower first-pass
> completion claims remain historical evidence.

Initial research pass, before implementation: local source/test inspection,
2026-11-11. That pass ran no tests and changed no product files. Later sections
record the subsequent source correction and configuration-only runtime check.

## Recommendation

Use one conservative hold per active conversation, owned by a persisted generation ID. Waiting queued messages hold nothing. Reuse the existing serialized Settings request handler and existing absolute usage ledger. Remove the proposed central arm stage, five-minute expiry, terminal receipt collection, report revision system, reset baselines and dedicated migration-rehearsal workstream from this iteration. Keep R0-11 **partial**, and G0 open. One implementation owner can batch Settings/state/caller changes; review the resulting invariants once.

This closes the **original reproductions** of audits 30–31 if the tests below pass. It does not satisfy their broader ownership/recovery acceptance matrix in `docs/testing.md:93` or all roadmap R0-11 criteria (`docs/roadmap.md:84`). Do not describe it as complete accounting or automatic reservation recovery.

## Primary-source findings

- **Original audit 30:** HTTP reserves before claiming admission or starting readiness (`src/conversation.ts:206–249`); Slack does likewise (`:608–654`). Queue drain reads the combined total before retrying (`:1602–1619`). A $0.10 hold therefore blocks its own $0.10 retry. The queue has no reservation identity today (`src/state.ts:33–42`). Acquiring only for ready-to-dispatch work removes this self-block rather than teaching a queued item to subtract its own hold.
- **Original audit 31:** `/usage/reserve` writes an arbitrary hold without reading budget or totals (`src/settings-do.ts:90–101`). Crucially, Settings already serializes its entire handler across awaits (`:25–43`). Put budget read, headroom comparison and hold write in that existing authority. No distributed transaction framework is needed for this check-and-reserve operation.
- `/usage/today` mixes actual entries and holds into `costUSD` (`src/settings-do.ts:114–129`); distinguish measured `costUSD` and estimated `reservedUSD` and use their sum internally for admission. A fixed $0.10 hold cannot cap actual turn cost. The existing ceiling comments are already stale (`src/budget.ts:1–8`; `src/conversation.ts:1228–1244`).
- Settlement currently swallows context-report errors, creates another hold, then releases it regardless (`src/conversation.ts:1111–1120`, `:1140–1148`). `reportUsage` never checks HTTP success (`:1221–1225`). Remove the extra reservation; do not retire the hold when actual usage is unavailable or unacknowledged.

## Minimum contract and safety boundary

1. Persist an active generation before acquiring. Settings keeps at most one hold per conversation, compares actual plus outstanding holds plus $0.10 against its current enabled budget, validates finite nonnegative inputs, makes same-generation retries idempotent, and rejects conflicting generations. Budget authority errors stop dispatch. Queued/full-queue/readiness failures occur before acquisition.
2. Persist the point beyond which prompt dispatch **may** occur before calling the provider. This is local dispatch evidence, not another Settings arm request. A thrown prompt request is not proof of rejection: keep the generation/hold, prevent re-prompt and queue promotion, and expose unresolved work for manual reconciliation. The current broad catches requeue such errors (`src/conversation.ts:239–249`, `:651–664`, `:1624–1672`); these need narrow separation from readiness failures.
3. Write actual usage through the existing path, require acknowledgment, then release **only the matching generation**. Do not promote another turn until that outcome is acknowledged. Retried release cannot retire a newer generation. A separate receipt history is unnecessary for this bounded sequential lifecycle; do not promise exactly-once settlement across arbitrary delayed requests.
4. No automatic expiry. Stale admission/settlement cleanup currently advances idle (`src/conversation.ts:1251–1261`); it must not erase unresolved dispatch evidence. Harness timeout (`:1262–1269`) is not provider cancellation. Confirmed stop does not prove zero prior spend. Reset/delete currently erase local state (`:330–344`, `:388–399`): retain unresolved evidence/hold or reject destructive clearing until reconciled. Carry unresolved holds into admission across midnight; time alone is not reconciliation.
5. Preserve actual usage entries and auxiliary deduplication, never clear them to recover headroom, and do not release unknown incurred usage. Avoid destructive cleanup of legacy holds; deployment/cutover remains separately gated pending evidence of existing live work. No local migration rehearsal is needed to claim this planning slice.

## Explicit deferrals and alternatives

**Newly inferred risks, not original reproductions:** stale stream/context reports overwrite newer totals (`src/conversation.ts:1174–1185`, `:1213–1217`; `src/settings-do.ts:81–86`); reset/session replacement loses cumulative baselines (`src/conversation.ts:854–856`, `:343`); original-day allocation is imperfect (`:1199–1210`). Existing rows being retained does not guarantee complete or monotonic accounting after these events. Defer ordered reports, per-session/day baselines, historical receipts, automatic crash reconciliation and comprehensive cutover fixtures explicitly; R0-11 remains partial for these reasons.

Removing reservations entirely is smaller but leaves original audit 31 open. Keeping queue holds requires extra ownership/reuse paths without improving the observed failure. Full arm/TTL/receipt/revision machinery broadens availability and ledger guarantees; choose it only as a separate iteration with those guarantees requested.

## Minimal consequential tests

- Direct Settings: two synchronized $0.10 acquisitions with $0.10 headroom grant one; same-generation retry creates one hold; stale release cannot remove a newer hold; invalid/nonfinite amount is rejected.
- Caller integration: startup failure queues with zero measured spend/hold; recovery prompts once at $0.10. HTTP and Slack denial/authority failure prompt zero times; queue-full does not alter active ownership.
- Failure boundary: prompt accepted then response lost, restart and timeout retain evidence and never re-prompt. Failed/non-OK actual report retains hold and blocks promotion; acknowledged settlement releases matching ownership.
- One reset/delete and one midnight regression retain unresolved evidence. Preserve existing admission/idempotency tests (`test/admission.test.ts:77–96`; `test/idempotency.test.ts:75–139`) and actual-plus-auxiliary ledger assertions (`test/usage-ledger.test.ts:49–79`). Existing budget tests cover already-spent denial only (`test/budget-gate.test.ts:64–110`), not either original reproduction.

## F1 source correction — 2026-11-11

The Dockerfile pins OpenCode 2.2.5; the installed `@opencode/client` is also 2.2.5.
Inspection of that exact upstream tag disproves this repository's assumption that
`session.usage.updated` contains only step totals:

- [Projector](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/projector.ts):
  `applyUsage` adds step and auxiliary usage to the session row;
  `publishSessionUsage` emits that lifetime total after both kinds of event.
- [Step runner](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/runner/step.ts)
  and [message updater](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/message-updater.ts):
  assistant message cost comes from one provider step, rather than the session total.
- [Event schema](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/session-event.ts):
  individual step/auxiliary events have durable identities; the cumulative update
  is ephemeral. The installed client exposes `experimental.session.log` with
  `after` and `follow` arguments, and a `log.synced` boundary.
- [Log tests](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/test/session-log.test.ts)
  and [server handler](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/server/src/handlers/session.ts):
  `follow:false` replays public durable events and finishes with `log.synced` at
  the aggregate watermark. Sequence gaps are valid because some events are private;
  the watermark can exceed the final delivered public event's sequence.

Consequently, adding auxiliary spend to `usage.updated` can double count it, and
assigning the lifetime snapshot to its receipt day misattributes prior days.
The chosen F1 repair records durable usage events individually and acknowledges
them through Settings before advancing the replay cursor. This also avoids a
global revision protocol, local reset baselines and guesswork about cumulative
totals across midnight. Source and aggregate writes must be atomic, with source
identity independent of its immutable day. Nonzero legacy rows cannot be exactly
reconstructed from aggregate totals, so preserve them and stop ambiguous writes
until a separately verified cutover. The implementation and tests, rather than
this research note, determine completion status.

## F1 auxiliary lifecycle research — 2026-11-11

OpenCode v2.2.5 does not provide a general “all usage is finished” fence at
`Execution.Succeeded` or `Session.wait`:

- Automatic title generation is started from the runner in a separate
  `FiberMap` and explicitly must not delay model execution
  ([runner](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/runner/llm.ts#L53-L55),
  [launch](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/runner/llm.ts#L189-L194)).
  Its `UsageRecorded` is published after its stream finishes
  ([title](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/title.ts#L53-L90)).
  Explicit create titles are passed through by the server; auto-title only
  runs when `SessionTitle.isUntitled` accepts the root fallback, so ordinary
  custom titles suppress this particular auxiliary path
  ([create](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/server/src/handlers/session.ts#L97-L115),
  [predicate](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/title.ts#L34-L38)).
- Compaction precompute is background work: its interface says it never waits,
  the runner starts it as execution is about to go idle, and it forks the
  summary in a separate scope. Summary usage is published as each model call
  finishes ([interface](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/compaction.ts#L65-L74),
  [runner](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/runner/llm.ts#L303-L310),
  [fork](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/compaction.ts#L343-L360),
  [usage event](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/compaction.ts#L809-L828)).
- `Execution.interrupt` acknowledges acceptance before asynchronous cleanup;
  `awaitIdle` waits only until this process owns no active execution. The
  coordinator emits terminal execution events after the runner settles, but
  no source evidence ties those events to the independent compaction fiber
  ([execution API](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/execution.ts#L14-L36),
  [terminal publication](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/execution.ts#L103-L138)).

Therefore, even with a custom session title, a finite durable-log replay ending
at `log.synced` or an execution terminal cannot prove no later auxiliary usage
will append. Safe settlement needs an explicit accounting cutoff/drain policy;
do not treat success, wait, or interruption as a global auxiliary-usage fence.

### Configuration control check — 2026-11-11

There is a supported narrow switch for the detached compaction path:
`experimental.background_compaction: false` maps directly to
`SessionCompaction.precompute: false`; `precompute` returns before starting a
fiber unless both `precompute` and `auto` are true
([config plugin](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/config/plugin/compaction.ts#L7-L21),
[precompute guard](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/compaction.ts#L313-L320)).
The schema documents the experimental flag's false default
([schema](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/config/experimental.ts#L13-L16)).
This leaves `compaction.auto` enabled, preserving foreground automatic
compaction; setting `auto: false` also skips automatic/overflow compaction,
while manual compaction remains allowed (`compaction.ts` L269-L278).

Title generation can be disabled with `agents.title.disabled: true`: the
config schema accepts `disabled`, its plugin removes that agent, and title
selection returns before a request when the `title` agent is absent
([schema](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/config/agent.ts#L9-L23),
[agent config](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/config/plugin/agent.ts#L88-L94),
[title selection](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/context.ts#L85-L88)).
For a harness overriding repository config, OpenCode v2.2.5 loads
`OPENCODE_CONFIG_CONTENT` after project config and before managed settings,
making it the supported runtime override unless administrator-managed settings
override it ([config loading order](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/config.ts#L270-L285),
[entry order](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/config.ts#L345-L355)).

Execution terminals must follow the final step, not merely a `finish: "length"`
step: the runner can continue after output-limit responses, and only emits
`Execution.Succeeded` after the drain completes
([runner continuation](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/runner/llm.ts#L327-L367)).
Foreground compaction is attempted at the start of each step, before provider
request preparation ([step path](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/runner/llm.ts#L229-L240)).

### Pinned-binary configuration check

The locally installed CLI was 2.2.7, so it was not used as evidence for the pinned
2.2.5 contract. Downloaded the official 2.2.5 Darwin arm64 release into `/tmp` and
verified SHA-256
`25ba9908979fa7d764792c82589b4b5768ab1511154e0317d98aa77d216ce767`
against its recorded release metadata. Started it with an empty inherited environment,
isolated temporary XDG data/config/cache and a temporary project config enabling
both auxiliary paths; the fixed runtime content disabled them.

`/api/info` reported 2.2.5. `/api/config` returned the project document followed by
the runtime override; `assertAccountingPolicy` accepted the actual response.
`/api/agent` omitted the disabled title agent. The temporary process was stopped.
No model, Slack or OAuth call, real credentials, container or deployment was used.
This checks the real provider's config/API contract; it does not replace a Linux
container or model-task check. Docker's daemon was unavailable.

### Legacy cutover decision

Legacy daily rows have no source identities, and their old step/auxiliary arithmetic
can overlap. Local snapshots and bounded event-id lists cannot reconstruct exact
historical bills or all reset/deleted sessions. Avoid inventing that provenance:
carry recorded totals unchanged as explicitly unreconciled opening balances.
An applicable preview requires idle local/provider work, no holds, the new process
policy proof and a complete durable-log watermark. Apply rechecks the preview and
atomically saves balances plus an ordering receipt. Pre-boundary events are covered;
post-boundary events add through source deduplication. Reports without the receipt's
ordering ID cannot cross the cutover after delay/restart. This replaces global
history reconstruction with one explicit boundary while keeping the historical
billing limitation visible. Implementation tests and independent review determine
whether the contract is met; no production conversion has been performed.
