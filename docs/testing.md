# Testing

Three layers, plus measurements.

## 1. Unit — `bun test tests`

Pure logic, no runtime: signature verification, conversation keys, permission
rules, conversation state, message/reply helpers, SSE formatting, port fetch, and the
UI kit registry/export/theme contract.
102 tests, milliseconds.

## 2. Integration — `bun run test:workers`

`@cloudflare/vitest-plugin` runs the Worker and the `Conversation` DO in workerd
via Miniflare. Covers:

- `/health`
- API auth (401 without token) and key validation (400)
- conversation state through the DO
- Slack signature verification, `url_verification`, bad-signature rejection
- signed event routing
- SSE content type
- interactivity rejection for unknown actions

30 tests. No Docker and no container involved.

## 3. End-to-end — container + deployed Worker

Not in CI yet (needs an image build and a model credential). Checklist:

- message → `assistant` → `settled` over SSE
- permission request → approve/deny → run continues
- checkpoint → stop container → restore → next turn sees the previous files
- SSE reconnect after a DO eviction
- Slack mention → threaded reply (optional adapter)

Run the container side with `bench/container.sh`; the turn with
`bench/measure.ts`.

## Measurements

- `bench/measure.ts` — Worker/SSE overhead and turn latency against a deployed URL
- `bench/container.sh` — cold start, start, checkpoint size/time, restore time

Targets and the results format live in [`bench/README.md`](../bench/README.md).

## CI

`.github/workflows/ci.yml` runs:

```sh
bun install --frozen-lockfile
bun run check:config
bun run typecheck
bun run build:ui
bun test tests
bun run test:workers
```

## Known gaps

- No container e2e in CI (image build + provider key).
- No Slack adapter e2e (needs a test workspace).
- SSE replay/heartbeat is covered at the formatting/state level; no end-to-end
  reconnect test against a live container yet.
- No load test: the harness runs `max_instances: 1`; extra conversations queue on alarms.
- Settings validation is unit-tested and the API is covered in workerd; applying settings across a container restart is not e2e-tested yet.
- The warm-stream pump is covered by the SSE parser tests; no live-stream e2e yet.
