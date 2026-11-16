# Committed check evidence — 2026-11-15

**Result: implemented and verified locally; not deployed.** This R2-9.2 increment implements service-owned
check intent/source export and operator-local execution evidence. The service
does not execute checks or accept uploaded completion claims. It remains
`checksNotRun: true` even after an external operator executes a command.

## Boundaries implemented

The existing operator API records a strict immutable request: request ID,
expected binding ID, full commit object ID, explicit argv, checker image ID and
timeout. New exports require an already warm, verified, idle workspace and use
a passive runtime borrow. They do not prepare a runtime, apply settings, capture
a checkpoint or renew idle time. Intent precedes source export. Matching retries reuse it; conflicting
payloads are refused. Admission, usage and runtime fences prevent overlap with
active work or guarded reset. The export is encrypted with the existing Vault
archive key and retained under the workspace's existing artifact prefix.

The native reader obtains raw commit/tree/blob objects as the agent user,
without network, status/diff, filters, text conversion or export attributes.
The trusted parent independently verifies Git hashes and the reachable tree.
The deterministic snapshot contains every supported committed file; it excludes
uncommitted bytes, `.git`, Stow metadata and service state. Unsafe paths, links,
gitlinks, excess objects/files/depth and raw or expanded-byte excess are refused.

An owned checker image contains Bun and a trusted bootstrap. The operator pins
its local immutable image ID. A replaceable Docker adapter uses nonroot
execution, a read-only image, private bounded writable scratch, no network,
ports, host mounts, Docker socket, service environment or added capabilities.
Only verified source and the authorized argv enter the checker.

The outside collector retains API credentials, a durable journal, bounded logs
and a local receipt. It records Docker's observed exit/OOM state, timeout and
confirmed cleanup; repository-produced JSON is never a pass oracle. Collector
ownership is unique per attempt. An existing output directory never triggers
another execution, and observation never retries an uncertain command.

## Verification

The final sequential gate passed **557 unit/qualification tests plus five
OpenCode runtime tests (562 Bun total)** and **409 Worker tests across 66 files**.
Full TypeScript checks, configuration validation, UI build and
`git diff --check` passed. The [JSON receipt](workspace-checks-2026-11-15.json)
records source/test hashes, check durations, log hashes and retained failures.

The final six-case Linux smoke passed using these exact images:

| Role | Platform and image | Bytes |
|---|---|---:|
| Real source-export control server | Linux amd64 under emulation, `sha256:a07c2d2d632e36a33c3edfb95e74bf0d43978515b8ca656f436ad18b213a38ab` | 493,070,095 |
| Owned offline checker | Native Linux arm64, `sha256:416095926dcfb1c8e255691117c3c5504579e875bbb58fc3657fc2469076c516` | 192,324,884 |

The smoke exercised real control-server Git export/head endpoints and real
reference CLI/checker execution. Its public API was a synthetic authenticated
loopback fixture; production Worker orchestration, encryption and the final
warm-only guard were separately exercised by Worker tests. This is not a
deployed end-to-end service receipt. The warm-only correction changed no image
contents or collector code after this image run.

| Case | Observed result |
|---|---|
| Normal check | Command exit 0; local pass; before/after HEAD matched. |
| Nonzero command | Exit 7; failed. |
| Fake success JSON | Exit 7; failed despite stdout claiming success. |
| Hanging command | Start marker observed; timeout; cleanup confirmed. |
| Output flood | Collector error; captured log bounded to 64 KiB and marked truncated. |
| HEAD advances after execution | Command passed on its input; after-HEAD stale; CLI returned nonzero. |

Every case confirmed cleanup. All ordinary before/after HEAD observations
matched. The passing fixture asserted UID 65532, absence of service tokens,
Docker sockets, `.git` and `.stow`, failed writes to the read-only image and
loopback-only networking. Export attributes left committed bytes unchanged,
uncommitted files/changes were excluded, and source runtime status was unchanged.
Twelve real metadata reads took **2,526–4,860 ms** on the emulated source image
after consolidation, within the unchanged ten-second caller deadline. These
samples do not qualify production latency or capacity.

Raw final log: `/tmp/aboiteau-workspace-check-final-smoke.log`; summary under
`/var/folders/f3/n5tk3w792px0vctvqjytc6t00000gn/T/aboiteau-check-smoke-OwBcjT`.
The JSON receipt retains summary/case data and HTTP-observation hashes. All
owned containers were removed. Existing `deploy-studio-1` retained its identity
and start time; its local HTTP endpoint returned 200. Unrelated containers and
volumes were preserved.

### Runtime findings retained

The initial amd64 checker hit the unchanged **512 MiB** cap twice under emulation
on the aarch64 Docker host: Docker reported OOM and exit 137, with no command-start
marker observed. The collector recorded OOM and confirmed cleanup each time.
The same Dockerfile/input workload/profile built natively for arm64 then passed
normal execution, fake-success output with exit 7, and a started command's
timeout. No isolation limit was raised. This supports an architecture/emulation
startup-memory limitation; it does not qualify native amd64 capacity or prove
the exact internal allocation responsible.

The broader pipeline initially refused a timeout scenario as `not_run` because
HEAD observations were unknown. Instrumentation identified two separate timing
issues: the synthetic proxy's default ten-second idle timeout reset in-flight
connections, and actual source HEAD probes took roughly 7–11 seconds under
emulation. Late responses had matching commit/tree data; source OOM counters
were zero. The proxy was corrected to match the real control server's connection
timeout. A further valid HEAD response still took 11,020 ms and exceeded the
unchanged caller deadline. The three failed runs and HTTP observations remain
in the JSON receipt. Bun documents that its default idle timeout also applies
to in-flight handlers that have not written response bytes.
([Bun server documentation](https://bun.sh/docs/runtime/http/server#idletimeout))

Review found three full Git verification subprocess passes in the metadata
path. Protected root binding identity checks are now separate from checkout
inspection: the outer checks validate root-owned bound intent; the single agent
helper retains full Git verification and HEAD/tree/HEAD stability. Snapshot
object hashes, parent validation and before/after HEAD checks remain. Regression
coverage verifies the metadata-only method performs no Git or writes and refuses
missing, copying, wrong-ID/base or unsafe-permission receipts. Caller deadlines,
resource limits and result assertions were retained.

A final Worker regression reproduced a separate service-path problem: ordinary
runtime preparation on settings-version drift invoked the legacy checkpoint
path before source export. The new export path now uses a warm-only borrow.
The regression records zero preparation, checkpoint, configuration, startup,
session or provider calls and an unchanged activity epoch. Cold creation is
refused before recording an intent. Stored exports and lost-acknowledgement
recovery remain available cold. The legacy fingerprint/engine behavior was not
changed or qualified by this increment.

## Scope and limits

Evidence provenance is `local_operator`; the operator trusts the local collector,
checker image and Docker host. There is no server-authenticated completion
bridge in this increment. The current service still uses Cloudflare adapters;
this does not implement the standalone PORT replacement or add a vendor agent
runtime at the core. OpenCode remains the coding harness.

Commit/tree/snapshot identities describe immutable **input**, rather than a
proof that the command left scratch files unchanged or established correctness.
Before/after HEAD probes report matched, stale or unknown observations.
`worktreeChanges: unverified`, `baselineChecks: not_run` and
`testOrConfigChanges: not_evaluated` remain explicit. Uncommitted changes, a head
that changed and changed back, and independent acceptance tests are not certified.

The first profile supports dependency-free offline Bun checks. It does not
install dependencies or infer execution authority from repository instructions.
Missing dependencies and exceeded limits cannot become a pass. The service
requires encryption, caps each conversation at ten retained intents, and
accepts up to 4 MiB of snapshot JSON (within the shared validator's 8 MiB ceiling).
Full limits and invocation are in the [runbook](../runbooks/workspace-check.md).

No model inference, publication or deployment is part of this qualification.
G0/G1/G1-C/C0/PORT-G, baseline comparison, changed-check review, remote completion
attestation and deployed qualification remain open.
