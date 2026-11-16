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

## 2026-11-14 — R0-23 comparison preparation (no inference)

Prepared the shared diagnostic inventory: ten independent coding tasks across
two authored Bun repositories, with 120 cold/warm and 30 fault attempts planned
across Aboiteau and OpenCodeHarness plus Linux. Exact task/source/dependency/image
identities and thresholds are in the
[v1 frozen manifest](comparison/protocol.freeze.v1.json).

Both isolated TypeScript projects pass. Nine evidence/adapter tests pass (34
assertions). All ten unchanged bases fail their target oracle; all ten reference
repairs and the public fixture tests pass. These validate the evaluator, not
agent task completion. The real SDK/plugin pairing bundles offline and passes a
local Workerd synthetic-model five-tool sequence with a simulated tool plane,
authentication, duplicate-run refusal, labeled cached receipt and cleanup.

**Measured comparison attempts: 0/150. External model-provider calls: 0.** Native
Linux tools/recovery, real-task provider routing and fault injection remain
unqualified. Model/settings/budget and staging scope remain unresolved. This
authored workload does not close representative-workload G0 or the C0 reuse
decision. No comparative speed, quality, security or cost result is reported.

[Commands, observations, prior failed checks and limits](../docs/evidence/r0-23-preparation-2026-11-14.json);
[protocol and reproduction](comparison/README.md).

## 2026-11-14 — R0-23 task adapter (v2, no inference)

Implemented the general task controller, configured streaming provider adapter
and durable tool/usage journal. Both TypeScript projects and 21 tests pass (112
assertions). The native fixture installer reproduces both frozen Git bases on
the host. The local Workerd smoke exercises the real task plugin and provider
HTTP/SSE parser with five simulated tools and six synthetic model requests;
terminal token observations are retained while monetary cost stays unknown.
It also verifies admission retries/conflicts and cleanup tombstones when native
bindings are absent. The final offline Worker bundle passes Wrangler dry-run.

**Measured comparison attempts remain 0/150; external inference calls remain 0.**
Native tools/recovery and real-provider routing remain unqualified. Fault
controls and shared cost accounting remain open; the new adapter's replay rules
are disclosed separately from upstream behavior. No production dependency or
entrypoint changed.

[Retained v2 manifest](comparison/protocol.freeze.v2.json);
[check receipt and limitations](../docs/evidence/r0-23-task-adapter-2026-11-14.json).

## 2026-11-14 — R0-23 concurrency and cleanup hardening (v3)

Reproduced and repaired failures in admission/observation ordering, uncertain
tool outcomes, process launch/output cancellation, receipt persistence and SDK
teardown. Cleanup retries now observe the same underlying close operation;
container stop proceeds independently of stalled SDK/storage operations and
partial confirmation remains explicit. No coding attempt was scored.

[Scoped audit and reproduction evidence](../docs/evidence/r0-23-hardening-2026-11-14.md);
[v3 manifest](comparison/protocol.freeze.v3.json).


## 2026-11-15 — R0-23 native gate and first live smoke

The third disposable staging scope passed 19/19 native tool checks, then
coordinator recreation with container/workspace continuity, explicit container
loss/fresh restart observation and cleanup. Descendant work continued after
caller abort; progress stopped after a separate kill request, without proving
process-tree termination. Fresh image restart is not portable recovery.

| Arm | Task | Result | Observed wall time |
|---|---|---|---:|
| OpenCodeHarness + Linux | L1 | Failed: unfinished model usage, no tools | 94,444 ms |
| Aboiteau | L1 | Failed: native DO state constructor rejects staging proxy | 1,364 ms |
| Aboiteau | Q1 | Failed: same constructor boundary | 2,249 ms |
| OpenCodeHarness + Linux | Q1 | Failed: unfinished model usage, no tools | 92,555 ms |

**0/4 accepted.** These are integration failures, not measured model coding
accuracy. The common broker admitted zero provider requests. Published-rate
provider estimate is zero for dispatched calls; actual invoice, container and
storage charges were not reconciled. No cost-per-accepted or winner is reported.
Both preceding setup failures and these four cells remain retained.
All three Workers, owned applications and R2 buckets were removed, with the
pre-existing application inventory retained.

[Live receipts](../docs/evidence/r0-23-live-2026-11-15-03.json),
[setup 1](../docs/evidence/r0-23-live-2026-11-15.json),
[setup 2](../docs/evidence/r0-23-live-2026-11-15-02.json),
[v6 manifest](comparison/protocol.freeze.v6.json).

The [v6 source archive](../docs/evidence/r0-23-v6-source-2026-11-15.tar.gz) retains all 31 hashed input files plus the manifest; every file hash was verified against v6 before archiving.


## 2026-11-15 — corrected v8 qualification and provider refusal

Native tools/lifecycle, the actual SDK cross-DO synthetic broker, isolated
L1/Q1 base/reference grader discrimination, and both actual Aboiteau preparation
checks passed. The grader now proves its commands actually execute; known buggy
bases fail and known reference repairs pass.

The first real `opencode/deepseek-v4.1-flash` baseline L1 request received
**HTTP 401**. One v8 cell failed; the other three are unattempted. The provider
gate retained unknown token usage/cost and stopped all further requests. The
non-inference authenticated model catalog independently returned 401 using the
same local credential. No fallback model/provider was used.

The Worker, owned applications and bucket were verified absent; existing
applications remained. All five deployed scopes are cleaned. Across v6/v8, five
failed cells remain retained; there is no accepted coding outcome and no model
effectiveness or cost-per-accepted result. The total provider-spend budget is $5;
actual cost is unknown, not zero.

[Live v8 receipt](../docs/evidence/r0-23-live-2026-11-15-05.json),
[auth diagnosis](../docs/evidence/r0-23-provider-auth-2026-11-15.json),
[integration repairs](../docs/evidence/r0-23-staging-integration-2026-11-15.md),
[v8 manifest](comparison/protocol.freeze.v8.json).

**Credential diagnosis correction:** the rejected v8 key is inactive in the
current CLI. The active, unexpired Chester Hill Solutions OAuth connection
returns HTTP 200 from both authenticated Console configuration and catalog with
its workspace header. The runner read the wrong credential source; user re-login
is unnecessary. The historical v8 refusal remains retained.


## 2026-11-15 — v11 four-cell smoke completed

Both arms passed L1 and Q1: **4/4 accepted**, public regressions and independent
oracles passed, runtime cleanup confirmed. The final run made 27 provider
requests with complete terminal usage and no refusals; its published-rate
estimate is **$0.0542769**, with actual billing/infra/operator costs unreconciled.
The user was already signed in through active OAuth; the earlier 401 tested an
inactive legacy key. That source-selection error is fixed. Native staging shell
authorization was explicitly frozen and product hard denials retained.

[Per-cell times, request counts, costs, limits and cleanup](../docs/evidence/r0-23-smoke-2026-11-15.md);
[raw receipt](../docs/evidence/r0-23-live-2026-11-15-08.json).
The two authored tasks do not establish a winner or close C0/G0. Earlier
failed/blocked cells remain retained, and full-matrix spend is not authorized.
