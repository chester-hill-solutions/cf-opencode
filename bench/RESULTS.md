# Results

## 2026-11-06 — local Docker container (Apple Silicon, arm64)

Image: `cf-opencode:dev` · OpenCode `2.2.5` · stow-s3 `0.3.7` ·
workspace clone `chester-hill-solutions/opencode-slack@main`

| metric | value |
| --- | --- |
| cold start (container → control `/health`) | 68 ms |
| start (clone + stow-s3 + `opencode serve`) | 2.21 s |
| checkpoint | 250 ms, 180 KB |
| restart OpenCode after checkpoint | 306 ms |
| checkpoint with unchanged `since` | 200 in 120 ms |
| restore | 84 ms |

The second checkpoint still returns `200`, not `204`: restarting OpenCode
writes its session DB, so the workspace fingerprint changes even when the
source tree does not. Per-turn cost of the checkpoint/restart model is
therefore roughly 0.3–0.5 s. Keeping the per-turn restart is reasonable at
this size; an online SQLite backup is only worth it if the archive or the
restart grows much larger.

## 2026-11-06 — local (workerd / Miniflare, no container)

| metric | value |
| --- | --- |
| `/health` p50 / p95 | 1.0 ms / 1.0 ms |
| DO state (`/api/conversations/:key`) p50 / p95 | 1.0 ms / 2.0 ms |
| Worker bundle (`index.js`) | 103 KB |
| unit tests | 37 |
| integration tests | 10 |

Not yet measured (need a container and/or a deployed Worker): cold start,
`opencode serve` start, checkpoint size/time, restore time, turn latency,
`settled` overhead.

## 2026-11-06 — deployed Worker (no container yet)

URL: https://cf-opencode.chester-hill-solutions.workers.dev

| metric | value |
| --- | --- |
| `/health` p50 / p95 | 32.4 ms / 128.8 ms |
| SSE connect p50 / p95 | 188.6 ms / 340.6 ms |
| turn | skipped (`BENCH_TURN=0`, container not deployed) |

Measured over the public internet from the author's machine; includes network RTT.

Run the remaining measurements with:

```sh
bench/container.sh
HARNESS_URL=… API_TOKEN=… bun run bench
```

## 2026-11-12 — Cloudflare idle close and encrypted cold restore

Three no-inference cycles at `02e4ddf`, using the retained native evented image,
a temporary Worker/DO namespace and an empty session. Each cold read followed
confirmed container shutdown and restored the same session from encrypted split
R2 checkpoints; fast snapshots were cleared.

| metric | median | range |
| --- | --- | --- |
| warm context | 186.7 ms | 135.1–398.6 ms |
| cold context after idle stop | 6,441.6 ms | 6,159.0–7,391.3 ms |
| paired cold minus warm | 6,254.8 ms | 5,760.4–7,256.1 ms |
| observed idle-to-stopped interval | 32.13 s | 31.45–32.21 s |

These include public network latency. The idle observation includes polling,
quiescence, checkpoint and stop work beyond the 30-second policy delay. Initial
bootstrap/image priming is untimed. Three empty-session samples do not establish
p95, large-workspace performance or model-turn latency. No model prompt was sent.
The temporary runtime, Worker, container application, bucket and fresh local
secrets were removed after cleanup proved the runtime stopped and bucket empty.

Raw samples and proof limits: [measurement receipt](lifecycle-idle-2026-11-12.json).
The later telemetry validator fix retains native generation IDs beginning with
`-` or `_`; it does not change the measured runtime path.
