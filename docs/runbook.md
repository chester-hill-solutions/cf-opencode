# Runbook — Aboiteau

Operational notes for the current single-tenant harness. Tenant and onboarding procedures arrive in R2.

## Deploy

| Change | Command | Notes |
|---|---|---|
| Worker code | `bunx wrangler deploy --containers-rollout=none` | Live immediately; container image untouched |
| Container image | push to `main` with Workers Builds connected | Builds, publishes, rolls out the image |
| Both | `bunx wrangler deploy` | Requires a local Docker-compatible engine; not available on this machine |

Secrets:

```sh
bunx wrangler secret put API_TOKEN
bunx wrangler secret put SLACK_SIGNING_SECRET   # optional
bunx wrangler secret put SLACK_BOT_TOKEN        # optional
bunx wrangler secret put SLACK_BOT_USER_ID      # optional
```

The deployed token is kept at `~/.config/cf-opencode/api-token` (0600). Treat it as a shared admin
credential until R1-6 replaces it with per-tenant keys.

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
| Slack replies duplicated | At-least-once delivery after a failed post | Expected on failure; check for 429s |

## Logs and metrics

`logEvent` writes one JSON line per event. Useful events:

| Event | Fields |
|---|---|
| `turn.settled` | `durationMs`, `queued` |
| `container.ready` | `durationMs` |
| `queue.enqueued` / `queue.drained` / `queue.failed` | `transport`, `attempts` |
| `checkpoint.saved` / `checkpoint.skipped` / `checkpoint.failed` | `bytes` |
| `admission.failed` / `admission.stale` | `transport` |
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

- R2 bucket `cf-opencode-checkpoints` — one tar.gz per conversation, written after each settled turn.
- Container workspace — ephemeral; restored from R2 on cold start.
- DO SQLite — conversation state, event log (last 200), pending permissions.
- Deleting a conversation's checkpoint is safe only when no turn is running.

## Known limitations

- One container (`max_instances: 1`); extra conversations queue.
- Shared admin token; no tenants yet.
- No model credential injection; the sandbox uses whatever OpenCode can reach.
- A crash mid-turn loses that turn (the checkpoint is written after settle).
