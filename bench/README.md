# Measurements

Two harnesses: one against a **deployed** Worker, one against the **container**.

## Worker + SSE (`bench/measure.ts`)

```sh
HARNESS_URL=https://cf-opencode.<account>.workers.dev \
API_TOKEN=… \
bun run bench/measure.ts bench
```

Measures:

- `/health` latency (p50/p95/min/max over 50 requests) — Worker + DO routing overhead
- SSE connect (time to the `: connected` frame)
- a full turn: message → first `assistant` event → `settled`

The turn numbers include model latency and any container cold start. The
overhead metrics are the harness's own cost.

## Container (`bench/container.sh`)

```sh
bench/container.sh                # Apple container
RUNTIME=docker bench/container.sh # Docker-compatible engine
```

Measures:

- cold start: container launch → control `/health`
- start: `stow-s3` + `opencode serve` ready
- local S3 health
- checkpoint: time and size of the R2-bound tar.gz
- restore: time to extract a checkpoint back into the workspace

## Targets

| Metric | Target | Notes |
| --- | --- | --- |
| `/health` p50 | < 10 ms | Worker + DO, no container |
| `/health` p95 | < 25 ms | |
| SSE connect p50 | < 100 ms | |
| settled overhead over last assistant token | < 2.5 s | polling pump; < 250 ms once the warm stream lands |
| cold start (container → control /health) | < 10 s | lite instance |
| start (stow-s3 + opencode) | < 5 s | |
| checkpoint size | < 50 MB | deps excluded, `.git` + state included |
| checkpoint time | < 2 s | |
| restore time | < 3 s | |

## Recording results

Append a dated block to `bench/RESULTS.md`:

```
## 2026-11-06 — local / Workers Builds

| metric | value |
| --- | --- |
| /health p50 | … |
| /health p95 | … |
| SSE connect p50 | … |
| first assistant | … |
| settled | … |
| cold start | … |
| checkpoint | … MB / … ms |
| restore | … ms |
```
