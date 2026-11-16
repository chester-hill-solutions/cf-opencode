# R0-15 artifact freeze and preflight — 2026-11-14

This is evidence/input to [roadmap R0-15](../roadmap.md), not a live recovery
receipt or a production cutover. No Cloudflare resources were created and no
provider inference was run.

## Frozen candidate pair

| Field | Value |
|---|---|
| Source of image | `3d71de1`; subsequent base `39a42d5` changes documentation only |
| Stow | `0.4.0`, Linux amd64 |
| Stow binary SHA256 | `6f0f247912de4c4d5d296a3176fe291b7c29717498f5778d920949d4025420b6` |
| Control server SHA256 | `0ec5e1e2dff12951041e837cab3aa877701f1d02359f6ecc8650e1cf20c8cace` |
| Local image ID | `sha256:dc0856170d9a60aa1f9c9766435031ddfdf9e2688f5c9b8b0cec2d08153ad630` |
| Recorded OCI digest | `registry.cloudflare.com/ad5ec479b9a421faa2ed06c3d1c2b23a/cf-opencode-shape-ab@sha256:2cd03c57e7458d337fde892cb6a729969e5dd55d6e3f61d01f0ac67068fcc2ba` |
| Runtime profile | `custom-1cpu-2gib` |
| Runtime shape | `{ vcpu: 1, memoryMib: 2048, diskMb: 8192 }` |
| Idle window | 300 seconds |

The OCI digest matches both the local image's `RepoDigests` and the
[Cloudflare shape A/B receipt](../../bench/cloudflare-instance-shape-2026-11-14.json).
That earlier run deleted its image tag. **Remote digest availability has not been
rechecked.** Resolve it before a live run, or republish the exact local image and
record the resulting verified OCI digest. A local image ID cannot substitute for
a deployable registry digest.

Commands used to inspect the local pair:

```sh
docker image inspect cf-opencode-shape-ab:stow040-3d71de1 --format '{{json .RepoDigests}} {{.Id}} {{.Os}}/{{.Architecture}}'
docker run --rm --network none --platform linux/amd64 --entrypoint sha256sum cf-opencode-shape-ab:stow040-3d71de1 /app/control-server.ts /usr/local/bin/stow-s3
shasum -a 256 control-server.ts
gh run view 43627788591 --repo chester-hill-solutions/cf-opencode --json databaseId,headSha,status,conclusion,url,jobs
```

The direct in-image controller and Stow binary hashes matched the frozen values;
the host controller source hash matched as well. The three staging qualification
contract checks also passed with
`bun test scripts/native-storage-qualification/qualification-contract.test.ts`.

The [base native CI receipt](native-ci-base-2026-11-14.json) proves native Linux
`check` and rebuilt `container-smoke` at `39a42d5`. Its logs include native Stow
binary verification, workspace/state round trips, missing-registry refusal,
account-seed isolation, lifecycle serialization, and fresh-container restore from
both archives. It rebuilt an image; it does not certify the above deployed OCI
digest, the W0 commit, or Cloudflare/R2 cold recovery on the current shape.

## Initial harness preflight findings (before preparation)

The existing `scripts/native-storage-qualification/` fixture is historical C2,
not ready for a current-pair run:

- `worker.ts` and `container-probe.ts` both hard-code the old controller and
  Stow 0.3.7 binary hashes. They will correctly refuse the current image.
- The README and config comment describe `standard-1`; inherited startup now
  defaults to the custom profile. The future run must explicitly set
  `CONTAINER_INSTANCE_PROFILE=custom-1cpu-2gib` and record the requested and
  observed shape in its receipt.
- The existing probe checks natural-file parity, one content type, identity,
  encrypted split archives, and a disk-only sentinel. It does not exercise the
  complete inventory below.

Update both probe pins from one shared artifact definition before deployment;
require matching image, source/binary hashes and profile. Generate types and
perform a local Wrangler dry run against a concrete isolated configuration.
Do not overwrite the 2026-11-12 receipt or reinterpret it as current evidence.

## Harness preparation completed locally — 2026-11-14

The subsequent preparation resolves the stale fixture pins and adds a repeatable
offline check. [Structured receipt](storage-harness-preparation-2026-11-14.json)
records the artifact, source hashes and final checks; it is **PREPARATION_ONLY**.

- `artifact.ts` is the single image/controller/binary/profile/shape definition.
  The generated container program and Worker use its 0.4.0 pins. Artifact/profile
  mismatches are rejected before startup; historical receipts are refused.
- The template now explicitly requests `custom-1cpu-2gib` and 300 s idle. Prepared
  and verified receipts carry the checked startup request. Observed allocations
  remain `null`: the available `ContainerInfo` exposes image and labels only.
- `bun run qualification:preflight` typechecks the fixture, runs six contracts,
  generates bindings and runs Wrangler 4.158.0 `deploy --dry-run`. It passed with
  a 652.83 KiB bundle / 129.91 KiB gzip. The generated config has a deliberate
  all-zero account and nonexistent resource names; no resource was provisioned.
- The regular gate now includes fixture typing/contracts and passed: 407 Bun
  tests, 5 runtime tests, 351 Worker/DO tests, config/UI/diff checks. A focused
  preflight repeat passed after the final contract assertions were added.

The [harness README](../../scripts/native-storage-qualification/README.md) describes
the offline command and separate live configuration. The historical receipt is
unchanged. No current-slice native CI, actual resource measurements, remote image
availability check, live Cloudflare/R2 recovery matrix, or production cutover is
claimed. Those remain required for R0-15.

## Frozen recovery inventory for the next run

Every case must report its initial bytes/metadata, mutation response, checkpoint
manifest, cold-restored observation and disposition. All attempts and refusals
remain in the results. No case below has been newly run by this preflight.

| Case | Required observation / acceptance |
|---|---|
| Natural file keys, including spaces and Unicode | Exact file/S3 byte parity after encrypted R2-only recovery |
| Escaped, reserved and path-ambiguous keys | Preserve and recover exactly, or refuse before any mutation; name every refused key |
| Object metadata | Preserve supported content type and metadata fields, or refuse unsupported mutation before it changes data |
| Incomplete multipart upload | Document and prove preserve/rebuild/refuse behavior; no successful upload acknowledgement followed by silent loss |
| Background writer during capture | Prove a consistent supported recovery point or quiesce/refuse capture; a mixed archive is a failure |
| Workspace/registry identity | Same identity on a valid restore; missing/mismatched registry fails before workspace mutation |
| Git and OpenCode state | Preserve `.git` and the separate SQLite/session archive; snapshot cache disabled; no process-memory or external-effect replay claim |
| Archive encryption and manifests | Both R2 objects match the manifest, sizes and encryption metadata; cold image start verified with sentinel absent |
| Account seed isolation | Exclude conversation/workspace identity and ephemeral readiness credentials; recipient gets an independent identity |

## Run boundary and cutover hold

Use one newly named Worker/DO namespace, one newly created empty bucket, fresh
qualification-only API/encryption secrets, and a fixed synthetic conversation.
No sessions or prompts. Execute prepare → recycle → verify → cleanup, then delete
the exact newly created Worker, container application and bucket; preserve safe
receipts first. Unknown costs remain unknown.

The roadmap's current step is explicitly **no paid resources**. A live run needs
a recorded spend ceiling and runtime/resource limits before provisioning; this
preflight does not infer that ceiling. R0-15 remains open until the current-pair
Cloudflare/R2 matrix is actually run.

Production cutover is also outstanding. Its receipt must explicitly name retained
conversation checkpoints, files, OpenCode history, credentials, and accounting
holds/receipts, plus any intentional reset. This preflight authorizes no reset,
deletion, production deployment, or reinterpretation of historical data.
