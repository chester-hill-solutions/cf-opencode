# Results

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
