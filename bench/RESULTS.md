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

## 2026-11-13 — local shape sensitivity and image diet (directional)

Local Docker on Apple Silicon, same runtime image, time from process start to
`/api/info`. This is not a Cloudflare measurement; it isolates the CPU shape and
image content. The deployed 6.16–7.39 s cold read is consistent with the 0.5 vCPU
empty-workspace row.

| CPU available | Empty workspace | `cf-opencode` repo |
|---|---:|---:|
| 0.25 vCPU (`basic`) | 39.1 s | — |
| 0.5 vCPU (`standard-1`) | 5.9–6.5 s | 7.9 s |
| 1 vCPU (`standard-2` shape) | 1.9–2.5 s | 3.3 s |
| 2 vCPU | 1.4 s | — |

Image probe: **739 MB → 514 MB arm64 / 469 MB amd64**. Removing `.d.ts`, `.map`,
`.md`, `effect/src`, `effect/ai-docs`, musl prebuilds and Bun's hardlink install
cache reduced `runtime/opencode/node_modules` from **416 MB to 214 MB**. The prune
must run in the same layer as `bun install`; a later Docker layer cannot reclaim
the hardlinked cache. A slim base (`oven/bun:1.3-slim`) also removes the full
Debian userland. License files are preserved.

Limits: Docker CPU quotas are not Cloudflare’s scheduler; the repo row includes
the copied repo and cold page cache is not controlled. These numbers select the
next A/B, they do not replace the Cloudflare run.

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

## 2026-11-14 — Cloudflare instance-shape A/B (no inference)

An isolated temporary Worker compared `standard-1`, the default custom
1 vCPU / 2 GiB / 8 GB profile, and `standard-2`, all using the same stow-s3
0.4.0 image. Each profile had one untimed image/runtime prime followed by three
confirmed cold starts and immediate warm model-catalogue requests. The test made
no message requests, created no session, and confirmed each reset stopped the
container. Public network and model-list response time are included; no model
prompt or inference ran.

| Instance profile | Cold p50 | Cold range | Warm p50 | Warm range |
| --- | ---: | ---: | ---: | ---: |
| `standard-1` | 9.30 s | 9.20–9.73 s | 117 ms | 109–118 ms |
| `custom-1cpu-2gib` | 9.65 s | 9.12–9.80 s | 107 ms | 102–161 ms |
| `standard-2` | 9.85 s | 9.17–10.60 s | 141 ms | 111–212 ms |

These three-sample, empty-workspace results do not establish p95, first-token or
turn throughput, memory headroom, or cost per task. Keep the existing custom
profile as the default: the larger `standard-2` showed no material cold/warm
advantage in this bounded no-inference comparison. Do not treat this as the
turn-latency or memory-guard gate.

Raw requests, per-profile warm-up, runtime checks, versions and limits are in
[the shape A/B receipt](cloudflare-instance-shape-2026-11-14.json).
