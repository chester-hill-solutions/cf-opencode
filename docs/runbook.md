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

A Durable Object's own code updates only when Cloudflare evicts it; for a change
to DO logic, create a new conversation key (or wait for eviction). `/recycle`
keeps state; the onboarding `/api/onboarding/reset` also clears state.

| Change | Command | Notes |
|---|---|---|
| Worker code | `bunx wrangler deploy --containers-rollout=none` | Live immediately; container image untouched |
| Container image | `bun run deploy` | Builds, publishes and rolls out; needs Docker Desktop running |

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

## Health checks

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://<worker>/            # UI
curl -s https://<worker>/health                                       # "ok"
curl -s -H "authorization: Bearer $TOKEN" https://<worker>/api/settings
curl -s -H "authorization: Bearer $TOKEN" https://<worker>/api/conversations/<key>
```

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
the wizard snapshots `/workspace/.state` (OpenCode config + credential database) to R2 as
`account/state.tar.gz`; new conversations seed that state before cloning, so onboarding is
performed once.

Provider credentials and the GitHub token are stored in the Settings Durable Object through
`@chester-hill-solutions/vault`, encrypted with `VAULT_MASTER_KEY`. They never appear in
`GET /api/settings`.

## Usage and budget

`GET /api/usage` returns today's spend, tokens and the configured budget:

```json
{"date":"2026-11-06","costUSD":0.42,"input":120000,"output":8000,"conversations":2,"budgetUSD":5}
```

Each conversation records `session.usage.updated` from OpenCode's event stream
(`session.text.*`, `session.usage.updated`, `session.execution.*`) as steps run,
then reports the absolute daily total to the Settings Durable Object. The ledger
keeps one entry per conversation per day, so a retried report overwrites instead
of double counting. `usage` also appears on the conversation state, and
`usageError` explains a refresh that failed.

Metering depends on the warm event stream (`streaming: true`). If the stream
cannot attach, turns still run via polling but usage is not recorded; the debug
endpoint shows the stream state and event counts:

```sh
curl -s -H "authorization: Bearer $TOKEN" \
  https://<worker>/api/conversations/<key>/debug
```

Set `dailyBudgetUSD` in settings (0 disables). Once today's total reaches it,
`POST /api/conversations/<key>/messages` returns `429` with
`{"error":"daily budget reached","spentUSD":…}`. Queued messages admitted
before the cap are still allowed to run.

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
the container. The next message on that key starts from scratch (seeded from the
account state).

## Concurrency and warmth

`maxContainers` (default 2, 1–10) caps how many conversation containers run at
once; the `durable_object` policy has no `max_instances`. The Settings Durable
Object issues a 10-minute lease per conversation container; a conversation that
cannot get one returns `202 queued` with `container capacity reached` and the
queue retries with backoff. `GET /api/leases` shows the cap and active leases,
and `capacity.rejected` counts refusals.

Leases are refreshed on every request and released on recycle/reset/delete, or
they expire after 10 minutes.

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

## Lifecycle phases

| Phase | Meaning | What to check |
|---|---|---|
| `idle` | No active turn | — |
| `admitting` | Session/prompt being created | If stuck, the next alarm resets it (stale admission) |
| `running` | Prompt sent, waiting for settle | SSE stream, container logs |
| `settling` | Reply delivered, checkpoint in progress | R2, `checkpoint.failed` events |
| `queued` | Admission held for container capacity | `queued.attempts`, alarm backoff |

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
restore checkpoints from R2. Checkpoint keys are `workspaces/<id>.tar.gz` until R1-1 makes them stable.

## Data

- R2 bucket `cf-opencode-checkpoints` — checkpoint versions per conversation at `workspaces/<id>/<timestamp>.tar.gz`, newest five kept. The archive is produced without stopping OpenCode: the live SQLite database is copied with `.backup` and substituted into the tar, so a checkpoint costs a copy and a compress, not a server restart.
- Container snapshots — captured on an explicit `recycle` before the container stops, as a fast restore cache for the next start. A snapshot is the writable root (~28 MB) and is image-bound with a 30-day TTL and no delete API, so taking one per turn would accumulate storage and slow turns; per-turn durability stays with the R2 archive.
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
- Deleting a conversation's checkpoint is safe only when no turn is running.

A checkpoint that fails is retried from the alarm up to three times (`checkpoint.retry` / `checkpoint.recovered` / `checkpoint.abandoned`). `checkpointSize` on the conversation state reports the last successful archive size.

## Known limitations

- Single container application on the `durable_object` scheduling policy. There is no per-application `max_instances`; account limits bound concurrency, so keep message throughput in mind.
- Onboarding uses the same container application and therefore the same `maxContainers` cap. With every slot warm, `/onboarding/` returns `container capacity reached`; recycle or delete a conversation to free a slot.
- Instance size is chosen at start (`standard-1`). `basic` has no exact equivalent on this policy.
- Snapshots are a fast restore cache only: they are bound to the image they were taken from, have a 30-day TTL refreshed on restore, and are not portable across deploys. The R2 tar archive remains the source of truth.
- `.stow` (the local S3 view) and `.state/cache` are excluded from checkpoints: files survive a restore, cached/provider state is rebuilt.
- A crash mid-turn loses that turn (the checkpoint is written after settle).
- Shared admin token; no tenants yet.
