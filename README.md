# opencode-harness

Run [OpenCode](https://opencode.ai) as a harness on Cloudflare: **one Durable Object per conversation**, a **local S3 workspace** (stow-s3) inside the container, and **R2 for cold checkpoints**. The core speaks HTTP/SSE; Slack is just one adapter.

```
Client (HTTP/SSE, Slack, anything)
        │  POST /api/conversations/:key/messages
        ▼
Worker ──► Conversation DO (one per conversation)
             ├─ SQLite state: session, targets, dedupe, pending permissions
             ├─ container :4001 control server (status / restore / start / checkpoint)
             ├─ container :9000 stow-s3 — local S3 for the hot workspace
             ├─ container :4000 opencode serve (cwd /workspace)
             ├─ R2 CHECKPOINTS — cold tar.gz checkpoints
             └─ alarm pump → SSE subscribers (+ Slack delivery when configured)
```

- **Hot**: the workspace is a normal POSIX directory *and* an S3 bucket — stow-s3 serves the same bytes, so tools and agents can use `s3://` while OpenCode edits files.
- **Cold**: after each settled prompt the DO streams a tar.gz of the workspace to R2 (deps excluded, SQLite WAL flushed). A cold container restores it before `opencode serve` starts.
- **Transport-neutral**: every event is emitted to SSE subscribers; Slack receives the same events when a Slack target is set.

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

## Slack adapter

Optional. Set `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` and `SLACK_BOT_USER_ID`, then point the Slack app at:

- **Event Subscriptions** → `https://<worker>/slack/events`
- **Interactivity & Shortcuts** → `https://<worker>/slack/interactivity`
- **Socket Mode → off**

Without the Slack secrets the Slack routes return 503 and the harness is HTTP-only.

## Permissions

"Smart allow" rules are written into the container's OpenCode config (`entrypoint.sh`):

- allow reads/edits inside `/workspace`, web access
- allow a safe command list (`ls`, `cat`, `rg`, `git status|diff|log`, `bun test`, …)
- ask for everything else (Slack buttons or the SSE permission event)
- deny `sudo`, `rm -rf`, `git push --force`, `git reset --hard`, `.ssh`, `.env`, cloud metadata

## Deploy (Workers Builds, no local Docker)

1. Connect the repo in **Workers & Pages**.
2. **Settings → Builds**: root directory `.`, build command `bun install`, deploy command `npx wrangler deploy`.
3. Secrets: `API_TOKEN`, and optionally `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_BOT_USER_ID`.
4. Create the bucket: `bunx wrangler r2 bucket create opencode-harness-checkpoints`.
5. Push to `main` — Cloudflare builds the image, publishes it, and rolls out the container.

Non-production branches upload Worker code only (no image rollout). Use a staging Worker for image changes.

## Local development

```sh
scripts/container-dev.sh build   # Apple `container` (no Docker)
scripts/container-dev.sh run     # :4000 opencode, :4001 control, :9000 local S3
bun test
bun run typecheck
```

Apple `container` needs macOS 26+ on Apple silicon. `wrangler dev` with containers still requires a Docker-compatible engine; the script is the Docker-free path.

## Limits and open work

- The reply pump polls (2s) while a run is active; the warm-stream half is not built.
- SSE has no replay (`Last-Event-ID`) and no heartbeat between polls.
- One container (`max_instances: 1`); extra conversations queue on alarms.
- Checkpoints are per settled prompt; a crash mid-turn loses that turn.
- Channel-level engagement (`!leave`) lives in the Slack adapter and is not ported.
- Uploads and clip rendering are deferred; `slack_upload_file` lives in the container-side plugin.

## License

MIT © Chester Hill Solutions
