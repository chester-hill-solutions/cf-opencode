# Slack check runner and isolated canary readiness — 2026-11-15

Scope: operator runner implementation plus read-only production discovery. No deployment, secret write, service installation, Slack message or model call was performed for this increment. The roadmap owns gate status.

## Observed production state

Wrangler **4.158.0** read-only `deployments list --json`, `versions view 4f0b2def-d7db-4e55-98bf-04e733d73c5d --json`, `secret list` and `containers list --json` succeeded on November 15.

- Active latest deployment: `08b5d928-79d4-438a-a94a-d8dc393edc6f`; Worker version `4f0b2def-d7db-4e55-98bf-04e733d73c5d`, created November 12 at 04:30:14 UTC. Its annotation is `Slack image handling and safe conversation recovery (15a916a)`. This identifies a candidate source baseline; it does not itself prove byte-for-byte bundle reproducibility.
- Production registry images remain base `sha256:1401c9174256edd59bed01711f3464f5aec8b517b84f81a63f360795d2c5ce35` and evented `sha256:826337168d6d3820181d39c69764787da6e934217889370c0a91399adc5da431`. These predate workspace binding, preflight, committed-source export and collector completion.
- Production Conversation namespace/application is `f97c74c307e64504b6debe87c94e5592`; Settings namespace is `ab9c207bcfc8441587506b98885429cd`; R2 bucket is `cf-opencode-checkpoints`. The application inventory reported zero running instances at observation time. Retained DO/R2 data and accounting holds remain independent of that count.
- Secret **names only** confirmed existing API, GitHub OAuth, Slack signing/bot identity and vault configuration. `CHECK_COLLECTOR_TOKEN` was absent. No values were displayed. Existing Slack event and interactivity URLs both target `cf-opencode.chester-hill-solutions.workers.dev` (runbook).

## Runner implementation

`scripts/workspace-check-runner.ts` reuses the owned offline Docker collector and shared graph/dispatch validators. It has one private host lock and one active claim journal, synced before its first claim request. Queue pagination is bounded; a server-owned claim with a missing local journal prevents another execution. Configured service origin, collector ID, image ID and claim identity remain fixed across restarts. The server separately owns global single-collector fencing.

The host alone receives `CHECK_COLLECTOR_TOKEN`. Requests use TLS, or explicit loopback HTTP for tests, with redirects refused and bounded response consumption. API, Slack and model credentials are not required by the runner. Docker retains its fixed UID 65532, no-network/read-only-root profile, local pinned image ID, CPU/memory/PID/output/time bounds and no secret environment, host mounts or Docker socket inside the checker.

A lost claim acknowledgement retries the same durable conversation/claim ID. After restart, an unresolved attempt is only observed; it is never restarted. A saved receipt can be uploaded again with the exact captured stdout/stderr bytes. The client verifies the completion acknowledgement's attempt tuple, receipt and canonical completion SHA-256. Raw repository output never determines success or appears in its console summary. The server validates log hashes and owns Slack notification delivery.

`--reconcile` is an explicit cleanup-only action. It verifies that Docker reports **no container carrying the exact immutable request label**, then submits a fenced observation. It never removes containers, starts code or changes the original outcome. Docker unavailable, a remaining container or an uncertain query stays blocked. Reconciliation can recover a missing host journal from the server's frozen claim. `cleanup_unknown` evidence remains `cleanup_unknown` after ownership is released.

SIGINT/SIGTERM stop further polling and allow the bounded current collection to finish. SIGKILL/host loss can leave a container and a crash-left `runner.lock`; first observe the recorded attempt and reconcile actual owned resources. Never delete a lock while another runner remains active, or delete evidence to make a check run again.

## Reviewable operator startup

Use a separate persistent **0700** state directory, for example `.wrangler/check-runner/arfin-canary` (already ignored by Git), and a fixed collector UUID configured identically in the service. Inject the separate collector token through the host process environment from an operator-managed secret; never put it in argv, the journal, Slack or the checker environment.

After parent-coordinated local/deployment qualification, a single foreground pass is:

```sh
bun --no-env-file --no-install scripts/workspace-check-runner.ts --once \
  --url https://<isolated-canary>.workers.dev \
  --state .wrangler/check-runner/arfin-canary \
  --collector-id <configured-UUID> \
  --image sha256:<qualified-local-checker-ID>
```

Omit `--once` for serial five-second polling. Use the same arguments with `--reconcile` for the explicit absence-only reconciliation path. Exit 0 means polling/acknowledgement succeeded, **not that tests passed**; the JSON outcome is the recorded test result. Exit 3 means busy/blocked/uncertain; exit 1 means invalid configuration. No launchd/systemd installation has been performed. Production supervision should retain this directory, avoid forced termination of an in-flight collection and surface nonzero exit for operator attention.

Server configuration must provide `CHECK_COLLECTOR_ID`, `CHECK_RUNNER_IMAGE_ID`, `CHECK_RUNNER_TIMEOUT_MS`, `CHECK_SLACK_CHANNEL_ID` and a separate `CHECK_COLLECTOR_TOKEN` secret. The image must exactly match the operator's local qualified image; a Slack caller cannot select arbitrary images or commands beyond the server-approved check request.

## Isolated Slack canary release proposal

1. Keep the live Slack callbacks and app identity. Prepare a minimal routing patch against the annotation's `15a916a` baseline, retaining its existing dependencies, DO code, registry pins, bindings and settings behavior. Compare release provenance before deployment. Do not substitute current main for that legacy Worker.
2. Provision a uniquely named canary Worker with independent Conversation/Settings namespaces, empty R2 bucket, fresh API/vault/collector secrets and a newly pinned agent image. Do not import production checkpoints, account seeds, provider credentials or accounting state. Keep the actual Slack signing secret in the legacy Worker. Configure a fresh delegation key as the canary signing secret and reuse only the verified bot identity through approved private transfer; secret-list output cannot recover values. An exact canary channel allowlist must also apply inside the canary Worker.
3. After valid Slack HMAC, the legacy patch extracts only the event channel or interaction channel. For the exact verified `#arfin-test` channel ID, re-sign the **unchanged body** with the fresh delegation key and forward it to the canary via a Worker service binding, before touching the legacy registry/DO. All other channels follow the existing dispatch unchanged. Canary validates the delegated HMAC and exact channel allowlist, then its durable ownership marker; existing threads remain on their original backend. The final cutoff/enable/drain procedure is in `scripts/slack-canary-release/README.md`. Keep URL verification on the existing callback; acknowledge events promptly, with bounded asynchronous forwarding and existing event-ID deduplication.
4. Local router tests must prove signature rejection, exact-channel routing for events/buttons, no target-channel writes to legacy namespaces and no forwarding of other channels. The isolated image still needs its real Cloudflare/native storage qualification; local Docker evidence does not satisfy that gate. Run model-free canary preflight, public repo binding, committed source and checker completion first. Post only the separately authorized verification messages in `#arfin-test` after parent coordination.
5. Rollback removes/disables the channel forwarding. Stop new runner claims; preserve or reconcile any in-flight attempt before cleaning the canary's own resources. Do not recycle/reset/migrate existing production conversations or clear old holds.

No new Slack app or callback replacement is necessary for this route. A service binding and legacy Worker-only deployment are real release changes and remain unperformed.

## Qualification limits and next gates

The previous actual local agent-control/CLI/checker six-case pipeline passed pass/nonzero/fake-success/timeout/flood/stale-after, with confirmed cleanup and bounded logs. Agent image `a07c2d2d632e36a33c3edfb95e74bf0d43978515b8ca656f436ad18b213a38ab` ran as amd64 under emulation; checker image `416095926dcfb1c8e255691117c3c5504579e875bbb58fc3657fc2469076c516` ran natively as arm64 at 512 MiB. The amd64 checker under QEMU hit OOM twice at that same limit; this is retained as a profile limitation. A production checker host/image architecture requires its own qualification; the native arm64 host is an available bounded canary option. The source agent also needs a new image when current Slack/server changes affect its packaged controller.

Current runner focused verification: thirteen tests, 213 assertions passed, covering durable claim ordering, lost acknowledgements, restart refusal, source corruption, stale/unknown freshness, fake success/nonzero exit, host lock/image/origin/identity/symlink rejection, log tampering, paginated owned claims and cleanup reconciliation, including a global owner acquired before its actor claim. These tests use real private host files and fake Docker authority, not live credentials or remote execution. The parent owns the integrated gate and live canary decision.

Primary operational references: [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/), [versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/), [Worker service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/), [Cloudflare container Wrangler commands](https://developers.cloudflare.com/containers/reference/wrangler-commands/).
