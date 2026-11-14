# R0-15 storage cutover runbook

Status: **prepared; fixed candidate matrix passed; production rollout remains pending**.
The [roadmap](../roadmap.md) owns scheduling and gates. The first live matrix
[failed on metadata](../evidence/storage-matrix-2026-11-14.md). A downstream
[Stow patch](../../patches/stow/README.md) refuses unsupported object metadata
before mutation. Its corrected candidate passed the fixed live matrix and native
CI; see the [remediation result](../evidence/storage-metadata-remediation-2026-11-14.md).
Remaining inventory, live account-seed checks and production approval still apply.

## Retained and reset data

| Data | Required treatment |
|---|---|
| Conversation DO storage and IDs | Retain the existing namespace, conversation keys, phase, queue, idempotency records and checkpoint manifests. No namespace migration or reset. |
| Workspace files, `.git`, `.stow`, pending multipart | Retain through the encrypted workspace archive. Restore exact ambiguous keys and original workspace identity. Do not rebuild or delete the registry implicitly. |
| OpenCode SQLite/session history and configuration | Retain through the separate encrypted state archive, using its existing SQLite backup path. Restore the pair named by one verified manifest. |
| Native registry and identity | Retain in the state archive. Missing or mismatched state must fail closed. Never generate a replacement identity for an existing workspace. |
| R2 checkpoints and account seeds | Retain existing objects, prefixes, encryption keys and manifest ownership. No bucket reuse for qualification and no bulk deletion. Account seeds must exclude workspace identity/ephemeral credentials; current-pair evidence is still owed. |
| Vault credentials and grants | Retain existing encrypted credentials, master key and tenant mappings. The Stow binary change requires no credential migration. G1 credential-boundary enforcement is a separate open gate. |
| Accounting holds, dates and receipts | Retain reservation owner/date, unsettled usage, permanent unknown-cost markers and reconciliation records. Never release a hold or resend a prompt merely because the runtime changes. |
| Ephemeral readiness/control process state | Regenerate readiness credentials and start fresh processes through the existing control path. Persisted history does not imply resumed process memory or external effects. |
| Metadata previously acknowledged and discarded | No automatic repair is possible from an absent value. Preserve available bytes; record the limitation. The corrected refusal prevents new silent loss. |

**Intentional operator-data resets: none.** Any different migration/reset needs a
separate reviewed proposal naming the exact data and recovery consequences.
Qualification-only namespaces/buckets are disposable and distinct from this table.

## Before rollout

1. Freeze the exact source, downstream patch, binary SHA256, OCI digest and
   requested shape. Confirm the registry digest is available. Keep the previous
   artifact accessible for rollback; record compatibility limits.
2. Pass native CI (including Worker/DO regressions and native container smoke).
   A busy-host timeout run is not a passing gate. Run the fixed live Cloudflare/R2
   matrix on a fresh namespace/bucket with its recorded budget and cleanup.
3. Complete current-pair account-seed isolation checks and the remaining R0-15
   inventory. Record the preserved/refused/rebuilt disposition for each item.
4. Verify affected client behavior for `501 NotImplemented` on Cache-Control,
   Content-Disposition and Content-Encoding writes. This is a terminal unsupported
   contract, not an instruction to retry or silently strip requested properties.
5. Review the production destination, retained-data inventory, rollback artifact
   and operator receipt. Stop admission and establish quiescence through existing
   lifecycle controls. If provider dispatch/usage is ambiguous, preserve that
   state and use the privileged reconciliation path; do not force release/reset.

## Controlled rollout and verification

Deploy only the frozen artifact after the prerequisites and production approval.
Retain the current bindings, DO namespace, R2 bucket and secrets. Verify the
startup request/image, encrypted manifest heads, identity, workspace/Git bytes and
OpenCode history after a controlled checkpoint and cold image start. Confirm no
unexpected model dispatch, replay, hold release or accounting reset. Record the
actual destination, versions, retained/reset data (none reset), checks and cost
without replacing unknown costs with zero.

If verification fails, stop new admission. Keep the last verified encrypted
manifest and operator evidence. Do not delete the candidate's checkpoints or
repair an identity blindly. Use the retained previous artifact only after
checking archive/registry compatibility; a rollback is not permission to discard
new work or replay an ambiguous external action.

This runbook closes no product, security or storage gate by itself.
