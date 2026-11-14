# R0-21 permission notification recovery — 2026-11-14

Result: **implemented and verified locally; deployed connector check outstanding**.
The working roadmap's new W0 R0-21 item was selected before further storage
rehearsal. Source base: `674875f109fa4d524778aeef5768cd040fa0ba1e`.
Existing assessment/roadmap edits were present before this repair and preserved.

## Reproduction and repair

The new Worker/DO fault suite failed all five cases on the original source.
The first failed permission event rejected the reply pump, even though every
request in the batch had already been remembered as pending. Later polls treated
pending ownership as successful delivery, suppressing failed and unsent requests.

The existing ConversationStore now holds permission notification acknowledgement
and retry timing separately from its request-to-session ownership map. The reply
pump reconciles successful current-session permission snapshots, persists each
attempt's backoff before external delivery, continues through batch failures and
marks delivery only after the combined event/connector call succeeds. Backoff is
5 seconds exponentially capped at 5 minutes; its attempt exponent caps at 32.
Acknowledged requests remain deduplicated while pending, including after service
and store recreation. Resolved/stale requests are pruned; failed list reads do
not masquerade as an empty snapshot. Permission replies clear both records, and
a late notification acknowledgement cannot recreate a resolved authorization.
Session replacement/selection also clears notification state alongside ownership.

Failure emits the fixed `permission.notification.failed` metric/log and a fixed
error event with Slack delivery disabled. Connector error text is never included,
so a credential-bearing failure cannot leak through this new reporting path.
Failure is caught both per request and around notification bookkeeping; terminal
usage acknowledgement, hold release, checkpoint and settlement retain their
existing order and checks. No timeout/cancellation policy or accounting ceiling
was introduced.

Existing ownership records do not prove historical delivery acknowledgement.
When upgraded, a still-pending legacy request with no notification record is
eligible again. It may repeat an already delivered legacy card; suppressing all
such records would preserve the original loss. A lost send or acknowledgement
also remains ambiguous and may repeat the permission SSE event/card. This is
bounded retry bookkeeping, not exactly-once delivery or authorization replay.

## Verification

Tests use disposable SQLite-backed DO storage, synthetic SDK/connector responses,
no real Slack or provider calls, and local workerd listeners. Vite `envDir: false`
and a credential-free Wrangler config under `.wrangler/r0-21/` avoid loading real
credential files. The config uses the existing fixture, absolute asset paths and
synthetic bindings, with the build hook removed.

| Check | Result |
|---|---|
| New permission-delivery fault file before repair | 5 failed / 0 passed, reproducing the known behavior |
| New permission file + existing question-delivery and permission-reply tests | 10 passed / 0 failed, 3 files |
| Full isolated Worker/DO suite | 356 passed / 0 failed, 59 files, 24.46 s |
| `bun run test` | 412 Bun + 5 runtime tests passed; zero failures |
| `bun run typecheck` | Passed |
| `bun run check:config` | Passed |
| `git diff --check` | Passed |

The five new cases cover first-failure batch recovery across service/store
recreation with no repeated acknowledged send; persisted retry bounds through
the five-minute cap; permanent failure with continued context observation,
terminal usage recording and eventual settlement; list outages and resolved/stale
cleanup; and a reply racing in-flight notification completion. A synthetic secret
in the thrown connector error is absent from emitted events.

Final source SHA256:

| File | SHA256 |
|---|---|
| `src/state.ts` | `a8f38d6774f8d45436a0545948b7dd091d2eec9e1cde2e3246c48e13c053f053` |
| `src/conversation/turn-execution.ts` | `0b7706023b9d956169b8d572c1032ca8e593d6900c7dd06ae28ad5583d93604f` |
| `src/conversation/sessions.ts` | `c03ff2970ff16233e2ed0e4ac4fce43c7ea8f1d41a63c2e3417c90fc7641bda4` |
| `src/conversation/slack-adapter.ts` | `b2699813ca41085e12a53deea7457b99a7b6f328147dabe482787954bd0fe667` |
| `test/turn-permission-delivery.test.ts` | `e28eca9b9536d23f38763ad84cce187fbf598f4c08c25b571fcdbeabd73c2ec2` |

Logs are local and ephemeral: `/private/tmp/cf-opencode-r0-21-{red,green,workers,unit,typecheck}.log`.
They are not native CI or deployed receipts. Container/control-server/Stow source,
production state and external connector state were not changed. Native CI and a
bounded, explicitly authorized deployed Slack-delivery check remain owed before
claiming production repair. No product/security gate closes from these tests.
