# Sandbox lighter — cold-start and execution-tier plan

Status: proposed, 2026-11-13.
Scope: make the per-conversation sandbox lighter and faster without giving up the
Linux execution plane. Covers the immediate compute/image fixes and the
`@cloudflare/computer` hybrid spike.

## 1. Decision summary

**Canonical plan.** This is the single plan for sandbox weight, cold start, and the
`@cloudflare/computer` execution-tier decision. The WASM/AgentOS research notes and
the stow integration plan remain reference material; execution sequencing belongs
here.

**Implementation status — 2026-11-13:** Phase 0 instrumentation and the first
Phase 1 slice are in this change: `/start` and `/restore` phase timings, custom
1 vCPU / 2 GiB / 8 GB shape, `IDLE_CLOSE_SECONDS` (production 300 s), and the
Dockerfile prune/slim base. Local image probe:
**739 MB → 514 MB arm64 / 469 MB amd64** (node_modules 416 MB → 214 MB) with the
server booting. Typecheck, 400 unit tests, 338 worker tests and config parity
pass. The Cloudflare A/B, prewarm endpoint, and the Computer spike are next.

**Verification note:** the local amd64 container smoke passed the functional
checks through OpenCode/Stow startup, checkpoints, workspace/state restore and
account-seed isolation, but the final host lifecycle-race observer timed out
under Docker Desktop amd64 emulation and the Docker VM then became read-only.
That is an environment failure, not an assertion failure.

**Gate B closed on native CI — 2026-11-14:** run
[43614603372](https://github.com/chester-hill-solutions/cf-opencode/actions/runs/43614603372)
passed both `check` and `container-smoke` at `7f33cd6` (sandbox slice `f6e20f8`):
the pruned 514 MB arm64 / 469 MB amd64 image boots through OpenCode/Stow startup,
split checkpoint and restore, account-seed isolation and the 600 MB size guard on
a real amd64 runner. This is the native re-run the local failure asked for; it is
still not a Cloudflare measurement. Docker Desktop on this machine needs a
restart/reset before further local amd64 work.

**Stow 0.4.0 pin — 2026-11-14:** the container now downloads the v0.4.0
`linux/amd64` binary and verifies its release checksum; the smoke also pins the
binary SHA-256 `6f0f247912de4c4d5d296a3176fe291b7c29717498f5778d920949d4025420b6`.
The local amd64 smoke built a 470 MB image and passed startup, workspace S3/file
round trips, checkpoint/restore, refusal and account-seed checks. Its final
host lifecycle-race observer timed out in Docker Desktop (`spawnSync docker
ETIMEDOUT`), so it did not qualify the exact revision. Native CI run
[43625818796](https://github.com/chester-hill-solutions/cf-opencode/actions/runs/43625818796)
passed both `check` and `container-smoke` at `37995f2`, including the full
lifecycle-race gate. The local timeout is an emulation limitation, not an
assertion pass or a product failure.

**SL-1.2 Cloudflare shape comparison — 2026-11-14:** the isolated three-profile
cold/warm model-catalogue A/B is recorded in [the receipt](../../bench/cloudflare-instance-shape-2026-11-14.json)
and [bench results](../../bench/RESULTS.md). The no-inference scope means there
is no model-turn/first-token result; the custom 1 vCPU / 2 GiB profile remains
the default pending turn, memory and cost evidence.

| Ticket | Status |
|---|---|
| SL-0.1 `/start` + `/restore` timings | done |
| SL-0.2 cold-path bench output | done (local; Cloudflare run next) |
| SL-1.1 configurable instance profiles | done (`custom-1cpu-2gib` default; custom 3 GiB, `standard-1`, and `standard-2` overrides) |
| SL-1.3 `IDLE_CLOSE_SECONDS` | done (production 300 s) |
| SL-3.4 readiness polling | deferred (not measured; baseline timing restored) |
| SL-2.1 runtime prune | done (739 → 514 MB arm64 / 469 MB amd64) |
| SL-2.2 slim base | done |
| SL-2.3 image-size budget | done (600 MB guard in container smoke) |
| SL-1.2 Cloudflare A/B | partial (cold/warm no-inference A/B recorded; turn measurement remains open) |
| SL-1.4 prewarm | next |
| SL-5.1 Computer workerd spike | next |

1. **Do Phase 1 now.** The measured 6.4 s cold start is mostly OpenCode booting on
   a 0.5 vCPU `standard-1` instance. Move to a custom **1 vCPU / 2 GiB / 8 GB**
   shape, keep the container warm longer, and prewarm on intent. Target cold
   p50 ≤ 3.5 s, p95 ≤ 5 s.
2. **Diet the image.** Prune type files, source maps, docs, `effect/src` and
   non-target binaries; use a slim base. Measured node_modules 416 MB → 235 MB.
   Target image ≤ 550 MB from 739 MB.
3. **Run a bounded `@cloudflare/computer` spike.** Prove the DO-hosted OpenCode
   workerd host + SQLite workspace + `CodemodeBackend`; then `WorkerShellBackend`;
   then `ContainerBackend` with `computerd`. Do not migrate before Gate C/D.
4. **Keep one workspace authority.** Do not run stow and Computer as competing
   writable workspaces. Decide in an ADR before integration.
5. **Do not build the stow POSIX shim, a snapshot fast path, or a WASM rewrite
   now.** They are downstream of the Computer spike or have poor cost/benefit.

## 2. Evidence

### 2.1 Where the 6.4 s goes

Local Docker measurements of the exact runtime image, time to `/api/info`:

| CPU available | Empty workspace | `cf-opencode` repo |
|---|---:|---:|
| 0.25 vCPU (`basic`) | 39.1 s | — |
| 0.5 vCPU (`standard-1`) | 5.9–6.5 s | 7.9 s |
| 1 vCPU (`standard-2`) | 1.9–2.5 s | 3.3 s |
| 2 vCPU | 1.4 s | — |

Deployed lifecycle measurement: cold 6.16–7.39 s, warm 0.14–0.40 s, idle-to-stopped
31.4–32.2 s. The empty-session cold number matches the 0.5 vCPU boot. Image pull and
R2 restore are secondary for agent-scale workspaces; restore is ~0.1 s locally for an
empty session.

### 2.2 Idle policy mismatch

`src/conversation/idle-close.ts` closes after **30 s**. `runtime.applyInactivity`
sets a 10-minute platform timeout, but that is only a backstop. `docs/runbook.md`
currently claims a 10-minute warmth window; that is wrong. Follow-up turns after
30 s therefore pay the full cold start.

### 2.3 Image composition

Built arm64 probe image: **739 MB**.

| Layer | Size |
|---|---:|
| Debian base | ~142 MB |
| Bun | ~92 MB |
| apt toolchain (git, curl, jq, openssl, rg, sqlite3, tar, util-linux) | ~164 MB |
| stow-s3 | ~14 MB |
| OpenCode runtime node_modules | ~416 MB |

Pruning `.d.ts`, `.map`, `.md`, `effect/src` and `effect/ai-docs` reduced
node_modules to **235 MB** while the server still booted. A slim base saves ~42 MB.
The app code itself is ~50 KB; the image is the execution environment, not the app.

### 2.4 `@cloudflare/computer` fit

`@cloudflare/computer@0.11.2` provides:

- a SQLite-backed VFS in the Durable Object (`workspace.fs`, node-shaped and async);
- `workspace.runtime.exec()` with pluggable backends: `CodemodeBackend` /
  `WorkerJavaScriptBackend` (stable), `WorkerShellBackend` (experimental just-bash),
  `ContainerBackend` (experimental `computerd` + FUSE);
- `workspace.git` via isomorphic-git, read-only R2/WorkerBundle mounts, and agent
  tools for AI SDK, Pi and OpenCode.

This is the productized H2 substrate. It can replace the DO-side POSIX shim for the
file layer, but it does not remove the Linux executor for shell/git/native/LSP/PTY.
Known limits: ~10 GB workspace, not full monorepos, container-side filesystem held in
memory, FUSE slow for heavy I/O, `MOUNT_IGNORE` needed for `node_modules`.

## 3. Goals and non-goals

### Goals

| Metric | Current | Target |
|---|---:|---:|
| Cold first-token, empty workspace, p50 | ~6.4 s | ≤ 3.5 s |
| Cold first-token, p95 | ~7.4 s | ≤ 5 s |
| Follow-up within 5 min | cold start | no cold start |
| Image size | 739 MB | ≤ 550 MB, then ≤ 450 MB |
| Warm follow-up | ~0.2 s | no regression |
| Container starts per file-only turn | 1 | 0 (Computer tiers 1–2) |
| Cost per active hour | baseline | no increase |

### Non-goals

- No WASM/AgentOS rewrite.
- No snapshot fast path as the primary recovery mechanism.
- No dual writable workspaces (stow and Computer).
- No arbitrary Dockerfiles or per-tenant images.
- No change to accounting, permissions or Slack behaviour.

## 4. Target architecture

### 4.1 Current

```
DO → control server :4001 → OpenCode server :4000 → stow/R2 workspace
                   root                 agent
```

### 4.2 Phase 1 (immediate)

```
DO → control server :4001 → OpenCode server :4000 → stow/R2 workspace
                   root                 agent
        1 vCPU / 2 GiB, warm longer, prewarmed, pruned image
```

### 4.3 Phase 3 target, if the Computer spike passes

```
Conversation DO
  ├─ OpenCode workerd host                 agent loop, model calls, events
  ├─ @cloudflare/computer Workspace        SQLite VFS + tools + git
  │    ├─ fs / grep / git                  no container
  │    ├─ Codemode / WorkerJS              no container
  │    ├─ WorkerShell (just-bash)          no container, limited shell
  │    └─ ContainerBackend → computerd     full Linux, on demand
  └─ conversation state / usage / jobs
```

Tier routing:

| Tier | Runtime | Tools | Container? |
|---|---|---|---|
| 0 | DO only | text, remote MCP | no |
| 1 | DO + Computer VFS | read, write, edit, glob, grep, git | no |
| 2 | DO + Dynamic Worker | JS/WASM transforms, JS tests, just-bash | no |
| 3 | DO + `computerd` container | shell, native builds, LSP, PTY, stdio MCP | yes, on demand |

## 5. Workstreams and tickets

### WS0 — Instrumentation and baseline

| ID | Ticket | Acceptance | Size |
|---|---|---|---|
| SL-0.1 | Add `timings` to `/start` and `/restore`: containerStart, restoreWorkspace, restoreState, stowReady, opencodeReady, configProof. Log them in `container.ready`. | Unit tests; no secrets; response schema documented. | S |
| SL-0.2 | Add cold-path breakdown to `bench/container.sh` and a Cloudflare 3-sample run. Record p50/p95. | `bench/RESULTS.md` entry with raw commands. | S |
| SL-0.3 | Emit `container.instance`, `container.image_bytes`, `container.start_mode`, `container.restore_ms` in telemetry. | OTel attributes visible; no high-cardinality labels. | S |

### WS1 — Compute shape and lifecycle

| ID | Ticket | Acceptance | Size |
|---|---|---|---|
| SL-1.1 | Change `src/conversation/images.ts` from `standard-1` to custom `{ vcpu: 1, memoryMib: 2048, diskMb: 8192 }`; allow env/settings override. | Typecheck; unit test for start options; docs updated. | S |
| SL-1.2 | A/B `standard-1` vs custom 1 vCPU/2 GiB vs `standard-2` on Cloudflare, 3 samples each. | Cold/warm/turn table; choose default. | M |
| SL-1.3 | Make `IDLE_CLOSE_MS` configurable; default 5 min for the trusted operator. Add capacity-aware LRU close when a lease is refused. | Tests for timing, active-work guard, lease-pressure close; runbook corrected. | M |
| SL-1.4 | Add `POST /api/conversations/:key/prewarm`: take a lease, prepare runtime, no model call, idempotent. Hook the UI/SSE-open path optionally. | No provider spend; capacity respected; tests. | M |
| SL-1.5 | Memory guard: measure RSS on a representative repo; choose 2 GiB vs 3 GiB; add OOM alert. | Report; fallback config. | S |

### WS2 — Image diet

| ID | Ticket | Acceptance | Size |
|---|---|---|---|
| SL-2.1 | Add a prune step: remove `**/*.d.ts`, `**/*.map`, `**/*.md`, `effect/src`, `effect/ai-docs`, musl/non-target binaries. | `scripts/smoke-container.sh`; provider onboarding tests; image size recorded. | M |
| SL-2.2 | Move to `oven/bun:1.3-slim` (pin digest) or a multi-stage build; keep git/curl/rg/sqlite3/tar/setpriv. | Smoke passes; digest pinned; size recorded. | S |
| SL-2.3 | CI image-size budget: fail if the image exceeds the agreed ceiling. | CI job; documented budget. | S |
| SL-2.4 | Optional: `bun build --compile` experiment; not a default until it runs. | Spike report only. | M |

### WS3 — Boot-work reduction

| ID | Ticket | Acceptance | Size |
|---|---|---|---|
| SL-3.1 | Defer model-catalogue fetch: `models.fetch: false` or `OPENCODE_DISABLE_MODELS_FETCH=1`; serve a cached catalogue. | `/api/models` works; onboarding works; startup measured. | S |
| SL-3.2 | Measure pre-migrated SQLite DB vs running 59 migrations at boot. Keep only if measured. | Before/after at 1 vCPU. | S |
| SL-3.3 | Measure `OPENCODE_FILEWATCHER_DISABLE=1` + `OPENCODE_DISABLE_FFF=1` on a real repo. Keep only if measured. | Before/after; no tool regression. | S |
| SL-3.4 | Reduce readiness polls: 200 ms → 50 ms for OpenCode, 100 ms → 50 ms for stow, bounded. | Tests; measured savings. | S |
| SL-3.5 | Bun version / transpiler-cache experiment. | Report; no default change without evidence. | S |

### WS4 — Restore and checkpoint path

| ID | Ticket | Acceptance | Size |
|---|---|---|---|
| SL-4.1 | Single-pass tar validation: parse names and hard links from one `tar tvzf`; keep absolute/`..`/link rejection. | Security tests; restore time. | M |
| SL-4.2 | Parallel workspace/state restore via a combined endpoint or concurrent parts; preserve marker ordering. | Mixed-failure tests; no half-restore marker. | M |
| SL-4.3 | Evaluate zstd or `gzip -1` for checkpoint/restore; measure size vs time; keep compatibility. | Bench table; archive policy updated if adopted. | M |
| SL-4.4 | SQLite maintenance before state backup: `PRAGMA optimize`, `wal_checkpoint(TRUNCATE)`. | State size/time measured; no corruption. | S |

### WS5 — `@cloudflare/computer` spike (H2)

| ID | Ticket | Acceptance | Size |
|---|---|---|---|
| SL-5.1 | Workerd host spike: OpenCode workerd profile in a test DO + Computer `Workspace` + `CodemodeBackend`; fake provider, no tools yet. | Bundle size, DO boot, prompt, file ops, event persistence, memory. No production change. | M |
| SL-5.2 | Tool bridge: plugin removes local tools; add workspace-backed read/write/edit/glob/grep and `runtime.exec` shell against a fake executor. | Tool routing, cancellation, error surfacing, no credential leak. | M |
| SL-5.3 | `ContainerBackend` spike: `computerd` image (Debian trixie-slim + fuse3), `MOUNT_IGNORE=node_modules`, custom 1 vCPU/2 GiB. | Representative repo: install, test, git, no data loss; FUSE latency measured. | L |
| SL-5.4 | Compatibility: pin OpenCode/Computer/Agents versions; test workerd condition, events, permissions, accounting. | Compatibility matrix; known gaps. | M |
| SL-5.5 | H2 Go/No-Go ADR. | Decision with evidence; integration tickets if go. | S |

### WS6 — Workspace authority

| ID | Ticket | Acceptance | Size |
|---|---|---|---|
| SL-6.1 | ADR: Computer VFS vs stow/R2 authority; single writer; revision/lease; cold backup; read-only mounts. | One authoritative writer; recovery story; stow role defined. | M |
| SL-6.2 | If Computer is authoritative: export/import to R2; retention, encryption, tenant isolation. | Restore drill; encryption verified. | L |
| SL-6.3 | If stow is authoritative: design push/pull sync and conflict handling; do not build before the spike. | Design only. | M |

### WS7 — Docs, rollout, operations

| ID | Ticket | Acceptance | Size |
|---|---|---|---|
| SL-7.1 | Fix runbook: 30 s vs 10 min, instance shape, image size, prewarm, cost. | Docs match code. | S |
| SL-7.2 | Record baseline and A/B in `bench/RESULTS.md`. | Reproducible commands. | S |
| SL-7.3 | Canary image + feature flag for instance shape; rollback proven. | Staging rollback drill. | M |
| SL-7.4 | Cost dashboard: per cold start, per active hour, per turn. | Numbers visible. | M |

## 6. Phases and sequencing

### Phase 0 — Baseline (2–3 days)

SL-0.1, SL-0.2, SL-0.3. No behaviour change. Output: a cold-path breakdown from
Cloudflare, not just local Docker.

### Phase 1 — Cheap, reversible wins (1–2 weeks)

SL-1.1, SL-1.2, SL-1.3, SL-1.4, SL-2.1, SL-2.2, SL-3.1, SL-7.1, SL-7.2.

Exit Gate A/B. Expected: cold p50 3–4 s, follow-ups warm, image ≤550 MB.

### Phase 2 — Restore and Computer spike (2–4 weeks)

SL-4.1–SL-4.4 in parallel with SL-5.1–SL-5.2.

Exit Gate C. Decide whether to continue H2.

### Phase 3 — H2 integration, only if Gate C passes (4–8 weeks)

SL-5.3–SL-5.5, SL-6.1–SL-6.3, SL-7.3–SL-7.4.

Exit Gate D/E. Tier 1/2 becomes the default for file/JS turns; Tier 3 is the
on-demand executor. Keep the current container path as fallback until the
ContainerBackend is proven.

## 7. Acceptance gates

### Gate A — Phase 1 cold path

- Cold first-token empty workspace p50 ≤ 3.5 s, p95 ≤ 5 s on Cloudflare.
- Follow-up within 5 min does not cold-start.
- Warm follow-up ≤ 300 ms.
- No increase in cost per active hour; measured.
- Full typecheck, unit, worker and container smoke pass.

### Gate B — Image

- Image ≤ 550 MB (then ≤ 450 MB after the second pass).
- `scripts/smoke-container.sh` passes.
- Provider onboarding, permissions, stow and checkpoint paths pass.
- No missing runtime files after prune.

### Gate C — Computer workerd spike

- OpenCode workerd host boots in the DO and accepts a prompt with a fake provider.
- Bundle fits the Worker limit; DO CPU/memory within budget.
- File read/write/edit/grep p50 measured; event replay works.
- No provider credential or control token leaked into the workspace/tools.
- A clear report of gaps versus the current container path.

### Gate D — ContainerBackend

- Representative repo tasks pass: read/edit, git, install, test, shell.
- `MOUNT_IGNORE=node_modules` keeps installs off the sync path.
- No data loss or divergence after a turn; restore drill passes.
- FUSE latency is acceptable for the product’s repo-size envelope.
- Executor image ≤ 400 MB; cold start measured.
- Experimental-backend risk explicitly accepted or fallback retained.

### Gate E — Production

- Canary conversation on the new shape/image; rollback proven.
- Accounting, permissions, Slack, SSE, checkpoint and recovery unchanged.
- Cost per accepted task measured.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| 2 GiB OOM with LSP/plugins | Measure RSS; fall back to 3 GiB; add alert. |
| Longer warmth starves capacity | Capacity-aware LRU close; keep `maxContainers` explicit. |
| Prune breaks a dynamic import | Smoke + provider onboarding + a start with each backend; keep a revert layer. |
| `ContainerBackend` is experimental | Keep the current container fallback; do not default until Gate D. |
| Computer VFS vs stow divergence | Single-writer ADR; revision/lease; no dual authority. |
| 10 GB / FUSE limits for large repos | Define supported repo size; `MOUNT_IGNORE`; keep Tier 3 for large trees. |
| OpenCode/Computer version mismatch | Pin; compatibility spike; no mixed-version production. |
| Credential expansion in the DO | Keep credentials in the DO/gateway; executor gets scoped capabilities only. |
| Cost increase | Custom instance is cheaper on memory/disk; CPU work is the same; measure per task. |
| Image-size CI flakiness | Budget with a margin; record history. |

## 9. Cost model

- `standard-1`: 4 GiB provisioned, 0.5 vCPU, 8 GB disk.
- Custom 1 vCPU / 2 GiB / 8 GB: half the memory, same disk, same CPU work done
  faster. Memory is provisioned; CPU is active usage.
- Idle warmth at 2 GiB: `2 × 3600 × $0.0000025 = $0.018/hour`, about `$0.43/day`
  per always-warm container. The 30 s policy saves cents and costs seconds.
- Recheck with the live invoice after the A/B; do not rely on list-price math alone.

## 10. Immediate next actions

1. Land SL-0.1 and SL-0.2; run the Cloudflare 3-sample cold path.
2. Land SL-1.1 behind an env/settings override; run the A/B.
3. Decide the idle window (5 min default for the trusted operator) and land SL-1.4.
4. Land SL-2.1 + SL-2.2; run the container smoke and record the size.
5. Schedule the SL-5.1 workerd + Computer spike after the baseline is recorded.

## 11. What we are not doing

- Not building a stow POSIX shim before the Computer spike.
- Not using Cloudflare snapshots as the primary recovery path.
- Not running two OpenCode servers or two writable workspaces.
- Not rewriting the execution plane in WASM.
- Not changing accounting, permissions or Slack semantics in this plan.

## 12. Open decisions

1. 2 GiB vs 3 GiB for the default shape.
2. Idle window: 5 vs 10 minutes; capacity-aware close now or later.
3. Computer VFS vs stow/R2 as the authoritative workspace.
4. Whether the product supports full monorepos (if yes, keep Tier 3 container-local
   disk; Computer VFS may not fit).
5. Provider credentials: DO-held vs gateway-scoped.
</content>
