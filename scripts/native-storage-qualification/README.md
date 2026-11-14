# Isolated native Workspace recovery qualification

This harness exercises the real Conversation startup, encrypted split checkpoint,
recycle and restore paths with synthetic files and imported session history.
It sends no model prompt. The fixed authenticated API exposes only POST `/prepare`, `/recycle`,
`/verify` and `/cleanup`, with empty request bodies.

Use a unique new Worker name/DO namespace, a newly created empty R2 bucket and
fresh `API_TOKEN` and `VAULT_MASTER_KEY` secrets. Never reuse production bindings
or credentials. The current candidate is Stow **0.4.0** with downstream
**metadata-refusal.2** ([patch and scope](../../patches/stow/README.md)) and the explicit
`custom-1cpu-2gib` profile (1 vCPU, 2048 MiB memory, 8192 MB disk), with a 300 s
idle window. Image, controller/binary hashes and requested shape are frozen in
[`artifact.ts`](artifact.ts); the Worker and generated container probe use those
same pins. A missing profile, different image, different requested resources or
historical receipt is refused. Cleanup remains available for mismatched runs.

Run the complete **offline** preflight:

```sh
bun run qualification:preflight
```

This typechecks both fixtures, runs their safety contracts, generates binding
types, and runs Wrangler `deploy --dry-run` for both Workers. Their generated
configs use a deliberate all-zero account ID and nonexistent resource names.
Generated bindings and bundles live under `.wrangler/native-storage-preflight/`
and are ignored by Git. The command creates no resources, uploads no image/Worker
and uses no secrets.
The fixture typecheck and contract tests also run in the normal integration gate.
`build-probe.ts` bundles the typed container modules into ignored generated files;
all three qualification commands and the regular typing/test commands build it first.

The versioned matrix has 17 fixed cases: ten natural/escaped/reserved keys,
object metadata, unfinished multipart upload, Git state, a background writer,
imported OpenCode history, and missing/mismatched registry refusal. S3 requests
use signed raw loopback HTTP so URL normalization cannot erase dot segments.
Each result has an allowlisted disposition, reason and optional boolean checks;
readiness credentials, control tokens and upstream error bodies are excluded.

Natural keys require filesystem/S3 byte parity. Escaped keys require exact S3
bytes and listing names, with alias/traversal canaries intact before and after
restore. Stow's portable layout escapes `?`, so the punctuation case deliberately
does not require a natural file path. Metadata checks cover content type, cache
control, disposition, encoding and user metadata separately. Multipart must retain
its acknowledged pending part and complete with exact bytes after recovery.
An accepted mutation followed by metadata or part loss fails qualification.

The bounded writer changes a pair of checksummed files. Recovery must show matching
files/status and progress beyond its initial acknowledgement. If active capture
is refused, the live harness requires a retained runtime and unchanged manifest
before stopping this one synthetic writer and retrying once. Receipts distinguish
active capture from the quiesced retry; this does not prove general process
quiescence or transactional filesystem snapshots. Registry fault injection saves
and restores both roots between cases, checks the full registry and workspace
before/after refusal, and verifies restoration of the original fixture.

For optional **local Docker** evidence, use `bun run qualification:local`. It
starts two disposable containers from the already cached frozen image, with no
network, mounts or provider credentials, and restores actual split archives after
removing the original container. It freezes one probe bundle for both containers.
Exit 0 means the local matrix passed, 2 records observed matrix failures, and 1
means the run or cleanup was incomplete. It prints safe JSON and attempts cleanup
even after a partially acknowledged container creation. This command is outside
the normal test gate and does not qualify Cloudflare/R2 or its custom shape.

For a later **live** native storage run, fill the template's account/bucket/image placeholders
in a separate config with a unique Worker name and newly created empty bucket.
The image must match `artifact.ts`. Confirm remote digest availability before
provisioning; keep source/binary/patch/image provenance in the receipt. If copying
the config elsewhere, resolve its `main` and schema paths accordingly. The
template explicitly sets `CONTAINER_INSTANCE_PROFILE=custom-1cpu-2gib` and
`IDLE_CLOSE_SECONDS=300`.

Generate types and run `wrangler deploy --dry-run` for the concrete config before
deploying. Store secrets in a private file for `wrangler deploy --secrets-file`;
keep that file out of version control and remove it after cleanup.

Prepare/verify receipts distinguish the requested resources from measured
resources: `runtime.requested` records the checked startup request;
`runtime.observed` is `null` because the current `container.inspect()` API exposes
only image and labels. This does not claim independently observed allocations.

Call the four actions in order with the new API bearer token. Preserve the safe
JSON receipts before cleanup deletes the test state. The verify receipt checks
same identity, fresh image start, disk-only sentinel absence, the encrypted R2
objects and the complete fixed matrix. `/prepare` can succeed with
`preparationPassed: false` so remaining cases can still be observed. `/verify`
reports `qualificationPassed: false` and stage `failed` for any failed or
unexercised case; a later good observation cannot erase a preparation failure.
Preserve initial and final observations. No fixed matrix qualifies arbitrary
repository processes, external-effect replay or production data migration.

After `/cleanup`, delete the unique Worker, its container application and the
empty bucket. Worker deletion leaves its container application behind: use the
exact application ID reported by Wrangler for `wrangler containers delete`.
Never select a production application by inference. The uploaded image may be
retained as the qualified artifact.

The historical 0.3.7/`standard-1` run and its limits remain unchanged in
`receipt-2026-11-12.json`. Current artifact provenance and the outstanding full
recovery matrix are in the [preflight evidence](../../docs/evidence/storage-preflight-2026-11-14.md).
The [roadmap](../../docs/roadmap.md) owns sequencing and gate status. The current
offline preparation uses no paid resources. Record destination, limits and spend
ceiling before live qualification. Preparing this harness closes no live recovery gate.

The separate `account-seed.ts` fixture is the bounded R0-15a live rehearsal.
It uses fixed source and recipient Durable Object names and the legacy global
account seed key. `/prepare` starts a source with the ordinary read-only
onboarding catalogue path and writes only synthetic marker data; `/capture`
calls the ordinary account state checkpoint endpoint and applies the same
workspace-key derivation and encryption used by onboarding before writing R2;
`/verify` starts a distinct clean recipient through ordinary readiness, which
consumes that encrypted seed, then checks the synthetic account marker, distinct
Stow identity, absent source workspace sentinel, pinned binary/controller
hashes, and refusal of a second seed after initialization. `/cleanup` resets
both fixed conversations, removes the seed, and proves the staging bucket empty.
No model prompt or real provider credentials are used. The marker proves archive
fidelity only; this rehearsal does not prove live provider authentication,
tenant/agent seed isolation, removal of arbitrary source history (the account
archive includes SQLite backup), or live rejection of a conversation-state
archive. That last negative remains covered by `smoke-container.sh` local
evidence. Receipts must contain only explicit booleans, hashes, IDs and bounded
sizes; never return archive bytes, settings contents, readiness credentials, or
upstream/native error output.
Source and recipient refuse any prior startup token; recipient verification is
claimed once before startup and cannot be replayed after a partial attempt.
Use a fresh Worker/DO namespace for each rehearsal, including after cleanup.

Use `account-seed-wrangler.template.jsonc` for that rehearsal, with its own
unique Worker and newly created empty bucket. Its endpoint sequence is
`/prepare`, `/capture`, `/verify`, then `/cleanup`; the shared
`qualification:preflight` command also checks this second Worker configuration
without deploying it.
