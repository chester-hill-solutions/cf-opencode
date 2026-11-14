# R0-15 expanded recovery matrix — 2026-11-14

**Live qualification failed on accepted metadata loss.** The frozen Stow 0.4.0
image completed Cloudflare/R2 cold recovery for 14 cases; missing and mismatched
registries were refused before mutation. One metadata case failed before capture.
[Structured live receipt](storage-matrix-live-2026-11-14.json) contains every action,
initial/final row, artifact/source hash, manifest, runtime request and run boundary.
[R0-15 in the roadmap](../roadmap.md) remains open. No production cutover occurred.

## Scope and artifact

The candidate is unchanged from the [artifact freeze](storage-preflight-2026-11-14.md):
Stow 0.4.0, controller `0ec5e1e…8cace`, binary `6f0f2479…5420b6`, and OCI digest
`2cd03c57…c2ba`. A pull-only authenticated registry HEAD initially returned 404.
The user explicitly approved republishing the cached image and uploading the
prepared qualification Worker to Chester Hill Solutions account
`ad5ec479b9a421faa2ed06c3d1c2b23a`. Republishing rebuilt nothing and restored the
**same** OCI digest; authenticated HEAD then returned 200 with that digest.

Worker `aboiteau-storage-matrix-20261114`, version
`734594db-dcc0-4d06-b515-a4fabfc1016c`, used a fresh namespace, empty R2 bucket and
fresh test-only secrets. The fixed synthetic key was the sole test conversation.
The probe bundle and source hashes remained unchanged throughout the live run.
The requested shape was 1 vCPU / 2048 MiB / 8192 MB, with 300-second idle close.
Actual allocations remain unknown because `inspect()` exposes image and labels.

The approved run had a 30-minute window and $1 operational budget, one active
container, at most 100 requests and zero provider prompts. This is an operational
stop boundary, not a Cloudflare billing cap. At published rates, full CPU and the
requested memory/disk for the whole window would be about $0.046 in container
compute, excluding Workers/DO/R2 and other charges. Actual billed cost is **null**.
[Pricing source](https://developers.cloudflare.com/containers/platform/pricing/).
The live actions ran from 20:49 to 20:51 UTC, within that window.

## Observations

| Fixed case | Result |
|---|---|
| Plain, spaces, Unicode, literal percent, punctuation | Exact S3 bytes/listed keys preserved; natural keys also matched filesystem bytes |
| Double slash, dot segment, traversal, `.stow`, `.git` | Exact S3 keys/bytes preserved; protected alias bytes intact; outside path absent after cold restore |
| Object metadata | **Failed before capture:** accepted PUT; bytes, content type and user metadata match, but Cache-Control, Content-Disposition and Content-Encoding do not |
| Unfinished multipart | Acknowledged part survived; completed after restore with exact bytes |
| Git | HEAD, branch, tracked diff and untracked file preserved |
| Background writer | Active capture succeeded in one attempt; restored pair/status agree and advanced beyond startup acknowledgement |
| OpenCode history | Imported synthetic user history, title, metadata and context digest preserved; no prompt dispatch |
| Missing registry | HTTP 409; children stopped, workspace and registry state unchanged |
| Mismatched registry | HTTP 503; children stopped, workspace and registry state unchanged |

`/prepare` took 12.7 s and reported `preparationPassed: false`. `/recycle` took
2.2 s and verified encrypted workspace (14,924 bytes) and state (881,435 bytes)
objects against their R2 manifests. `/verify` took 15.0 s and reported stage
`failed`, `qualificationPassed: false`, 14 preserved / 2 refused / 1 failed.
Cold image start retained the workspace ID and omitted the disk-only sentinel;
no snapshot was used. The active capture itself took 1.46 s, within the writer's
30-second lifetime. No quiesced retry was needed in this run.

The metadata row in the final matrix carries its preparation failure forward;
it is not an independent full metadata HEAD measurement after restore. Restored
content type was separately checked. This is an S3 response-contract failure,
not proof of which internal metadata representation lost the fields. The next
step is to locate that native Stow gap, persist/return those fields or reject the
unsupported mutation before writing, then re-qualify a frozen candidate.

The matrix is fixed synthetic evidence from one run. It does not prove arbitrary
repository writers, process-memory recovery, external-effect replay, repeatability,
account-seed isolation or the production retained/reset-data migration inventory.
Those remaining R0-15 obligations and all product gates stay open.

## Harness and checks

The [harness README](../../scripts/native-storage-qualification/README.md) documents
its versioned 17-case inventory, build step, fixed API, receipt schema, optional
local Docker runner, bounded writer and fault cleanup. Raw signed loopback HTTP
preserves ambiguous request paths. Safe projection removes arbitrary error and
credential fields. Aggregate success requires all cases exactly once, terminal
accepted dispositions, no false detail checks and no failed preparation case.
Registry faults compare both workspace and registry bytes and restore both roots
between cases. Writer recovery requires progress after acknowledgement, not just
a cached `active` flag.

Local checks passed: full typecheck, config agreement, UI build, 412 Bun tests and
5 runtime tests. Final fixture typing and all 11 contracts passed after the
writer-progress guard; the concrete live config passed Wrangler dry-run before
upload. The full local Worker/DO run was **not green**: 345/351 passed, five tests
timed out at 5 seconds and one concurrency assertion failed. The host was busy;
contention is a suspected contributor, not an established diagnosis. No repeated
heavy local test run was attempted after the user requested live tests instead.
Prior native CI qualifies only its recorded commit, not these harness changes.

Two developmental local Docker attempts are preserved separately:
[attempt 1](storage-matrix-local-development-1-2026-11-14.json),
[attempt 2](storage-matrix-local-development-2-2026-11-14.json). Both stopped in
the writer/capture stage and reached no cold restore. They also observed the
metadata gap. Their punctuation filesystem expectation was corrected: portable
Stow layout escapes `?`, while the exact S3 key/bytes still must recover. The
second attempt did not freeze a single probe bundle; the final runner now does.
These attempts are not included in the live success count or hidden as passes.

## Cleanup and cutover hold

`/cleanup` returned 200, runtime stopped and zero qualification R2 objects.
The temporary Worker, its exact container application and empty bucket were
subsequently deleted. Temporary API/encryption/registry credential files were
removed. The two local task containers were removed or confirmed absent.
The restored versioned image tag is retained for reproducing this candidate.
Historical 0.3.7 receipts remain unchanged. No production data was reset,
no production resources were changed and no product gate was closed.
