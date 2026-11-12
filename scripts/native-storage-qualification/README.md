# Isolated native Workspace recovery qualification

This harness exercises the real Conversation startup, encrypted split checkpoint,
recycle and restore paths with synthetic files. It creates no model session or
prompt. The fixed authenticated API exposes only POST `/prepare`, `/recycle`,
`/verify` and `/cleanup`, with empty request bodies.

Use a unique new Worker name/DO namespace, a newly created empty R2 bucket and
fresh `API_TOKEN` and `VAULT_MASTER_KEY` secrets. Never reuse production bindings
or credentials. Fill the template's placeholders and pin an independently
verified image by its OCI digest. If copying the config elsewhere, resolve its
`main` and schema paths accordingly. The source/binary hashes in both probes
must match that image. One fixed conversation key addresses one test container;
the inherited runtime starts it as `standard-1`.

Run the contract tests with
`bun test scripts/native-storage-qualification/qualification-contract.test.ts`.
Generate types and run `wrangler deploy --dry-run` for the concrete config before
deploying. Store secrets in a private file for `wrangler deploy --secrets-file`;
keep that file out of version control and remove it after cleanup.

Call the four actions in order with the new API bearer token. Preserve the safe
JSON receipts before cleanup deletes the test state. The verify receipt checks
same identity, bytes, content type, fresh image start and absence of a disk-only
sentinel; it does not qualify arbitrary keys, multipart or active writers.

After `/cleanup`, delete the unique Worker, its container application and the
empty bucket. Worker deletion leaves its container application behind: use the
exact application ID reported by Wrangler for `wrangler containers delete`.
Never select a production application by inference. The uploaded image may be
retained as the qualified artifact.

The completed run and its limits are in `receipt-2026-11-12.json` and the owning
[integration plan](../../docs/plans/stow-workspace-integration.md).
