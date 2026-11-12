# Aboiteau

> **Aboiteau** is the product; `cf-opencode` is the current code and deployment identifier until the
> v2 rename lands (see [docs/roadmap.md](docs/roadmap.md#naming)).

Run [OpenCode](https://opencode.ai) as a harness on Cloudflare: **one Durable Object per conversation**, a **local S3 workspace** (stow-s3) inside the container, and **R2 for cold checkpoints**. The core speaks HTTP/SSE; Slack is just one adapter.

```
Client (HTTP/SSE, Slack, anything)
        │  POST /api/conversations/:key/messages
        ▼
Worker ──► Conversation DO (one per conversation)
             ├─ SQLite state: session, targets, dedupe, pending permissions
             ├─ container :4001 control server (status / restore / start / checkpoint)
             ├─ native Stow Workspace — private loopback S3 endpoint
             ├─ container :4000 opencode serve (cwd /workspace)
             ├─ R2 CHECKPOINTS — cold tar.gz checkpoints
             └─ alarm pump → SSE subscribers (+ Slack delivery when configured)
```

- **Hot**: a registered native Stow Workspace serves the same `/workspace` bytes through its filesystem and S3 APIs. Startup validates its saved identity and private readiness response before starting OpenCode.
- **Cold**: after each settled prompt the DO stores separate workspace and OpenCode-state archives in R2. Native `.stow` metadata and its registry are preserved, `node_modules` is excluded, and SQLite uses a consistent backup. A cold container restores both parts before starting the saved Workspace and OpenCode.
- **Transport-neutral**: every event is emitted to SSE subscribers; Slack receives the same events when a Slack target is set.

OpenCode receives `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY` from validated native readiness. The endpoint and credentials
are generated for the running storage process and kept outside the portable R2
archives.

The pre-customer native-storage cutover supports one format. Fresh empty
workspaces are initialized once; restored workspaces must resume their saved
identity. Unsupported old state fails clearly rather than being silently reset
or converted. See the [integration plan](docs/plans/stow-workspace-integration.md)
for verification and rollout status.

## HTTP/SSE API

```sh
# start a turn
curl -X POST https://<worker>/api/conversations/demo/messages \
  -H "authorization: Bearer $API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"text":"what does this repo do?"}'

# stream events
curl -N https://<worker>/api/conversations/demo/events \
  -H "authorization: Bearer $API_TOKEN"

# answer a permission request
curl -X POST https://<worker>/api/conversations/demo/permissions/<requestID> \
  -H "authorization: Bearer $API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"decision":"once"}'

# inspect state
curl https://<worker>/api/conversations/demo -H "authorization: Bearer $API_TOKEN"
```

Frames:

```
event: assistant
data: {"type":"assistant","text":"..."}

event: permission
data: {"type":"permission","requestID":"req_1","action":"shell","resources":["ls"]}

event: settled
data: {"type":"settled"}
```

`API_TOKEN` is a Worker secret. Without it the API returns 503.

Replayable event frames carry an SSE `id`; reconnect with `Last-Event-ID` to
receive retained events after that ID, up to the last 200 events per conversation.
If the cursor predates retained history, the stream sends an id-less `reset`
control frame before replaying retained events. Inspect `/api/conversations/:key`
for current persisted state after a reset; that inspection is separate from replay
and is not an atomic snapshot with a cursor. Heartbeat comments also have no ID.
Idle connections get a `: heartbeat` comment every 15s.

## Slack adapter

Optional. Set `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` and `SLACK_BOT_USER_ID`, then point the Slack app at:

- **Event Subscriptions** → `https://<worker>/slack/events`
- **Interactivity & Shortcuts** → `https://<worker>/slack/interactivity`
- **Socket Mode → off**

Without the Slack secrets the Slack routes return 503 and the harness is HTTP-only.

Slack controls are handled directly, before any model prompt or budget admission:

| Command | Action |
|---|---|
| `!help` | Show the available controls |
| `!status` | Show this conversation's session, model/startup state and pending work |
| `!model` | List live enabled models and the current choice |
| `!model provider/model` | Change this conversation's model, preserving history; `#variant` is supported |
| `!sessions` / `!session` | List recent sessions in this conversation's workspace |
| `!sessions 2` / `!sessions ses_…` | Continue a listed or verified older session |
| `!new` | Start a fresh session on the next message; keep workspace and history |
| `!stop` | Interrupt running work and clear queued follow-ups; reconcile usage normally |
| `!leave` | Stop following the current channel thread until mentioned again |
| `!answer` / `!answer <value>` | Show or answer the waiting question; multiple fields accept `key=value` pairs |
| `!cancel` | Skip the waiting question |
| `!setup` / `!connect` | Open provider/account setup; never paste credentials into Slack |
| `!usage` | Show reported workspace spend, reserved amounts and the daily budget |

Unknown `!` commands return help instead of being sent to a model. Model changes
and session switches wait for unfinished work and usage settlement. Selecting a
model does not connect its provider or increase that provider's quota.

DMs are continuous conversations. In channels, mention the bot to engage a thread.
With `message.channels`/`message.groups` subscriptions enabled, replies in that
thread continue its session; unrelated channel traffic is ignored. Question cards
offer buttons for simple choices and text commands for more complex answers.
See the [Slack usability plan](docs/plans/slack-usability.md) for implementation
and rollout evidence, and the [runbook](docs/runbook.md) for the live connection.

## Permissions

"Smart allow" rules are written into the container's OpenCode config (`entrypoint.sh`):

- allow reads/edits inside `/workspace`, web access
- allow a safe command list (`ls`, `cat`, `rg`, `git status|diff|log`, `bun test`, …)
- ask for everything else (Slack buttons or the SSE permission event)
- deny `sudo`, `rm -rf`, `git push --force`, `git reset --hard`, `.ssh`, `.env`, cloud metadata

## Settings UI

`/` serves the Aboiteau settings page, built from the dedicated [`@aboiteau/ui`](packages/ui/README.md) package. `/ui-kit/` is the live component and brand gallery. `/onboarding/` is the first-run wizard.

The kit carries the complete CHS UI set — actions, forms, navigation, overlays, data display and conversation surfaces — plus an accent system that codes settings sections, onboarding steps and gallery sections with the same brand palette. Colour is always paired with a number or written label; see [`packages/ui/README.md`](packages/ui/README.md#brand-accents).

Onboarding connects a model provider through the running OpenCode instance (OAuth where the
provider offers it, API key otherwise), connects GitHub through an OAuth App, and sets the
workspace repository, branch and model. Completing it snapshots the OpenCode state to R2 so
new conversations start connected. Account snapshots omit conversation-specific Stow identity
and initialization state; each new conversation creates its own Workspace. Credentials live in the Settings Durable Object encrypted
by [`@chester-hill-solutions/vault`](vendor/chester-hill-solutions/vault); see
[`docs/runbook.md`](docs/runbook.md#onboarding) for the required secrets and callback URL.

- workspace repo + branch, model, poll seconds, streaming toggle
- **model selector**: a curated catalogue grouped by provider, with a recommended default
  (`opencode/deepseek-v4.1-flash`) and a `Custom…` option for anything the deployment exposes
- permission lists: allow / ask / deny shell patterns (one per line)
- API token entry, `Load settings`, `Save settings`

The page uses the approved A mark, warm paper surfaces, ultramarine actions and a restrained screenprint accent. The save bar stays visible; loading, saved, unsaved, rejected-token, catalogue fallback and network-error states are explicit. Failed saves retain the draft. Reloading is disabled while edits are unsaved.

`bun run build:ui` builds React and Tailwind assets into `public/`; Wrangler runs it automatically before development and deployment. `bun run dev:ui` starts a frontend preview at `http://127.0.0.1:4173`. Set `ABOITEAU_API_ORIGIN` to proxy a running API. `bun test tests` also checks the UI kit registry, exports and theme contract.

Sane defaults:

| List | Default |
|---|---|
| allow | read-only and build commands (`ls`, `cat`, `rg`, `git status|diff|log`, `bun test`, …) |
| ask | `git push|commit|merge|rebase`, package installs, `curl`/`wget`/`ssh`, `docker`/`kubectl`/`terraform`, `ffmpeg`, `python`/`node` |
| deny | `sudo`, `rm -rf`, `git push --force`, `git reset --hard`, `dd`, `mkfs`, `shutdown`, `reboot`, `chmod 777` |
| poll seconds | 2 |
| streaming | on |

`GET /api/models` returns the catalogue plus the recommended reference.

Settings are **global**, stored in the `Settings` Durable Object and versioned.
Saving bumps the version; a conversation restarts its container on the next turn
and restores the workspace checkpoint, so the change applies without losing work.

```
GET  /api/settings   → current settings
PUT  /api/settings   → validate, bump version, return settings
```

The panel is a demo surface: the token lives in `localStorage`. For shared
deployments put Cloudflare Access in front (or add a session endpoint) instead of
handing the shared bearer token to the browser.

## Deploy (Workers Builds, no local Docker)

1. Connect the repo in **Workers & Pages**.
2. **Settings → Builds**: root directory `.`, build command `bun install`, deploy command `npx wrangler deploy`.
3. Secrets: `API_TOKEN`, and optionally `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_BOT_USER_ID`.
4. Create the bucket: `bunx wrangler r2 bucket create cf-opencode-checkpoints`.
5. Push to `main` — Cloudflare builds the image, publishes it, and rolls out the container.

Non-production branches upload Worker code only (no image rollout). Use a staging Worker for image changes.

## Local development

```sh
bun install --frozen-lockfile
bun install --cwd runtime/opencode --frozen-lockfile
scripts/container-dev.sh build   # Apple `container` (no Docker)
scripts/container-dev.sh run     # :4000 opencode, :4001 control, :9000 local S3
bun run test
bun run typecheck
bun run check:config   # prod/test Wrangler config drift guard
```

Apple `container` needs macOS 26+ on Apple silicon. `wrangler dev` with containers still requires a Docker-compatible engine; the script is the Docker-free path.

## Testing and measurements

- `bun test tests` — 116 unit tests (signature, conversation keys, permissions, state, SSE formatting, retry/backoff, helpers, UI kit registry, settings state machine).
- `bun run test:workers` — 30 integration tests in workerd (Worker surface, DO state, Slack signature/routing, SSE, concurrency and admission-queue regressions, a latency guard).
- `bun run check:config` — fails CI when the prod and test Wrangler configs drift on bindings, exports or vars.
- `bench/measure.ts` — deployed Worker/SSE/turn latency.
- `bench/container.sh` — cold start, checkpoint size/time, restore time.

Local numbers (workerd): `/health` p50 1.0 ms / p95 1.0 ms; DO state p50 1.0 ms / p95 2.0 ms; Worker bundle 103 KB. Targets and results live in [bench/README.md](bench/README.md) and [bench/RESULTS.md](bench/RESULTS.md); the test pyramid is in [docs/testing.md](docs/testing.md).

## Roadmap

Operating notes (deploy, health, first turn, failures, rollback) are in
[docs/runbook.md](docs/runbook.md). The path from harness to product — R0 harness complete, R1 tenancy foundations, R2 self-onboarding,
R3 configurable sandbox, R4 product — is in [docs/roadmap.md](docs/roadmap.md), with gates, estimates
and the ticket-level backlog.

## Limits and open work

- The reply pump uses a warm event stream while the container is up, with a 2s alarm poll as fallback.
- One container (`max_instances: 1`); extra conversations queue on alarms.
- Checkpoints are per settled prompt; a crash mid-turn loses that turn.
- Channel-level engagement (`!leave`) lives in the Slack adapter and is not ported.
- Uploads and clip rendering are deferred; `slack_upload_file` lives in the container-side plugin.

## License

MIT © Chester Hill Solutions
