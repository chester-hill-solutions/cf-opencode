# Stow workspace integration and resource adoption

Status: bounded A characterization implemented and verified on the pinned Linux
image under emulation; startup and recovery repair in B–D remain planned.
Decision date: 2026-11-11. Owner: Aboiteau. Roadmap: R0-15, then R2-4/R3-4.

## Problem and boundary

`startStow()` currently launches `stow-s3 serve --backend filesystem` with
`--data-dir /workspace/.stow`. That opens Stow's object-record store, not its
registered shared-directory Workspace. `cwd: /workspace` does not change the
backend. Objects held only in `.stow` are excluded from the R2 workspace tar.
This contradicts the README's same-bytes claim. See the
[local source assessment](stow-local-branch-impact.md#integration-prerequisite).

Keep OpenCode in Cloudflare Containers, Stow as native working storage, and the
existing R2 workspace/OpenCode-state recovery pair. Correcting the selected Stow
surface is required integration work; it does not reopen alternative runtimes.
Aboiteau owns container lifecycle, credential custody, writer coordination, tenant
authorization, R2 publication and restore. Stow owns its Workspace, S3 facade,
readers, format/lifecycle contracts and applicable artifact qualification.

## R0-15 — repair and qualify the existing integration

Execute these slices in order; R0-15 is required before claiming same-directory
S3 storage or closing G0 on a task that depends on it. Existing accounting and
live-prompt restrictions remain in force.

| Slice | Work | Acceptance |
|---|---|---|
| A. Characterize | Reproduce the generic-store/workspace distinction with a disposable native fixture and no model/provider calls. Inventory current data and recovery exclusions. | Test distinguishes direct `/workspace` bytes from object-only bytes under `.stow`; record exact Stow artifact and platform. |
| B. Own and serve | Use Stow's existing prepare/open/resume and `workspace serve --id` or supported thin launcher. Retain trusted workspace/registry identity and consume versioned readiness. | OpenCode receives the reported endpoint, region, bucket and credentials; do not assume port 9000, fixed credentials or that a health response proves correct backend/root. Readiness failure prevents prompt dispatch and cleans up children. |
| C. Recover | Define identity reconstruction and data preservation across the existing R2 restore. Preserve OpenCode's separate state archive, Git state, permissions and encryption/manifest checks. | A new container with no prior disk/registry recovers the intended workspace and can serve it again; unknown or missing identity/data fails visibly. No live process-memory recovery claim. |
| D. Verify and document | Run bidirectional same-byte and cold-recovery checks on the selected native Linux artifact, then update README/runbook and operating evidence. | Direct file write → S3 read, S3 write → direct file read, overwrite, delete, binary/range read and post-restore equality all pass. Record source/artifact hashes and preserve macOS versus Linux evidence boundaries. |

### A assignment — disposable characterization

Prepared and executed 2026-11-12. The existing dispatch owner,
`gpt-6-luna` / high, implemented one bounded fixture and its evidence. Files:
`scripts/characterize-stow-workspace.sh` and `scripts/stow-s3-probe.ts`.
Keep production `Dockerfile`, `control-server.ts`, startup, archives and the
sibling Stow checkout unchanged during this assignment.

Read-only baseline facts at `69c98f0`: the Dockerfile defaults to Stow `0.3.7`,
selects `stow-linux-${TARGETARCH}.tar.gz`, checks the release's downloaded
`SHA256SUMS.txt` and deletes those download files. The resolved archive/binary
hash is not recorded in this repository. The deployment runbook targets
`linux/amd64`; source defaults and macOS/arm64 results do not prove the actual
deployed artifact or Workspace CLI availability.

1. Use the selected pinned evented image from `wrangler.jsonc` as the initial
   disposable subject on `linux/amd64`, rather than rebuilding/changing the
   production image. Record image/platform, Stow version and binary SHA-256,
   CLI help and emulation status. Record a release-archive hash if actually
   obtained; do not invent one from the version or image digest. If the artifact
   cannot be accessed, report the blocked qualification rather than substitute
   a different binary silently.
2. Reuse the container/control pattern in `scripts/smoke-container.sh`, with a
   unique temporary name, synthetic credentials/data, bounded waits and cleanup.
   Make no model/provider calls and mount no production workspace or credentials.
   The installed Bun types expose `S3Client` with custom endpoint/path-style
   configuration; preflight the actual image's support and use that existing
   signed client for PUT/GET. No hand-written SigV4 implementation or unpinned
   host CLI is required. Report unsupported client behavior explicitly.
3. Write one direct file and a separate S3-only object. Confirm that the current
   generic server does not expose the direct file as the object and does not
   create the S3-only object as a normal `/workspace` file. A health response
   alone cannot pass this check.
4. Obtain the workspace checkpoint and verify the direct file is present while
   `.stow` and its object-only content are absent. Then write another S3 object
   and request a workspace checkpoint using the previous fingerprint; confirm
   the current implementation returns 204 despite the object-only mutation.
   Record that as the reproduced recovery gap, not successful preservation.

Stop after capturing those facts and checking whether the actual released
artifact offers the required Workspace prepare/open/resume/serve and readiness
contract. Missing commands or schema compatibility block B. This fixture does
not inventory every existing store, qualify a replacement artifact or close
R0-15: durable workspace/registry identity, supported key/metadata/multipart
preservation and real existing-data inventory remain prerequisites before
startup or migration work. Record results here rather than create a second
storage roadmap.

#### A characterization results — 2026-11-12

The runner initially stopped before container creation because Docker's client
reported an unavailable daemon despite returning success from `docker info`.
After the local engine became available, one run exceeded an initial 10-second
`/start` limit; the bounded limit was corrected to 120 seconds to cover the
control server's existing startup waits. Two later runs proved that the empty
generic filesystem store returns `NoSuchBucket` until a bucket exists. Each
failed attempt is retained below. The first timed-out attempt has partial
evidence rather than a structured result; later runs captured structured failure
receipts. Created containers were removed, and the initial daemon failure
created none.
Their private evidence is in `/tmp/stow-workspace-characterization-20261112T054437Z/`,
`/tmp/stow-workspace-characterization-20261112T055505Z.HjG8Al/`,
`/tmp/stow-workspace-characterization-20261112T055801Z.ndSh2a/` and
`/tmp/stow-workspace-characterization-20261112T060141Z.lOZjOi/`.

The successful run used the exact configured evented digest, already cached as
image ID
`sha256:1c8228f73527ebf419bb153e6a9fe689dbf5fc858ac31d6d9db781e2fef27ed7`.
The selected image platform was `linux/amd64`; the host was `arm64`, so this run
used emulation. The installed binary reported Stow `0.3.7` and had SHA-256
`780c3ccf89abdb4355e1b943ab686693d7436bd08cefdffd0f315226815f27da`. The
release archive hash remains unknown (`null`): Dockerfile deletes the download,
and this fixture did not rebuild the image. The workspace archive SHA-256 was
`43d05f35a9c2b081f29b157c10dcfda083745c1daff1384334614b8c67dfab6a`.

Using the in-container Bun `S3Client`, the signed PUT and GET round-tripped the
synthetic object. The direct `/workspace` file was absent from S3, and the
S3-only object was absent as a normal workspace file. The workspace tar included
the direct file's exact bytes and excluded `.stow` and the object-only key. After
the archive fingerprint was captured, a second signed S3 object PUT left the
workspace unchanged, and the conditional workspace checkpoint returned 204.
This reproduces the generic-store/recovery gap for this fixture. The object
bucket was bootstrapped before server start via the pinned Stow MCP CLI's
documented `--object-dir /workspace/.stow --bucket stow-characterization
--create-bucket` path. This is setup for the test, not evidence that an S3
CreateBucket request was exercised. After adding B1 mode, the unchanged generic
path passed again using the same image/binary; the conditional checkpoint was
204, and the archive SHA-256 was
`5c0a87b30593d81afefa2e2c8f87acfd6eaa86c85d1459b1c163e663647728cb`. Its
container was verified absent after cleanup. The rerun evidence is in
`/tmp/stow-workspace-characterization-20261112T065015Z.IgINSo/`; the original
successful evidence remains in
`/tmp/stow-workspace-characterization-20261112T060859Z.6SNbcZ/`.

Actual image help lists Workspace `prepare`, `adopt`, `resume` and `serve`, but
no standalone `open` subcommand. The `serve` help advertises `--ready-fd` for a
readiness JSON object. `prepare --help` takes a versioned manifest; `resume`
accepts a workspace ID or handoff; `serve` accepts an ID and registry options.
`adopt` is a bundle-import operation, not a standalone `open` command. The Go
flag parser exits 1 for several `--help` calls after printing valid help; exit
1 is not evidence that those commands are missing. A did not invoke readiness;
B1 results are recorded below. The checked-out source tag is not sufficient
provenance for this image, so the captured binary hash and image digest are the
artifact evidence; full Workspace ownership/cold restore behavior and
release-source correspondence remain unqualified. Do not treat this
characterization as a migration or as an inventory of every existing `.stow`
store.

The disposable runner is `scripts/characterize-stow-workspace.sh`; its signed
S3 operations are in `scripts/stow-s3-probe.ts`. It resolves the exact pinned
evented digest, targets `linux/amd64`, exposes only an ephemeral loopback
control port, uses synthetic data/credentials and creates no host mounts. The
successful run's container ID was
`e31b9866b22c39d9c424cd130970f4ffbb7bc5c20043c8ec7f100c4716a27278`; a later
Docker inspect returned `No such container`, confirming cleanup. A and the
bounded B1 identity/readiness/process-restart characterization are complete.
Supported data preservation and cold restore still require qualification.

## B1 native Workspace readiness and process restart

B1 uses the same exact pinned `linux/amd64` evented image in a new disposable
container. Its runner mode is `bash scripts/characterize-stow-workspace.sh
workspace`; it bypasses the generic control-server configure/start path and does
not bootstrap the generic MCP object bucket. The test manifest is synthetic:

```json
{"version":1,"root":"/workspace/stow-workspace","working_directory":".","registry_dir":"/var/lib/aboiteau/state/stow/registry","bucket":"aboiteau-workspace","inputs":[{"source":"/tmp/stow-b1/seed.txt","destination":"seed.txt"}]}
```

The target root must be absent before the single native `workspace prepare`.
The runner checks the returned workspace identity and paths, starts `workspace
serve` using a fresh private `--ready-fd` file, and validates the reported
loopback endpoint and S3 credentials before constructing Bun's S3 client. It
then checks exact direct-file-to-S3-GET and signed-S3-PUT-to-direct-file bytes,
stops the owned serve process, and starts it again with the same identity and
registry without another prepare. The second readiness file is separate, so a
stale readiness payload cannot satisfy the restart check. The probe output
contains validation booleans only; it does not print readiness or credential
values.

This is a same-container process restart check. It is not a container restart,
checkpoint/restore test, R2 cold restore, or proof that `.stow` object metadata
and multipart state survive the existing workspace archive. The initial
manifest-only attempt stopped with `stow: prepare requires at least one input`;
its private failure receipt is retained in
`/tmp/stow-workspace-b1-20261112T064541Z.zP6lhw/`. The public task-manifest
contract at `/Users/ladmin/WebProjects/stow/docs/contracts/task-manifest.md`
specified an `inputs` source/destination mapping, so the retry supplied one
synthetic local seed file (`/tmp/stow-b1/seed.txt` to `seed.txt`) and verified
its exact bytes in the prepared root.

The successful bounded run used the exact configured image digest and
`linux/amd64` platform on an `arm64` host under emulation. Stow was `0.3.7`,
binary SHA-256
`780c3ccf89abdb4355e1b943ab686693d7436bd08cefdffd0f315226815f27da`. Prepare
ran once; the descriptor's version, identity, root, canonical working
directory, registry and bucket matched the manifest. The two fresh readiness
payloads passed schema/identity checks and rejected wrong version, root,
workspace ID and non-loopback endpoint before client construction. Bun S3
verified exact direct-file-to-GET and signed-PUT-to-file bytes. The owned native
serve child was signaled, its supervisor recorded clean exit status 0, and a
second serve start without another prepare read the same bytes. The disposable
container (`05cd70cf00caac05021e9383b81358a63d7bea9c4064da427d437d149646e07b`)
was verified absent after cleanup. Redacted evidence is in
`/tmp/stow-workspace-b1-20261112T064905Z.vaAqcK/`.

B1 qualifies only this manifest/prepare/readiness/S3-byte-parity and
same-container serve-process restart path. It does not qualify a container
restart, `.stow` object metadata or multipart recovery, checkpoint restoration,
or R2 cold restore. Preserve the initial failed attempt as part of the record.
Do not change production startup or archive behavior based on this bounded
result.

Before changing startup, classify the existing generic S3 store's contents. Preserve
object-only data through a verified export/mapping or explicit separate recovery
part; do not delete `.stow` as a cache or silently reinterpret its records as files.
Unknown contents or an unverified migration block cutover. The R2 fallback must be
tested with full-disk snapshots unavailable, so snapshots cannot mask missing data.

The recovery inventory must cover natural file keys, escaped/reserved keys, object
metadata, unfinished multipart state and workspace/registry identity. For each,
record whether it is preserved, safely rebuilt or explicitly unsupported. A key
that cannot be recovered must be refused before mutation or preserved separately.
Plain file equality does not prove complete S3 recovery. Preserve `.git` and
OpenCode's SQLite/session state; Stow's project checkpoints have different exclusions.

Use the versioned CLI/launcher contract and existing ownership/root constraints.
Do not patch Stow's private internals or change its generic `serve` default. Reuse
available released Workspace APIs for this repair; any dependency on unreleased
changes requires a pinned, separately qualified artifact and explicit compatibility
evidence. This plan does not schedule a release, deployment or paid model run.

## Resource adoption after the wiring is correct

| Feature | Owning work and prerequisites | Acceptance |
|---|---|---|
| Live files/artifacts | R2-4 inspection; correct registered Workspace, usable selected artifact and R1 authorization | Bounded read-only attachment while the agent runs; explicit read roots, private-path exclusions, pagination/expiry and tenant checks; attachment release cannot strand cleanup. Use Stow's reader/MCP surface rather than inventing another file store. |
| Saved review points | R2-4 inspection, with R3-4 workspace policy where needed; Stow checkpoint identity/integrity and supported artifact | Present saved versus live views explicitly. A saved view survives later working edits; active readers coordinate with prune/removal. Retain current R2 recovery until separately demonstrated equivalence. |
| Paused human edits | Later scoped slice after Stow qualifies public SaveFile/ResolveSave and recovery, plus R1 authorization | Quiesce every outside writer, including OpenCode shell, background processes and S3 mutations. Reject stale bases, resolve lost replies without another write, and preserve unknown outcomes. No simultaneous collaborative-editing claim. |

Recorded macOS local qualification of W23/W24/W25 or internal W26 publication does
not qualify our Linux image, a protected multi-tenant service, or the whole active
Stow tree. Public editing stays deferred until its actual artifact/API is qualified.
Named workspace inspection does not justify FUSE, executable discovery or WASM.

## Coordination with Stow

The sibling checkout's `docs/design/aboiteau-native-consumer.md` records the Stow
side under its canonical W19/W20/W21 and W23–W26 work. Aboiteau is a named consumer
candidate; this plan is not evidence of completed integration, a consumer pilot or
independent repeat use. Record consumer results in this repo and platform/artifact
qualification in Stow, linking the actual receipts when they exist.
