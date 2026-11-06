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

Run the remaining measurements with:

```sh
bench/container.sh
HARNESS_URL=… API_TOKEN=… bun run bench
```
