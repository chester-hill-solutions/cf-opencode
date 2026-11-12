# Runbook — Aboiteau

Operational notes for the current single-tenant harness.

## Deploy

After deploying an image change, long-lived Durable Objects and their containers
keep the code and image they were created with. Current conversations must be
recycled before they pick up new container routes:

```sh
curl -X POST https://<worker>/api/conversations/<key>/recycle \
  -H "authorization: Bearer $TOKEN"
```

Use `--durable-objects-code-update-mode immediate` when deploying code that must
reach existing Durable Objects immediately. `/recycle` keeps state and starts the
current image from its portable R2 checkpoint, clearing the retired image's
snapshot handle. It refuses active, queued or held work. The onboarding
`/api/onboarding/reset` clears state and is not needed for an image upgrade.

| Change | Command | Notes |
|---|---|---|
| Worker code | `bunx wrangler deploy --containers-rollout=none --durable-objects-code-update-mode immediate` | Update existing DO code; container image untouched |
| Container image | `bun run deploy` | Builds, publishes and rolls out; needs Docker Desktop running |

`bun run deploy` cross-builds `linux/amd64` under QEMU on Apple Silicon. The OpenCode version
sanity check is non-fatal there (CI verifies it natively); if the registry push drops, re-run the
deploy — wrangler skips an image that is already remote.

Message creation is limited to 60 requests/minute per client by the `API_RATE_LIMIT` binding. A
blocked request returns the CHS `RATE_LIMITED` body with `RateLimit-*` and `Retry-After` headers.
The binding is approximate per Cloudflare location; treat it as burst protection, not billing.

Secrets:

```sh
bunx wrangler secret put API_TOKEN
bunx wrangler secret put VAULT_MASTER_KEY        # 64 hex characters
bunx wrangler secret put GITHUB_CLIENT_ID
bunx wrangler secret put GITHUB_CLIENT_SECRET
bunx wrangler secret put SLACK_SIGNING_SECRET   # optional
bunx wrangler secret put SLACK_BOT_TOKEN        # optional
bunx wrangler secret put SLACK_BOT_USER_ID      # optional
```

The local API token is kept in the gitignored `.dev.vars` at the repo root (0600). Treat it as a shared
admin credential until onboarding grows real users.

`VAULT_MASTER_KEY` is required for persistence: without it, workspace checkpoints and account seeds are
refused rather than written to R2 in plaintext, and `/api/health` returns 503. Set
`ALLOW_PLAINTEXT_ARCHIVES=1` only for a throwaway deployment where provider credentials in R2 are
acceptable.

## Health checks

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://<worker>/            # UI
curl -s https://<worker>/health                                       # "ok"
curl -s -H "authorization: Bearer $TOKEN" https://<worker>/api/settings
curl -s -H "authorization: Bearer $TOKEN" https://<worker>/api/conversations/<key>
```

## Slack connection — 2026-11-11

With operator approval, Team Nate's existing **OpenCode** app (`A0CEH25QREK`,
workspace `T0M9QV926`) now uses the production `cf-opencode` Worker. The workspace
had reached its app limit, so this replaces the old Socket Mode connection rather
than creating a second app. The Slack display name remains OpenCode.

- Worker secrets `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` and
  `SLACK_BOT_USER_ID` are configured. Slack `auth.test` confirmed the workspace,
  bot identity and granted `im:read` scope after reinstallation. Credential values
  are not recorded here; the temporary transfer file was removed.
- Events: `https://cf-opencode.chester-hill-solutions.workers.dev/slack/events`,
  verified by Slack and saved. Initially only `app_mention` and `message.im` were
  subscribed. After the thread engagement gate deployed, `message.channels` and
  `message.groups` were added to carry engaged-thread follow-ups; ordinary channel
  messages are still ignored by the Worker.
- Interactivity: enabled at
  `https://cf-opencode.chester-hill-solutions.workers.dev/slack/interactivity`.
- Socket Mode: off. App Home Messages tab: on, with sending messages enabled.
- Local launchd service `ca.chesterhill.opencode-slack-bot`: unloaded and
  disabled across logins. Its plist was retained for rollback; the separate
  OpenCode server service was not changed.
- The existing `files:write` and `reactions:write` permissions were retained;
  the [new-app manifest](slack-app-manifest.yml) specifies the smaller set needed
  by the Worker.

Verification: production `/health` returned 200 `ok`; a signed URL-verification
challenge returned 200 with the expected challenge; Slack displayed **Verified**.
Slack's saved event list now includes all four subscriptions above. The initial
connection setup made no model call or Slack message.

For a new installation, configure the signing secret on the Worker **before**
Slack verifies its event URL: signature validation precedes the challenge handler.
Set the bot token and bot user ID, install the required scopes, then save and
verify the callback URLs. Enable incoming messages under App Home. If replacing
Socket Mode, confirm that this intentionally retires the previous bot connection.

To back out of this transport switch, enable Socket Mode again, then restore the
old bot service:

```sh
launchctl enable "gui/$(id -u)/ca.chesterhill.opencode-slack-bot"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ca.chesterhill.opencode-slack-bot.plist"
```

Restore channel event subscriptions only when thread follow-ups are needed. Their
presence does not admit ordinary channel messages; the Worker requires a mention
or an already-engaged thread.

### Slack command follow-up

The deployed bot responds to `!help`, `!usage` and model catalogue requests in the
operator's DM. The approved `#arfin-test` thread passed `!help`, `!new`, `!model`,
a text reply, question Continue and permission approval. The task requested
`SLACK_READY`, which appeared in the final reply. These checks prove text and
button paths; Slack image attachments remain unsupported by the current text-only
prompt route. See the [command reference](../README.md#slack-adapter) and
[current evidence](plans/slack-usability.md#current-evidence).

The dedicated key `Aboiteau Slackbot Models Request90days` was created in the CHS
Console, recovered from the canonical encrypted seed by exact credential ID,
reconnected through `/connect/key` (204), and saved by `/api/onboarding/finish`
(200, `snapshot:true`). Temporary recovery files were removed; the value is not
recorded. Worker `0299c268-60b2-4199-8f18-3868c8211baf` checkpoints before
settings-driven restarts; a real settings version 4 restart retained the key.
The fresh HTTP check replied `READY` using `opencode/deepseek-v4.1-flash`. The
Console receipt lists `$0.0018` for the request (service account `1`, November 11
at 18:22:44); the runtime context reports exact cost `$0.0017703`. Sequence 11 is
the log watermark, not a set of unrecognized rows. Stock CLI 2.2.5 configures its
event Bus with `persist:false`, so replay has no execution, step-fence or terminal
usage payloads. The published `@opencode/server@2.2.5` process API supports
`events.persist:true`, but the stock CLI exposes no flag or environment variable;
a custom Bun entrypoint was first verified on the isolated evented canary. That
HTTP canary returned `READY` and its terminal usage was acknowledged against the
ledger; the older sequence 11 turn remains unrecoverable. See the source links
and live evidence in the [usability plan](plans/slack-usability.md#current-evidence).

The earlier successful HTTP turn and the Slack DM attempt's `$0.10` hold remain
retained. The DM failed with `provider.no-route` and no assistant reply. Keep both
older holds for the separate S8 operator/manual reconciliation; never infer zero
charges or automatically clear them. The isolated canary's new hold was retired
after exact ledger acknowledgement. Worker `eba77608-f3e4-4f48-b4e0-10a33e4e9567`
now enables evented routing for proven-fresh conversations; existing histories,
holds and checkpoints remain on the base image. The two older `$0.10` holds remain
for S8 manual reconciliation and must not be auto-zeroed. After restoring the
two-slot limit following testing, the operator approved a temporary third slot
and its incremental runtime cost until reconciliation. The live limit is 3 at
settings version 7; verification found two held runtimes and one available slot,
with the held reservations and sessions unchanged. Restore `maxContainers` to 2
after S8 safely frees the held runtimes.
The old server-side session history was not recovered. Any future image rollout
must preserve held containers and their evidence; do not force-recycle them.

Only replies in a mentioned, engaged thread reach prompt admission; ordinary
channel posts and duplicate mention deliveries are ignored. `!leave` detaches the
thread. Existing legacy conversations copy missing static keys while preserving
active local credentials. Sync does not copy OAuth refresh tokens or external
host credentials, and excludes namespaced agents.

## Container smoke test

```sh
bun run smoke:container                       # Docker (default)
RUNTIME=container bun run smoke:container     # Apple container
```

Builds the image and proves the control plane the Durable Object depends on: token enforcement,
OpenCode configuration (including the credential denials), local S3, the OpenCode proxy, and
workspace/state checkpoint and restore round-trips. It never calls a model provider, so it is safe in CI.

## First turn (once the image exists)

```sh
curl -s -X POST https://<worker>/api/conversations/demo/messages \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"what does this repo do?"}'

curl -N https://<worker>/api/conversations/demo/events \
  -H "authorization: Bearer $TOKEN"
```

Expected: `{"ok":true,"sessionID":"ses_..."}`, then `assistant` and `settled` frames. The conversation
state should move `admitting → running → settling → idle`.

If no provider is connected, `opencode/deepseek-v4.1-flash-free` works without credentials; paid
models require a completed provider onboarding.

## Verify direct-path permission checks

This check confirms that the shell tool denies this literal path. A `BLOCKED` result does **not**
isolate provider state from repository-controlled test or typecheck code: audit 32 already showed
that default-allowed `bun test` and `bun run typecheck` can read a synthetic sibling-state marker
under the shared identity. Keep use limited to trusted repositories; this is a permission check,
not evidence of credential isolation ([boundary findings](design/r1-agent-boundary.md#31-filesystem-layout)).

Send the agent a prompt that names the harness state:

```text
Use the shell tool to run exactly: cat /var/lib/aboiteau/state/config/opencode/opencode.json >/dev/null && echo READABLE || echo BLOCKED. Then reply with only READABLE or BLOCKED. Do not do anything else.
```

`GET /api/conversations/<key>/debug/messages` should show a `shell` tool call with
`permission.rejected` / `Permission denied: shell`, and the reply should be `BLOCKED`. A `READABLE`
reply means this literal-path permission check failed; stop and check the container configuration.

## Onboarding

First-run setup lives at `/onboarding/`. It connects a model provider, GitHub, and the workspace.

Required secrets:

```sh
wrangler secret put VAULT_MASTER_KEY     # 64 hex chars; encrypts stored credentials
wrangler secret put GITHUB_CLIENT_ID     # GitHub OAuth App
wrangler secret put GITHUB_CLIENT_SECRET
```

GitHub OAuth App settings:

| Field | Value |
|---|---|
| Homepage URL | `https://<worker>/` |
| Authorization callback URL | `https://<worker>/api/onboarding/github/callback` |
| Scopes requested | `repo read:user` |

The wizard calls the running container's OpenCode API (`/api/integration`) for provider
sign-in, so provider OAuth must complete while the onboarding container is warm. Completing
the wizard snapshots the OpenCode config and credential database from
`/var/lib/aboiteau/state` to R2 as `account/state.tar.gz`; new conversations seed that
state before cloning, so onboarding is performed once. It is stored outside `/workspace`.

Provider credentials and the GitHub token are stored in the Settings Durable Object through
`@chester-hill-solutions/vault`, encrypted with `VAULT_MASTER_KEY`. They never appear in
`GET /api/settings`.

## Usage and budget

`GET /api/usage` returns measured actual spend (`costUSD`), active reservations
(`reservedUSD`), their conservative sum (`admittedUSD`), tokens and the configured budget:

```json
{"date":"2026-11-06","costUSD":0.42,"reservedUSD":0.10,"admittedUSD":0.52,"input":120000,"output":8000,"conversations":2,"budgetUSD":5}
```

At settlement, each conversation replays OpenCode 2.2.5's finite durable session
log. Individual step and auxiliary usage events supply the amount and original UTC
event date. Settings records each conversation/session/event identity once and
atomically updates its daily aggregate; an older report cannot lower a recorded
amount. Resetting a conversation or replacing its provider session leaves these
central records intact. The caller advances its replay cursor only after each
report is acknowledged. The current assistant's usage and a later execution-terminal
event must both be present before releasing the hold. An output-limit step can be
followed by more model work; it is not sufficient proof of completion. Missing
logs, missing usage or rejected reports pause settlement and retain the hold.
Metering works with polling when streaming is disabled.

`session.usage.updated` is a lifetime total that already includes title and
compaction costs. It is not added to the ledger. `costUSD` is recorded provider
usage; `reservedUSD` includes owned in-flight and unresolved legacy holds.
`admittedUSD` is their sum. Actuals are refreshed at settlement, so running work can
incur costs beyond its fixed hold. Provider-reported/catalog pricing is not a
billing reconciliation or a hard spend cap. The debug endpoint shows stream state
and event counts:

```sh
curl -s -H "authorization: Bearer $TOKEN" \
  https://<worker>/api/conversations/<key>/debug
```

Set `dailyBudgetUSD` in settings (0 disables). Admission atomically considers actual
spend and active holds; a budget denial returns `429` with spent/reserved/budget
figures. Capacity-queued work owns no budget hold until readiness and admission.
Reset or delete returns `409` while dispatched work or its usage remains unresolved;
reconcile the turn before retrying the destructive action. A timeout alone does not
prove that model work stopped.

**Foreground accounting policy.** OpenCode starts with fixed runtime config
`experimental.background_compaction: false` and `agents.title.disabled: true`.
Foreground automatic compaction remains available. Request-derived session titles
still work. The Worker requires the controller's `foreground-usage-v1` process
generation proof and validates effective provider config before caching readiness;
an old image or managed config that re-enables detached billing cannot silently
pass that check. Policy rejection must not recycle active work. Reset/delete drain
usage and refuse cleanup while the provider execution remains unresolved.

**Legacy cutover.** Nonzero aggregate-only rows have no event identities. Until
explicit cutover, mixed source writes and new admission for affected conversations
are blocked; other conversations and zero legacy rows remain usable. Do not clear
money or holds, or disable the budget, to bypass this boundary.

The authenticated preview endpoint reads balances, holds, local lifecycle, effective
runtime policy and the provider log boundary:

```sh
curl -s -H "authorization: Bearer $TOKEN" \
  https://<worker>/api/conversations/<key>/accounting/cutover
```

It changes no accounting records, replay cursor, hold or dispatch state. Readiness
may start infrastructure. Review `canApply`, `blockers`, the proposed opening
balances and `historicalUsageUnreconciled`. Active/queued work, any unresolved hold,
missing/unsafe runtime proof, incomplete execution/log evidence or a provider log
behind the recorded cursor blocks apply.

After reviewing an applicable preview, submit its exact `planID`:

```sh
curl -s -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -X POST https://<worker>/api/conversations/<key>/accounting/cutover \
  -d '{"expectedPlanID":"<64-character planID from preview>"}'
```

Apply rechecks the plan under admission/accounting locks and commits the central
receipt and opening balances atomically. Changed evidence returns `409` without
conversion. Repeating the same plan returns the same receipt. All old recorded
amounts stay unchanged; historical provider bills are **not reconstructed**. The
receipt marks this explicitly, and today's usage exposes
`historicalUsageUnreconciled` when it includes an opening balance.

The original session's events through the recorded watermark are covered by that
opening boundary. Later events add once. Reports must carry the current receipt's
ordering ID; delayed old writers cannot overwrite it. Reset or replacement sessions
recover the ID from Settings while applying the sequence cutoff only to its original
session. A crash after central commit cannot lose the receipt.

No production cutover has been run. Deploy the Worker and matching policy-enabled
image together only after old writers/work are quiesced and the real-container
compatibility checks pass. Existing unresolved holds still require F2 reconciliation;
cutover never releases them. These checks do not make arbitrary repository code or
external integrations part of the metered provider execution.

Source records and aggregates share 30-day retention; expired reports cannot
recreate pruned spend. The cutover receipt survives daily pruning. This operational
ledger is not a historical billing archive.

**Backout:** quiesce admission and reporting before changing the accounting writer;
preserve source records, daily aggregates, cutover receipts, retirement markers and
unresolved holds together. An older
aggregate-only Settings implementation does not honor source-aware rows and can
overwrite them. Keep the source-aware writer or deploy a forward fix until a
verified conversion/backout procedure exists; reverting application code alone is
not a safe accounting rollback.

## Held-turn recovery

The recovery API is for the existing trusted operator. Inspect a conversation before
requesting an action:

```sh
curl -s -H "authorization: Bearer $TOKEN" \
  https://<worker>/api/conversations/<key>/recovery
```

The response includes `kind`, `actions`, `blockers`, the current `snapshotID`, local
ownership, central holds and any retirement receipt. Cached execution/usage fields
are labelled `last_observed_not_fresh_provider_proof`. Inspection does not start a
provider, send a prompt, update the registry or change accounting, alarms or cursors.
An authority failure produces a blocked view; absence of readable evidence is not
proof that no hold or charge exists.

Use only an action listed in `actions`, with the exact snapshot just inspected:

```sh
curl -s -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -X POST https://<worker>/api/conversations/<key>/recovery \
  -d '{"action":"cancel_before_dispatch","expectedSnapshotID":"<snapshotID>"}'
```

`cancel_before_dispatch` is available only for a strictly never-dispatched local
proposal, with no queued/live work or unfinished cached execution and matching or
absent central ownership. Settings atomically retires the captured ID and removes
its matching hold. Conversation clears its proposal only after that decision is
acknowledged. Recorded spend and cutover/opening-balance data are preserved. A lost
acknowledgement or crash before local clearing can be retried after inspecting again.

For a dispatched turn, the permitted action is `retry`:

```sh
curl -s -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -X POST https://<worker>/api/conversations/<key>/recovery \
  -d '{"action":"retry","expectedSnapshotID":"<snapshotID>"}'
```

`202` means the existing recovery alarm was scheduled. The request sends no prompt
and releases no hold itself. Poll inspection afterward: fresh provider evidence,
acknowledged usage and execution completion are still required by normal settlement.
A queued follow-up can advance only after the held turn safely settles.

Changed snapshots or unavailable actions return `409`; inspect again instead of
reusing stale evidence. Malformed/unsupported action bodies return `400`. There is
no force flag, arbitrary hold-ID selector or amount override. Live admission or
polling can temporarily block an action.

Legacy holds, orphaned central holds, conflicting owners/dates and unsupported
records remain retained with no cancellation action. Unknown usage, an active
provider, unreadable logs or rollback cannot be turned into zero spend. External
billing/stop-evidence import and comprehensive legacy/manual reconciliation remain
outside this scoped API. Preserve the evidence and investigate the reported blocker.

Every acknowledged release/cancellation records a permanent retirement marker.
A late acquisition of that ID is rejected, even after midnight, daily pruning or a
local reset. Same-operation retries return the original receipt; its `released`
value describes that original decision. Markers have no TTL because the protocol
does not impose a provable maximum request lifetime. Account for their storage
growth. Back up and preserve them with holds, receipts and source records; rolling
back to a writer that ignores retirement can recreate holds.

No live recovery action, deployment or production cutover has been performed by
the local implementation work. Release/acquisition handling must roll out together
after the existing staging/container checks.

## Metrics

`GET /api/metrics` returns today's counters, incremented by the conversation DOs:

```json
{"date":"2026-11-06","metrics":{"turn.settled":8,"checkpoint.saved":8,"queue.enqueued":1,"container.recycled":1}}
```

Counters: `turn.settled`, `turn.failed`, `turn.timedout`, `checkpoint.saved`,
`checkpoint.skipped`, `checkpoint.failed`, `queue.enqueued`, `queue.drained`,
`queue.failed`, `admission.failed`, `container.recycled`. Pass `?date=YYYY-MM-DD`
for another UTC day.

## Deleting a conversation

```sh
curl -X DELETE https://<worker>/api/conversations/<key> \
  -H "authorization: Bearer $TOKEN"
```

Removes every checkpoint version, the legacy archive and the DO state, and stops
the container. It returns `409` instead if dispatched work or usage is unresolved;
reconcile that turn first. The next message on a successfully deleted key starts
from scratch (seeded from the account state).

## Concurrency and warmth

`maxContainers` (default 2, 1–10) caps how many conversation containers run at
once; the `durable_object` policy has no `max_instances`. The Settings Durable
Object issues a 10-minute lease per conversation container; a conversation that
cannot get one returns `202 queued` with `container capacity reached` and the
queue retries with backoff. `GET /api/leases` shows the cap and active leases,
and `capacity.rejected` counts refusals.

Leases are refreshed on every request and on every turn poll, released on
recycle/reset/delete and when a container fails to start, or they expire after
10 minutes. Onboarding is exempt: it never takes a slot, so `/onboarding/` works
even when every conversation is warm.

Containers stay warm for 10 minutes after a conversation goes quiet
(`setInactivityTimeout`), so quick follow-up turns skip the cold start. Raise it
for latency, lower it for idle cost.

## Alerts

A cron trigger runs every 15 minutes and compares today's counters and spend
against the last values reported:

| Alert | Trigger |
|---|---|
| `capacity.rejected` | container cap hit |
| `turn.failed`, `turn.timedout` | failed or abandoned turns |
| `checkpoint.failed`, `snapshot.failed` | durability failures |
| `budget` | daily spend reaches 80% of `dailyBudgetUSD` |

Each new value is reported once per UTC day (high-water marks in the Settings
DO). Alerts are stored and exposed:

```sh
curl -H "authorization: Bearer $TOKEN" https://<worker>/api/alerts
curl -X POST -H "authorization: Bearer $TOKEN" https://<worker>/api/alerts/check
```

When `SLACK_BOT_TOKEN` and `ALERT_CHANNEL` are set, new alerts are also posted
to Slack. Without them they are stored only.

## Conversations

Durable Objects cannot be listed, so the Worker records every key it touches in
the Settings DO:

```sh
curl -H "authorization: Bearer $TOKEN" https://<worker>/api/conversations
# {"conversations":[{"key":"snap-recycle","lastSeenAt":1794020851333}]}
```

Keys are ordered by last activity. Deleting a conversation also removes its
registry entry.

## Tracing and OpenTelemetry

Workers tracing is enabled in `wrangler.jsonc` (`observability.traces`, 100%
head sampling) so every invocation, binding call, fetch and Durable Object hop
is traced with no SDK. Custom spans mark the harness's own work:

| Span | Covers |
|---|---|
| `container.start` | container start, with `container.start_mode` (`snapshot`/`image`) |
| `container.snapshot` | snapshot capture, with `snapshot.bytes` |
| `conversation.checkpoint` | archive + R2 upload, with `checkpoint.bytes` |
| `conversation.settle` | end-of-turn delivery, with failure and duration |

`GET /api/health` returns the current `traceId`, so a response can be matched to
its trace. Traces are visible in the dashboard (7-day retention).

To export to an OTLP destination (Honeycomb, Grafana Cloud, Axiom, ...), create
the destination in the Cloudflare dashboard, then add its name:

```jsonc
"observability": {
  "traces": { "enabled": true, "destinations": ["my-destination"], "persist": false }
}
```

`persist: false` keeps traces only in the external destination. Note that custom
metrics are still the harness's own (`GET /api/metrics`); Workers custom metrics
cannot be exported over OTLP.

## Lifecycle phases

| Phase | Meaning | What to check |
|---|---|---|
| `idle` | No active turn | — |
| `admitting` | Session/prompt being created | If stuck, the next alarm resets it (stale admission) |
| `running` | Prompt sent, waiting for settle | SSE stream, container logs |
| `settling` | Reply delivered, checkpoint in progress | R2, `checkpoint.failed` events |
| `queued` | Waiting for container capacity; no budget hold until readiness | `queued.attempts`, alarm backoff |

## Common failures

| Symptom | Cause | Action |
|---|---|---|
| `{"ok":true,"queued":true,"error":"container port 4001 did not become ready"}` | No image has been built/rolled out | Connect Workers Builds, push to `main` |
| `503 {"error":"API_TOKEN is not configured"}` | Secret missing | `wrangler secret put API_TOKEN` |
| `401 unauthorized` | Wrong bearer token | Re-read `~/.config/cf-opencode/api-token` |
| Slack `401 invalid signature` | Wrong signing secret, or a proxy rewriting the body | Re-check the secret and request URL |
| `202 queued` repeatedly, then an SSE `error` | Container capacity or a broken image | Check `queue.failed`, container logs |
| `error: workspace checkpoint failed` | R2/tar failure | Check R2 binding and disk; the turn is not durable |
| SSE `error` with `Model unavailable: <ref>` | Provider has no credential for that model | Connect the provider in `/onboarding/`, or change the model |
| SSE `error` with `Insufficient account funds` (402) | Provider account out of credit | Top up the provider account; turns keep failing until then |
| A turn ends with no reply and no error | Should not happen: failed steps now carry their error | Check `lastTurnError` and `GET /api/conversations/:key/debug/messages` |
| `VAULT_MASTER_KEY is not configured` | Missing secret | `wrangler secret put VAULT_MASTER_KEY` (64 hex chars) |
| `GitHub OAuth is not configured` | OAuth App secrets missing | Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` |
| `workspace clone failed … Could not resolve host` | Container egress disabled | Ensure `container.start({ enableInternet: true })` |
| Slack replies duplicated | At-least-once delivery after a failed post | Expected on failure; check for 429s |

## Logs and metrics

`logEvent` writes one JSON line per event. Useful events:

| Event | Fields |
|---|---|
| `turn.settled` | `durationMs`, `queued` |
| `turn.failed` / `turn.timedout` | `durationMs`, `error` |
| `container.ready` | `durationMs` |
| `queue.enqueued` / `queue.drained` / `queue.failed` | `transport`, `attempts` |
| `checkpoint.saved` / `checkpoint.skipped` / `checkpoint.failed` | `bytes` |
| `checkpoint.retry` / `checkpoint.recovered` / `checkpoint.abandoned` | `attempts` |
| `admission.failed` / `admission.stale` / `settlement.stale` | `transport`, `durationMs` |
| `container.recycled` | — |

```sh
bunx wrangler tail --format pretty
# dashboard → Workers Logs → filter on the event name
```

## Rollback

```sh
bunx wrangler rollback --message "rollback"
```

Worker rollback does not revert the container image. If a bad image is the cause, roll the image
forward (a new build) or redeploy the previous Worker version with `--containers-rollout=none` and
restore checkpoints from R2. Split checkpoint keys are
`workspaces/<id>/workspace-<timestamp>.tar.gz` and
`workspaces/<id>/state-<timestamp>.tar.gz`. The newest five of each recognized class
are kept, together with every object referenced by the current manifest or recorded
legacy checkpoint key; unknown names are left untouched.

## Budget reservation cutover and backout

This is a quiesced procedure only; no production migration or cutover has been performed. Before
changing readers/writers, pause new admissions through both HTTP and Slack. Reconcile obtainable
actual usage and confirm dispatched work has stopped; keep unresolved legacy holds visible. Do not
run mixed old and new writers during the transition. A timeout does not prove that work was
cancelled. Before rolling back to a reader that does not understand owned reservations, resolve
new holds first or keep admissions paused until the compatible reader is restored. There is no
automatic hold migration tool.

## Data

- R2 bucket `cf-opencode-checkpoints` — split workspace/state checkpoint versions under `workspaces/<id>/`, newest five per class plus active references kept. The archive is produced without stopping OpenCode: the live SQLite database is copied with `.backup` and substituted into the tar, so a checkpoint costs a copy and a compress, not a server restart.
- Container snapshots — a fast restore cache for the image that created them. They are image-bound, have a 30-day TTL and no delete API. Explicit `/recycle` checkpoints to R2, clears the old image's stored snapshot handle, and destroys the container so the next start uses the current image; ordinary per-turn durability stays with the R2 archive.
- Container workspace — ephemeral; restored from R2 on cold start.

Start path: try the stored snapshot, and on any failure log `snapshot.stale`, delete the handle, start from the image, then restore the newest R2 archive. Counters: `snapshot.restored`, `snapshot.stale`, `snapshot.failed`. To exercise the fallback without an image change, poison the handle and take a turn:

```sh
curl -X POST -H "authorization: Bearer $TOKEN" https://<worker>/api/conversations/<key>/debug/snapshot/invalidate
./scripts/check-snapshot-fallback.sh    # turn -> recycle -> poison -> turn
```

The poisoned handle still reports `snapshot: true` (a handle exists); after the
next turn the log shows `snapshot.stale`, `snapshot.stale` increments, the handle
is cleared, and `startMode` is `image`.

For a turn that failed without an obvious cause, read the raw session context:

```sh
curl -H "authorization: Bearer $TOKEN" https://<worker>/api/conversations/<key>/debug/messages
```
- DO SQLite — conversation state, event log (last 200), pending permissions, checkpoint size and retry state.
- Settings DO — per-day metrics, alert high-water marks and history, usage ledger entries, leases and the conversation registry. Per-day keys and registry entries older than 30 days are pruned by the alert check.
- Deleting a conversation's checkpoint is safe only when no turn is running.

A checkpoint that fails is retried from the alarm up to three times (`checkpoint.retry` / `checkpoint.recovered` / `checkpoint.abandoned`). `checkpointSize` on the conversation state reports the last successful archive size.

## Known limitations

- Single container application on the `durable_object` scheduling policy. There is no per-application `max_instances`; account limits bound concurrency, so keep message throughput in mind.
- Instance size is chosen at start (`standard-1`). `basic` has no exact equivalent on this policy.
- Snapshots are a fast restore cache only: they are bound to the image they were taken from, have a 30-day TTL refreshed on restore, and are not portable across deploys. The R2 tar archive remains the source of truth.
- `.stow` (the local S3 view) and `.state/cache` are excluded from checkpoints: files survive a restore, cached/provider state is rebuilt.
- A crash mid-turn loses that turn (the checkpoint is written after settle).
- Shared admin token; no tenants yet.
