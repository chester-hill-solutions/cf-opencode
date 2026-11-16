# Isolated #arfin-test release packet

Prepared against deployed Worker annotation baseline `15a916aabc5fa78211802bb584b612abd225b85e`. Canonical sequencing and live decisions belong to the parent/roadmap. This packet does not close broad G0/G1 gates.

## Frozen legacy router

The exact-baseline checkout is `/private/tmp/aboiteau-slack-router-20261115`. It has its **own** dependencies installed with `bun install --frozen-lockfile --ignore-scripts`; package.json and bun.lock remain unchanged. `legacy-router.patch` includes the complete new helper, three small existing-file changes and both test suites. `router.ts` is the same helper retained here for direct focused tests. Apply the patch only to the exact baseline, never to current main as a replacement for legacy DO code.

The live Worker keeps the real Slack signing key. After real Slack HMAC succeeds, only channel `C0A5YNXLP6C` consults a service-bound canary ownership probe. The raw body is delegated under a **new** HMAC key, which is the canary's ordinary `SLACK_SIGNING_SECRET`. The production signing key is never extracted or forwarded. Both probe and actual dispatch use the canary's public origin and the service binding; no public HTTP fallback exists.

The exact response is `{route:'canary'|'legacy',channel,threadTs}`. Positive routes must match the original channel/root timestamp. Proof/transport/deadline errors return 503 without legacy fallback. Valid unowned threads retain legacy dispatch. Interactive ephemeral responses are retained within an 8 KiB bound. Each service operation has a 1200 ms deadline. Workers-compatible `redirect:'manual'` plus strict status checks refuses redirects; `redirect:'error'` is unsupported in workerd and was caught by the real Worker tests.

Verification completed locally: seven Bun helper tests / 83 assertions; four isolated workerd tests exercising real HMAC-before-probe ordering, no legacy namespace access on owned target traffic, and preserved dispatch for unowned/other-channel traffic; legacy source/Bun/Worker typechecks; both legacy and canary Wrangler `deploy --dry-run --containers-rollout=none`. No deployment was executed by this child. Parent owns the actual release and its receipts.

## Canary configuration and image identity

`canary-wrangler.template.jsonc` keeps separate Conversation/Settings namespaces, a separate bucket, no TENANCY binding, no cron, a separate rate-limit namespace and encrypted archives. The concrete private config is `.wrangler/slack-canary-release/canary.wrangler.jsonc`; its collector UUID comes from the operator's private metadata. It starts with `SLACK_CANARY_NEW_THREADS=false` and `SLACK_CANARY_START_TS=''`.

The agent registry manifest is:

`registry.cloudflare.com/ad5ec479b9a421faa2ed06c3d1c2b23a/aboiteau-checks-agent@sha256:0aab4cba01bd119499e60dc37525eb9e789f7e62efcf939b062eac29b9b1b9d1`

The mapped local agent image is `sha256:a07c2d2d632e36a33c3edfb95e74bf0d43978515b8ca656f436ad18b213a38ab`. The parent independently checked all 18 Dockerfile COPY controller/runtime files against the image with zero mismatches. Keep the image's Dockerfile/Stow provenance with the parent receipt; this registry manifest and local image ID are different identifiers, not interchangeable pins. Both canary image variants use that new image, while the legacy router retains both existing production image pins.

The offline checker remains local native arm64 image `sha256:416095926dcfb1c8e255691117c3c5504579e875bbb58fc3657fc2469076c516`, with `CHECK_RUNNER_PLATFORM=linux/arm64`, 20-second configured command limit and the existing fixed 512 MiB offline profile. Prior amd64/QEMU OOM receipts remain limitations, not replaced evidence.

## Enable and drain without forking old threads

1. Deploy/verify the isolated canary while new-thread admission is false. Verify exact registry image, own bucket/namespaces, API authentication and collector authentication. Run the parent-coordinated model-free readiness/cold checkpoint/restore checks on this exact pair, retaining encrypted-manifest, stop and recovery receipts. Do not claim an old frozen qualification artifact covers it.
2. Reuse only the owner's existing local **opencode** API key through the existing onboarding `/integrations/<catalogue-selected-id>/connect/key` endpoint when authorized. Read only that entry in memory, send over authenticated HTTPS, and print no key/body. Catalogue checks can confirm `opencode/deepseek-v4.1-flash` without inference. Do not copy `account/state.tar.gz`, provider history, other auth entries or old accounting state. The parent's isolated onboarding finish may create a new canary-only encrypted seed.
3. Add the same new delegation key to the legacy Worker as `SLACK_CANARY_SIGNING_SECRET` using the parent's approved private secret path. Deploy the reviewed exact-baseline router Worker-only with `--containers-rollout=none`; retain existing legacy DO/image/R2 bindings and pins. Keep the existing Slack callback URLs unchanged. Verify other channels and existing `#arfin-test` threads remain legacy.
4. Choose **one future fixed Slack event timestamp cutoff** after the router is deployed. Configure that immutable `SLACK_CANARY_START_TS` and set `SLACK_CANARY_NEW_THREADS=true` in the canary. Root mentions older than cutoff, replies without a marker and old buttons remain legacy; only eligible new root mentions at/after cutoff create ownership. Do not change the cutoff after tasks exist.
5. Run authorized live verification only in `#arfin-test`, using a new root thread after cutoff. The owning marker remains durable; later replies/buttons route to the same canary even during drain. Check queue/completion and fresh/stale evidence with the separate host collector, then retain the server's Slack delivery receipts.
6. Drain by setting `SLACK_CANARY_NEW_THREADS=false` **without removing the service binding or changing the cutoff**. Existing owned threads must keep their canary backend. Stop new collector claims only after the current bounded attempt finishes; reconcile any uncertain owned containers before deleting resources. Removing forwarding while owned threads exist would silently fork them into legacy and is not an acceptable rollback.

## Frozen host collector startup — approved and installed

Generated private artifacts live in `.wrangler/slack-canary-release/` (0700):

- `release-manifest.json`: baseline/source/config/patch and frozen bundle hashes.
- `collector-runner-<SHA256>.js`: immutable Bun bundle, mode 0444, SHA-256 in its filename and manifest.
- `collector-start.js`: immutable host launcher. It verifies the bundle SHA-256, selects only `CHECK_COLLECTOR_TOKEN` from the parent's existing private secret file, and invokes the fixed origin/collector/image/state arguments. No value is in argv, the journal or console output. The Docker collector forwards no API/Slack/collector/model secrets into Linux.
- `ca.chesterhill.aboiteau-arfin-check-runner.plist`: reviewable optional launchd configuration, subsequently installed and loaded by the parent after explicit user approval. The parent prepared `RunAtLoad=true`, `KeepAlive=false` and an explicit Docker PATH, obtained explicit user approval, installed and started the service, and verified a separate automatic check. Errors require operator attention. ExitTimeOut is conservatively 900 seconds for bounded pagination plus collection; SIGINT/SIGTERM finish the current operation before exit, while SIGKILL remains an explicit unresolved-state recovery case.

First run, after parent coordination:

```sh
bun --no-env-file --no-install .wrangler/slack-canary-release/collector-start.js --once
```

Omit `--once` for serial polling. The directory `.wrangler/slack-canary-release/collector-state` retains one private host lock and active journal. `--reconcile` is explicit observation only: prove no container with the immutable request label exists and submit a fenced cleanup observation. It does not stop containers, rerun commands or upgrade the original result. Missing journals, crash-left locks, unavailable Docker or extant containers require operator reconciliation. Never delete evidence to obtain another execution.

Runner verification: thirteen tests / 213 assertions, including a global owner acquired before actor claim, lost claim/completion acknowledgements, paged missing-journal blocking, unchanged completion/log digest, source freshness, fake-success/nonzero exits and cleanup-only reconciliation. The combined runner/router Bun invocation passed 20 tests / 296 assertions. Generated startup source was prepared without starting the runner, installing launchd, writing a new secret, issuing a model call or posting Slack messages.
