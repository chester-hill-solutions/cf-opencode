# Stow workspace integration and resource adoption

Status: planned; source-level gap identified, no implementation or runtime verification.
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
