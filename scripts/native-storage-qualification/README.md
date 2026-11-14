# Isolated native Workspace recovery qualification

This harness exercises the real Conversation startup, encrypted split checkpoint,
recycle and restore paths with synthetic files. It creates no model session or
prompt. The fixed authenticated API exposes only POST `/prepare`, `/recycle`,
`/verify` and `/cleanup`, with empty request bodies.

Use a unique new Worker name/DO namespace, a newly created empty R2 bucket and
fresh `API_TOKEN` and `VAULT_MASTER_KEY` secrets. Never reuse production bindings
or credentials. The current candidate is Stow **0.4.0** and the explicit
`custom-1cpu-2gib` profile (1 vCPU, 2048 MiB memory, 8192 MB disk), with a 300 s
idle window. Image, controller/binary hashes and requested shape are frozen in
[`artifact.ts`](artifact.ts); the Worker and generated container probe use those
same pins. A missing profile, different image, different requested resources or
historical receipt is refused. Cleanup remains available for mismatched runs.

Run the complete **offline** preflight:

```sh
bun run qualification:preflight
```

This typechecks the fixture, runs its safety contracts, generates binding types,
and runs Wrangler `deploy --dry-run`. Its generated config uses a deliberate
all-zero account ID and nonexistent resource names. Generated bindings and bundle
live under `.wrangler/native-storage-preflight/` and are ignored by Git. The
command creates no resources, uploads no image/Worker and uses no secrets.
The fixture typecheck and contract tests also run in the normal integration gate.

For a later **live** run, fill the template's account/bucket/image placeholders
in a separate config with a unique Worker name and newly created empty bucket.
The image must match `artifact.ts`. Confirm remote digest availability before
provisioning: the earlier shape experiment removed its registry tag. If copying
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
same identity, bytes, content type, fresh image start and absence of a disk-only
sentinel; it does not qualify arbitrary keys, multipart or active writers.

After `/cleanup`, delete the unique Worker, its container application and the
empty bucket. Worker deletion leaves its container application behind: use the
exact application ID reported by Wrangler for `wrangler containers delete`.
Never select a production application by inference. The uploaded image may be
retained as the qualified artifact.

The historical 0.3.7/`standard-1` run and its limits remain unchanged in
`receipt-2026-11-12.json`. Current artifact provenance and the outstanding full
recovery matrix are in the [preflight evidence](../../docs/evidence/storage-preflight-2026-11-14.md).
The [roadmap](../../docs/roadmap.md) owns sequencing and gate status. The current
slice uses no paid resources; record destination, limits and spend ceiling before
the live qualification. Preparing this harness closes no live recovery gate.
