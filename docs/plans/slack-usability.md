# Slack usability — 2026-11-11

## Mission and results

Make the existing Team Nate OpenCode bot usable through Slack: commands must work
without provider credit, model selection must affect only its conversation, and
questions/permission requests must have actionable replies. Complete provider
setup with the operator and verify the deployed behavior.

## Locked decisions

- Port the original bot's ten controls and aliases; reuse its pure formatting
  and typed-answer helpers. Unknown `!` commands are rejected, never prompted.
- Add `!setup`/`!connect` links and `!usage`. Credentials stay out of Slack.
- `!new` changes the session mapping, preserving workspace, archives and history.
  Session/model changes require idle work and accounted usage; `!stop` interrupts
  execution without claiming that cancellation erases charges or releases holds.
- Models come from the live catalogue, with exact reference validation and close
  suggestions. A durable per-conversation override survives restoring an older
  archive. Session selection stays inside the conversation container's workspace.
- Only mentioned threads and DMs accept prompts. Thread follow-ups require prior
  engagement; `!leave` detaches the thread. Ordinary channel traffic is ignored.
- Form buttons reuse permission-button membership and tenancy checks, and the DO
  verifies current session, pending form and typed answer before forwarding.
- Slack prompt handling is text-only today. File attachments are not downloaded
  or inspected, and a non-vision model is not silently switched to another model.
  Image-only uploads may therefore be ignored until the separate S10 work below.

## Ownership and execution

| ID | Work | Owner / model | Acceptance |
|---|---|---|---|
| S1 | Inventory original commands; port format/form helpers | `slack_command_inventory`, `gpt-6-luna` / medium | All original commands inventoried; helper regressions pass |
| S2 | Standalone command dispatch | `slack_command_dispatch`, `gpt-6-luna` / high | Every command covered; errors/unknown tokens cannot become prompts |
| S3 | Conversation lifecycle, question delivery and signed routing integration | Parent | No global model mutation or accounting bypass; scoped session/form checks |
| S4 | Worker regressions for command behavior and routing/auth | Reuse S1/S2 owners | Real DO/Worker seams exercise command, history, hold, dedupe and membership behavior |
| S5 | Independent consequential review | Bounded reviewer after integration | No unresolved lifecycle/accounting or authorization finding |
| S6 | Build, deploy, operator provider connection, live verification | Parent + operator | Commands respond; connected model replies; question/permission paths checked where reproducible |
| S7 | Preserve connected credentials during settings restart | Reuse S1 Luna owner; bounded Terra review | Checkpoint both archive parts before destruction; preserve running/held work and concurrent onboarding; fail closed if saving fails |
| S8 | Operator reconciliation and idle runtime migration — implemented, reviewed and locally verified | S8b/S8c/S8d source and focused regressions accepted; operator approvals and live actions remain pending | [Receipt, quiescence, migration and approval contract](operator-reconciliation.md). Both holds remain unchanged; keep the temporary third slot until safe. |
| S9a | Native event persistence with actual `@opencode/server` package — implemented and locally verified | Existing command-dispatch owner, Luna / high | Preserve process initialization, CLI layers and accounting policy |
| S9b | Persistent-event runtime and named image — ARM and AMD64 builds/smokes passed | Same owner, Luna / high | Preserve Global/AppProcess layers, database path, policy, environment and agent UID |
| S9c | Isolated canary routing — deployed; canary 02 passed | Inventory owner, Luna / medium | Pin base and evented image digests; durable image binding selects only the explicit canary or enabled fresh conversations |
| S9d | Focused security/accounting/rollout review — accepted by Terra | Existing Terra reviewer / high | Hold preservation, authorization, snapshot handling and retry boundaries reviewed |
| S9e | Canary and fresh-conversation verification — deployed and passed | Parent + operator | HTTP and Slack text-only turns produced terminal evidence and exact ledger acknowledgement; preserve earlier unresolved holds |
| S10 | Slack image attachments and model compatibility — implemented locally, not deployed | Luna source integration complete; `files:read` scope has not been granted or reinstalled, and production verification is pending | [Scope, fallback behavior and acceptance](#s10--image-attachments) |

S1/S2 are independent; S3 owns all shared production files. S4 owners write only
their assigned new test files. Keep reviews bounded to new behavior and its
coupled runtime changes; escalate only an unresolved contract, then return routine
work to Luna.

## S10 — Image attachments

Accept image uploads in DMs and engaged channel threads, including image-only
posts and captions. The current text-only behavior remains deployed until this
work is implemented and verified.

First slice: one PNG or JPEG per message, up to 5 MiB, subject to any lower
provider limit. Explain unsupported formats, excessive sizes or additional images
instead of silently dropping attachments. Process attachments on the current
accepted message; do not automatically download images from channel history.

Check the selected model's image-input capability before prompt dispatch or
budget reservation. If it cannot read images, reply that no prompt was sent and
offer enabled, connected models that can. Keep the selected model unchanged;
the user can switch with `!model provider/model` and resubmit the image. If no
compatible model is connected, provide setup guidance. Unknown capability must
produce an explicit response rather than silently sending only the caption.

| Slice | Owner / model | Deliverable and check |
|---|---|---|
| S10a | Reuse inventory owner, `gpt-6-luna` / medium; parent accepts contract | Verify the pinned OpenCode SDK's image prompt shape, live model capability metadata and required Slack file permissions. Inspect `src/index.ts`, `src/conversation.ts`, `src/adapters/slack.ts`, `src/state.ts` and the installed SDK. Stop when the smallest supported attachment path and its limits are established; record the findings here. |
| S10b | Reuse dispatch owner, `gpt-6-luna` / high, after S10a — implemented locally | Authenticated downloads, actual file validation, immediate-only admission, engagement filtering, idempotency and accounting regressions pass. |
| S10c | Reuse inventory owner, `gpt-6-luna` / medium, after S10b — implemented locally | Capability refusal, connected model suggestions and help text are covered; no automatic model switch or prompt on refusal. |

### S10a findings (source research, 2026-11-11)

The pinned `@opencode/client` `SessionPromptInput.files` accepts entries with
`uri: string`, optional `source: {type: "inline"} | {type: "uri"; uri: string}`,
and optional `name`, `description`, and `mention`. The supported inline route is
`files: [{ uri: "data:image/png;base64,...", name }]` (or JPEG equivalent),
alongside the existing `text`. The 2.2.5 server decodes data URLs and its
internal attachment record carries base64 `data`, `mime`, and `source`; server
limit is 20 MiB, so the Slack feature's proposed 5 MiB limit remains stricter.
No filesystem write or model-side URL fetch is needed.

`client.model.list({ location: { directory: "/workspace" } })` returns
`ModelInfo[]`; each record has `providerID`, `id`, optional `type`, `enabled`,
`variants`, and `capabilities.input: string[]`. The installed 2.2.5 core checks
image support by whether an input capability starts with `image`. Check the
currently selected model (`session.get().model`, respecting the durable
per-conversation override) before reservation and dispatch. For suggestions,
filter the same live list to enabled chat models with image input capability;
unknown metadata is an explicit refusal. Do not change the selection or call
`session.prompt` on refusal.

The original event envelope omitted `files` and ignored empty-text messages.
S10 now extends the existing DM, `app_mention`, and engaged-thread acceptance
gate for file-only messages; it does not subscribe to broad `file_shared` events
or download channel history. Slack's
official [`files:read` scope](https://api.slack.com/scopes/files%3Aread) allows
retrieval and download; the official [file object reference](https://api.slack.com/methods/files.info)
shows `url_private_download`. Fetch it with the bot bearer token, with strict
HTTPS/Slack-host validation and redirect checks; add `files:read` to the app
manifest and reinstall the app. `files:write` is not needed.

One accepted Slack message is currently queued as text plus target metadata in
`ConversationState.queued`; storing a 5 MiB image as a data URL in DO state is
not an acceptable durable queue design. For this first slice, accept images
only when immediate admission is available. If busy, at capacity, or startup
fails, send a clear no-prompt/no-hold reply and ask the user to resubmit; do not
queue the image or its caption. Ordinary text queue behavior remains unchanged.
Durable image queue storage is deferred.

`src/slack-images.ts` owns validation/download and data URL conversion;
`conversation.ts` owns routing, capability preflight, immediate-admission check,
and prompt dispatch. Helper and Worker tests pass locally. Busy, capacity, or
startup failure refuses without queuing the image/caption or taking a usage
hold; ordinary text queue behavior remains unchanged. The manifest now declares
`files:read`, but the app has not been reinstalled and deployed behavior remains
text-only.

Focused checks should cover: valid PNG/JPEG, image-only/caption, MIME spoofing,
oversize metadata and streamed bytes, unsafe URL/redirect, download failure,
unsupported/unknown/nonvision model with no reservation or prompt, compatible
model suggestion without switching, accepted-DM/engaged-thread filtering,
dedupe, and busy/capacity/startup refusal with no prompt or reservation. These
local checks do not close S10: live compatible-model interpretation and a live
non-vision refusal are still required after the app scope is granted and the
Worker is deployed.

The parent reviews download authorization, redirect handling, credential exposure
and duplicate-dispatch boundaries, then runs the affected and integrated checks.
Use authenticated Slack downloads without exposing private image URLs or bot
tokens to model providers. Request any additional Slack scope/reinstallation only
after confirming it is needed and preparing the concrete change.

Completion requires a live image interpretation with a compatible model and a
live rejection with a model that cannot read images. The rejection must preserve
the selected model and create no model request or reservation. Local tests alone
do not close S10. Image support does not reconcile S8 holds or remove the need
for the temporary third slot.

## Verification and rollout

Run focused Bun/Worker tests during integration, then `bun run typecheck`,
`bun run test`, `bun run test:workers`, `bun run check:config`, `bun run build:ui`
and `git diff --check`. The container smoke test passed on November 11 after
adding the missing accounting-policy module to the image. Verify the coupled
Worker/image before production rollout; retain the prior deployment for backout.
Existing F1/F2 local changes are present and must not be silently omitted or
deployed against an incompatible image. Do not clear legacy holds to make a demo
pass. Provider authentication needs the operator's account choice/sign-in.

The operator approved thread follow-ups and test commands in their OpenCode DM.
After deploying the filtering gate, Slack's saved event list was expanded to
`app_mention`, `message.im`, `message.channels` and `message.groups`.
No paid subscription or new provider spend is authorized merely by choosing an
account. The user has authorized implementing and setting up these controls.
The approved service key uses Console credit; its creation did not change the
subscription. Testing outside the operator's DM requires an agreed destination.

## Current evidence

- S8b central preview/apply, S8c Conversation preview/apply and S8d migration
  controller are implemented, independently reviewed and locally verified.
  The accepted S8c gate includes 5 control, 28 recovery, 3 reconciliation
  contract and 34 Slack tests; S8d includes pure intent/restore-barrier and
  migration lifecycle coverage. The final integrated gate passed 562 tests
  (307 Bun, including 5 runtime tests, and 255 Worker), all five typechecks,
  config, UI, diff and dry-run deployment checks. A prior pruning test timeout
  was fixed by forcing five-object pages against real R2 with fewer fixture
  objects; pagination and retention assertions remain, and the test timeout was
  not increased. Two GET-only reconciliation previews are prepared in
  `/tmp/cf-opencode-prepare-reconciliation.mjs` but remain unrun pending deploy
  and exact operator approval. The script validates full reservation IDs and
  contains no POST/apply operation.
- S10 source routing, authenticated bounded file download, capability refusal,
  app manifest `files:read` declaration and Worker regressions are implemented
  locally and focused checks pass. No app reinstall, scope grant, production
  deploy, or Slack image test has occurred; text-only behavior remains the
  deployed behavior.

- The approved `Aboiteau Slackbot Models Request90days` key was recovered by exact
  credential ID from the canonical encrypted seed, reconnected (`/connect/key`
  HTTP 204), and saved (`/api/onboarding/finish` HTTP 200, `snapshot:true`). All
  temporary recovery files were removed; no credential value is recorded.
- Restart preservation is deployed as `0299c268-60b2-4199-8f18-3868c8211baf`.
  The source onboarding fence covers the complete streamed snapshot body, and
  failed checkpoints preserve the running container. At that deployed revision,
  the verified gate was 457 tests (270 Bun, 187 Worker), plus typecheck, config
  and diff checks; those counts do not cover the current S9 changes.
- Read-only Wrangler verification confirms production Worker version
  `eba77608-f3e4-4f48-b4e0-10a33e4e9567` (100% traffic) uses container app
  `cf-opencode-conversation`, ID `f97c74c307e64504b6debe87c94e5592`, DO namespace
  `f97c74c307e64504b6debe87c94e5592`, and base image
  `registry.cloudflare.com/ad5ec479b9a421faa2ed06c3d1c2b23a/cf-opencode-conversation-base@sha256:1401c9174256edd59bed01711f3464f5aec8b517b84f81a63f360795d2c5ce35`.
  Preserve that digest as `images.base`; the worker-version manifest, not the
  registry's tag listing, supplied the verified deployed digest. The attached
  service is `scheduling_policy: durable_object`; Cloudflare's DO-policy docs say
  updating the named image map does not replace running instances. The deployed
  Worker keeps canary key `event-retention-canary-20261111-02` on the evented
  image and enables fresh routing only for conversations proven unstarted. The
  immutable evented digest is
  `registry.cloudflare.com/ad5ec479b9a421faa2ed06c3d1c2b23a/cf-opencode-conversation-evented@sha256:826337168d6d3820181d39c69764787da6e934217889370c0a91399adc5da431`.
- A real settings version 4 restart retained the provider key. Fresh HTTP
  conversation `slack-provider-check-20261111-1824` answered `READY` using
  `opencode/deepseek-v4.1-flash`, with terminal assistant cost `$0.0017703`.
  The Console receipt shows `$0.0018` for the successful request (service account
  `1`, November 11 at 18:22:44); the runtime's exact context cost is `$0.0017703`.
  The sequence 11 cursor is a watermark, not unrecognized event rows: the stock
  CLI had `persist:false`, so those old execution/terminal payloads cannot be
  recovered. The new evented runtime passed on isolated canary `02`: fresh HTTP
  message returned `READY` using `opencode/deepseek-v4.1-flash`; terminal usage
  was `$0.0017706` (5,886 input and 4 output tokens), with execution start seq 3,
  latest step seq 10 and terminal seq 11. Restored context matched the exact
  request; the corrected live preview showed start 3, step 10 and terminal 11
  after replay from seq 0, with no blocker and no ledger change. Its canary hold
  was retired after exact ledger acknowledgement.
- Slack thread `C0A5YNXLP6C:1794446357.415529` passed `!help`, `!new` and `!model`,
  then a text-only model reply. The task used a question Continue button, followed
  by harmless `printf SLACK_READY`; the shell request asked for permission, one
  approval was granted, and it exited successfully. The final reply was
  `SLACK_READY`. The permission approval round trip also succeeded. The
  thread has native start seq 3, latest step seq 28 and terminal seq 29; summed
  assistant cost was `$0.00210574` (6,105 input and 153 output tokens). The
  canary plus Slack turns add to `$0.00387634` in today's ledger. UI evidence is
  `/tmp/aboiteau-slack-reply-proof.png`.
- The two earlier `$0.10` holds remain unchanged for S8 manual reconciliation;
  their IDs, amounts, sessions and statuses were verified unchanged. Neither
  prior hold implies zero charges. The first canary key `01` failed at capacity
  before runtime/session/reservation or provider dispatch; preserve its evidence
  and do not reset/delete it.
- S9 source research confirmed the published
  [`@opencode/server@2.2.5` package](https://registry.npmjs.org/@opencode%2fserver/2.2.5)
  `process.start` supports `events.persist:true` ([process API](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/server/src/process.ts),
  [routes](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/server/src/routes.ts));
  the [Bus defaults to `persist:false`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/bus.ts),
  and the [stock CLI omits event persistence](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/cli/src/server-process.ts).
  It has no corresponding flag or environment variable. The custom Bun entrypoint
  is implemented with the global/AppProcess layers, database path, policy,
  environment and agent UID preserved. ARM and AMD64 image smokes passed; the
  deployed evented digest is pinned above. The final gate passed 486 tests (275
  Bun, including 5 runtime tests, and 211 Worker), five typechecks, config, UI,
  diff and dry-run deployment checks. The initial ENOSPC prototype's temporary
  files were removed. A later accidental native host-probe session was deleted
  through the service API; this was not a byte-for-byte environment cleanup.
- `EVENTED_FRESH_CONVERSATIONS=true` is now deployed and user-approved. It accepts
  only stopped conversations proven unstarted, including benign `!new`, `!help`
  and `!model` bookkeeping; existing sessions, tokens, holds, checkpoints and
  other runtime evidence remain on base. The immediate Worker update also applies
  code to existing DOs; durable image bindings preserve each container's selected
  image, but do not mean old DO code is untouched. The rollout used both pinned
  images and needed no image rebuild. Backout is to disable/omit
  `EVENTED_FRESH_CONVERSATIONS`; already-bound evented conversations stay evented
  and must not be downgraded. The old canary-01 storage/evidence is preserved.
- The `after: 0` usage-preview cursor fix passed regression tests and a live
  recheck after canary restore; there was no blocker and no ledger change. Capacity
  was restored to 2 at settings version 6 after the Slack checks. The operator
  subsequently approved a temporary third slot, including its incremental runtime
  cost, until the two older holds are reconciled. The live limit is now 3 at
  settings version 7. Verification found the two held runtimes occupying two
  slots, with one slot available; both held reservations and sessions were
  unchanged. Restore the limit to 2 after S8 safely frees the held runtimes.
- Slack `!help`, `!new`, `!model`, text reply, question Continue and permission
  approval are verified in the approved `#arfin-test` thread.
- The old Slack server-side session history was not recovered after upgrade;
  Slack messages remain. Do not describe the old DM as a restored server session.
- S1/S2/S3/S4, isolated canary, fresh-conversation routing and the tested Slack
  text/button evidence are complete. S8 manual reconciliation for the two older
  holds and S10 image support remain open; the wider product goal is not closed.
  The temporary third slot provides capacity for new work until S8 is resolved.
  Preserve held containers and their evidence; do not force-recycle them.
