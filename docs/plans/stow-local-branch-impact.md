# Active local Stow branch: implications for Aboiteau

Inspected read-only on 2026-11-12 UTC: `/Users/ladmin/WebProjects/stow`, branch `codex/npm-v0.3.7`, HEAD `68132194`, including uncommitted and untracked sources. This assessment concerns that working tree, not remote main or a released binary. No tests were run and no Stow files were modified. Existing recorded verification is identified separately below.

**Planning follow-up:** the user requested consumer work in both repositories.
[R0-15 integration and later resource adoption](stow-workspace-integration.md) now
owns Aboiteau's acceptance; Stow's canonical plan links its native consumer requirements
under W19/W20/W21 and W23–W26. This schedules no runtime migration and changes none
of the implementation or qualification statuses recorded in this assessment.

## What has actually changed

### Read-only access to a running workspace

**Implemented in new source:** `OpenWorkspaceReader` opens an existing registered workspace without taking its writer session or changing its manifest/index/identity. Read roots and bounded file/directory responses constrain exposure. [workspace_read.go:76](/Users/ladmin/WebProjects/stow/pkg/stow/workspace_read.go:76), [limits:20](/Users/ladmin/WebProjects/stow/pkg/stow/workspace_read.go:20).

A shared read attachment is acquired before workspace lookup. It coexists with the writer session and capture but makes removal/collection refuse while the reader holds the lease. This is native filesystem locking, not a distributed lease. [attachment.go:9](/Users/ladmin/WebProjects/stow/internal/storage/workspace/attachment.go:9). Test sources exercise coexistence, collection refusal, release after process death, and unsupported hosts. [attachment_test.go:41](/Users/ladmin/WebProjects/stow/internal/storage/workspace/attachment_test.go:41), [process-death test:160](/Users/ladmin/WebProjects/stow/internal/storage/workspace/attachment_test.go:160).

**Aboiteau benefit:** a file/artifact browser or another authorized client could inspect current files while OpenCode works. It would not have to obtain a shell or ask the model to print file contents. Integration must first establish a real registered workspace and enforce tenant scope at the access boundary.

### Stable directory observations and explicit file references

**Implemented:** `ObserveDirectory` collects bounded directory metadata, verifies the parent before returning, and retains a sorted observation. Paging verifies the current parent identity; the observation is metadata, not a frozen snapshot of file bytes. [workspace_read_observation.go:19](/Users/ladmin/WebProjects/stow/pkg/stow/workspace_read_observation.go:19), [paging:97](/Users/ladmin/WebProjects/stow/pkg/stow/workspace_read_observation.go:97).

The MCP host can expose live file resources or one checkpoint's file resources. CLI flags explicitly select `--workspace-files`, `--resources-only`, `--read-root`, and `--checkpoint-id`. [mcp.go:75](/Users/ladmin/WebProjects/stow/cmd/stow-s3/mcp.go:75), [reader selection:104](/Users/ladmin/WebProjects/stow/internal/mcpstorage/workspace_resources.go:104).

**Aboiteau benefit:** explicit references to selected output files, stable directory browsing, and a clear distinction between current working files and a saved view. A resource reference is useful product context; it is not sufficient authorization by itself.

### Guarded small-file editing foundation

**Implemented public read foundation:** `Workspace.OpenFileEditor`, `ReadForSave`, `ReleaseObservation`, and close. The owner requires `host_quiesced`, a single editor, and explicit write roots within read roots. Limits are 64 KiB/file, 64 retained observations, and at most five minutes. [workspace_editor.go:16](/Users/ladmin/WebProjects/stow/pkg/stow/workspace_editor.go:16), [admission:67](/Users/ladmin/WebProjects/stow/pkg/stow/workspace_editor.go:67).

`ReadForSave` retains digest, identity, mode, modification time, stored generation, metadata, path, and editor incarnation in an expiring observation token. [workspace_editor_read.go:25](/Users/ladmin/WebProjects/stow/pkg/stow/workspace_editor_read.go:25).

**Implemented private publication:** `publishFile` validates scope/basis then routes through the same owning runtime/store. It remains unexported. [workspace_editor_publication.go:17](/Users/ladmin/WebProjects/stow/pkg/stow/workspace_editor_publication.go:17). The store compares the observation and reports `not_committed`, `committed`, or `unknown`; ambiguous publication blocks further mutation in the current process. [path_save.go:35](/Users/ladmin/WebProjects/stow/internal/storage/workspace/path_save.go:35), [outcomes:140](/Users/ladmin/WebProjects/stow/internal/storage/workspace/path_save.go:140).

**In progress, not a ready public save API:** new journal sources define bounded request records and prepared/publishing/published/terminal phases, but the inspected public editor does not expose `SaveFile` or `ResolveSave`. The contract expressly leaves durable public save/resolve and recovery qualification proposed. [journal:17](/Users/ladmin/WebProjects/stow/internal/storage/workspace/path_save_journal.go:17), [contract status:3](/Users/ladmin/WebProjects/stow/docs/contracts/workspace-editing-contract.md:3).

**Critical fit constraint:** `host_quiesced` means the host must stop every writer outside the editor, including direct filesystem tools and S3 calls. Advisory locks do not fence arbitrary writers. [coordination contract:51](/Users/ladmin/WebProjects/stow/docs/contracts/workspace-editing-contract.md:51). Aboiteau cannot safely present this as collaborative editing alongside unrestricted live OpenCode shell writes. A useful first application is a bounded human edit while the agent is paused, after the public mutation/recovery surface is qualified.

## Checkpoints: product value and recovery limits

**New implemented saved-view reader:** `OpenCheckpointReader` binds workspace ID, checkpoint ID, manifest hash, expiry, and read roots, holding both workspace and checkpoint read attachments. [checkpoint_read.go:36](/Users/ladmin/WebProjects/stow/pkg/stow/checkpoint_read.go:36), [lease setup:134](/Users/ladmin/WebProjects/stow/pkg/stow/checkpoint_read.go:134). Bounds include 64 KiB response windows and 64 MiB whole-payload verification. Test sources cover saved/live divergence, corruption outside a requested range, expiry, cleanup exclusion, and portable-v2 views. [checkpoint_read_test.go:55](/Users/ladmin/WebProjects/stow/pkg/stow/checkpoint_read_test.go:55), [range test:113](/Users/ladmin/WebProjects/stow/pkg/stow/checkpoint_read_test.go:113).

**Existing capture/export strengthened by these readers:** checkpoints hold file paths, sizes, modes, and SHA-256 digests. Capture scans before/after and rejects observable changes; metadata and Git internals are excluded, with sensitive filenames excluded unless explicitly opted in. [checkpoint.go:33](/Users/ladmin/WebProjects/stow/pkg/stow/checkpoint.go:33), [capture contract:75](/Users/ladmin/WebProjects/stow/pkg/stow/checkpoint.go:75). Export is an archive operation with payload integrity checks, not a newly implemented cloud content store. [checkpoint_archive.go:65](/Users/ladmin/WebProjects/stow/pkg/stow/checkpoint_archive.go:65).

**Aboiteau opportunities:** named review points, inspecting “what the agent produced at this turn,” comparing saved vs current files, and attaching immutable result references. These can improve the user experience independently of replacing cold recovery.

**Not yet a replacement for our R2 recovery pair:** Stow project capture excludes `.git` and metadata; Aboiteau also needs coherent OpenCode session/SQLite state outside `/workspace`. Changing the workspace archive format requires an inventory of excluded files, restore ownership/modes, expected Git state, checkpoint pruning/read leases, encryption, R2 upload verification, and consistent publication of workspace plus OpenCode state. Native local checkpoint retention does not itself make data survive container destruction. The current tar/state recovery path should remain until end-to-end equivalence is demonstrated.

## What existing evidence establishes

- **C.1 recorded local qualification:** macOS ARM64 editor read observations; mutation, durable receipts, MCP editing, Linux, and cross-host qualification explicitly false. [workspace-editor-observations.json:18](/Users/ladmin/WebProjects/stow/docs/assessment-evidence/2026-11-11/workspace-editor-observations.json:18). Its default parallel gate did not pass; serialized verification and isolated diagnoses are recorded separately. [verification:41](/Users/ladmin/WebProjects/stow/docs/assessment-evidence/2026-11-11/workspace-editor-observations.json:41).
- **C.2 recorded qualification:** internal native publication/fault tests, not process-kill durable recovery or a public mutation API. [review:1](/Users/ladmin/WebProjects/stow/docs/reviews/2026-11-11-workspace-editor-publication.md:1), [limits:97](/Users/ladmin/WebProjects/stow/docs/reviews/2026-11-11-workspace-editor-publication.md:97).
- **Checkpoint recorded local profile:** stdio saved-file resources and same-machine export/adoption; Linux, cross-host, and fresh-model continuation explicitly false. [checkpoint-local.json:4](/Users/ladmin/WebProjects/stow/docs/assessment-evidence/2026-11-11/checkpoint-local.json:4).

These records refer to their saved source hashes and prior test runs. The active tree also contains subsequent untracked journal work and deleted generated distribution artifacts. This read-only assessment did not establish that the entire present working tree builds, passes those gates, or has been published.

## Integration prerequisite

**Highest-priority source-level gap:** Aboiteau starts `serve --data-dir /workspace/.stow --backend filesystem`, with `/workspace` only as its current directory. [startStow:166](/Users/ladmin/WebProjects/cf-opencode/control-server.ts:166). Stow's `serve` constructs `fs.NewFilesystemStore(dataDir)`, which is the object-record store; it does not open the surrounding directory as a registered Workspace. [main.go:117](/Users/ladmin/WebProjects/stow/cmd/stow-s3/main.go:117). Selecting `--backend workspace` on this command is explicitly refused. [backend validation:103](/Users/ladmin/WebProjects/stow/cmd/stow-s3/main.go:103). The “same bytes” workspace capability is real, but this startup does not select it.

Our workspace tar excludes `.stow`, so objects written only through this separate S3 store are absent from that R2 workspace archive. [checkpoint exclusion:790](/Users/ladmin/WebProjects/cf-opencode/control-server.ts:790). This conclusion concerns the shown tar recovery path, not a full-disk container snapshot.

Proper integration needs prepare/resume with a durable workspace ID and registry, followed by `workspace serve --id` and consuming its readiness endpoint/credentials. The command resumes an owning Workspace; the TS launcher uses a versioned readiness channel. [workspace_serve.go:53](/Users/ladmin/WebProjects/stow/cmd/stow-s3/workspace_serve.go:53), [workspace-serve.ts:30](/Users/ladmin/WebProjects/stow/packages/stow-s3/src/workspace-serve.ts:30). This is a lifecycle/restore integration, not a one-flag correction. The new reader/editor APIs require that registered identity. No fix, deployment, or release change was performed in this assessment.

The local changes improve the **native workspace management and resource layer**. They do not demonstrate a WASM POSIX filesystem, a Cloudflare storage adapter, or WASM execution support. Their most immediate product value is scoped browsing and saved-view references; managed editing is a later, coordinated integration.
