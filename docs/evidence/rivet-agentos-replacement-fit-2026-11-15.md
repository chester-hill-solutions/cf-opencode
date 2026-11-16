# Rivet Actors and agentOS replacement fit

Research date: 2026-11-15. Primary-source inspection only; no deployment, workload benchmark, credentials or runtime calls. The canonical plan remains [the roadmap](../roadmap.md). Current documentation pages mostly report updates on November 14; the older [storage research](../plans/agentos-storage-research.md) is historical evidence, including its historical runtime pins and planning status.

## What Rivet provides

| Layer | Responsibility | Application responsibility |
| --- | --- | --- |
| Rivet Actors | Durable keyed coordination, SQLite, connections, scheduling and lifecycle | Agent logic, execution adapter, tool receipts and recovery policy |
| `@rivet-dev/agentos-core` | Embedded execution environment controlled by a trusted Node.js backend | VM identity, lifecycle, durable configuration/storage and host capabilities |
| Hosted agentOS | Prebuilt `agentOS` Actor, durable identity/versioned configuration, replayable output and expiring previews | Agent harness, model/provider policy and workload qualification |

These are separable layers: Actors documentation describes agentOS as an addition for agents needing files, processes, shells and networking. Hosted agentOS can run on Rivet Cloud or self-hosted Rivet Services; Core embeds without the control plane or Services. [Actors](https://rivet.dev/actors/docs/), [agentOS overview](https://rivet.dev/agentos/docs/), [hosted versus library](https://rivet.dev/agentos/docs/self-hosting/).

## Execution and compatibility

Core controls a **native sidecar**, which owns the virtual kernel, VFS, process/socket tables, permissions and executors. Guest code includes JavaScript, Python and WASM. The Rust/Tokio sidecar handles trusted I/O; guest JavaScript executes on admitted V8 executor threads, not a real guest Node.js OS process. This architecture supports investigating the user's preferred lightweight startup path; no upstream startup number is adopted as our measured result. [Architecture](https://rivet.dev/agentos/docs/architecture/), [executor topology](https://rivet.dev/agentos/docs/architecture/javascript-executor/).

The virtual kernel implements a focused POSIX/Linux surface. Software comes from a cross-compiled registry; arbitrary downloaded Linux binaries and `apt`/`yum` are unsupported. Full Linux workloads can use an external sandbox. Kernel modules, Docker and `inotify`/`fs.watch` are explicitly unavailable. Guest Node builtins use VM bridges or isolate implementations; `worker_threads` does not create real worker threads. **Therefore current OpenCode/Bun and native Stow compatibility is unverified, not implied by “Linux-compatible.”** Qualify the actual artifacts and operations before changing packaging or substituting implementations. [Limitations](https://rivet.dev/agentos/docs/limitations/), [Node compatibility](https://rivet.dev/agentos/docs/javascript-compatibility/).

## Persistence and workspace authority

Default roots are ephemeral overlays. Hosted durable roots and Core's SQLite-backed `chunked_sqlite` root preserve files across recreation; providing a database alone does not make Core's default root durable. Persisted filesystems survive recreation; **running processes, terminals, language contexts, open streams and subscriptions do not**. Durable hosted configuration and cron jobs survive sleep. These are filesystem/lifecycle guarantees, not memory checkpointing or exactly-once tool side effects. [Persistence and sleep](https://rivet.dev/agentos/docs/persistence/).

The S3 mount uses `chunked_s3`: chunked file contents plus separate metadata, not raw object keys interpreted as existing workspace files. Current source constructs `ChunkedFs` over an S3 block store under `<prefix>blocks/`, with SQLite or callback metadata. An S3-compatible Stow endpoint may supply object transport; this does not establish filesystem-format compatibility or shared workspace authority. A built-in `host_dir` mount offers a separate candidate for projecting an existing host-owned workspace. Both require write, snapshot, durability and concurrent-writer qualification. [Filesystem registry](https://rivet.dev/agentos/docs/registry/file-systems/), [current mount source](https://github.com/rivet-dev/agentos/blob/main/crates/native-sidecar/src/plugins/chunked_s3.rs).

## Self-hosting and license boundary

Current self-hosting consists of identical `rivetdev/engine` control-plane instances, one private persistent disk per instance, an object bucket, and SDK application nodes. Documentation recommends one instance for trials and at least three for production; it says there is no separate database or message bus. This supersedes assumptions about older deployment dependencies. Hosted agentOS additionally uses `rivetdev/services:0.2.5`; its Actor SQLite data is persisted by the control plane rather than the Services container. Rivet Cloud is not required by these documented paths. [Control plane](https://rivet.dev/docs/deploy/self-host/control-plane/), [Services](https://rivet.dev/docs/deploy/self-host/nodes/services/).

The inspected root licenses for both `rivet-dev/agentos` and `rivet-dev/rivet` are Apache-2.0; Core's package manifest also declares Apache-2.0. This is positive source-license evidence, not a completed license/SBOM audit of the shipped engine/Services images, bundled software and optional integrations. Exact image provenance and all required component terms remain an adoption gate before calling the complete deployment fully open source. [agentOS license](https://github.com/rivet-dev/agentos/blob/main/LICENSE), [Core manifest](https://github.com/rivet-dev/agentos/blob/main/packages/core/package.json), [Rivet license](https://github.com/rivet-dev/rivet/blob/main/LICENSE).

## Planning implication

The user's latest direction is to own the core. Rivet and agentOS are therefore **design references, not the selected controller or execution core**. Their separation of durable coordination, virtual-kernel execution, filesystem authority and host capabilities is useful evidence for our own durable kernel, scheduler and execution contracts. Our lightweight runtime workstream needs an explicit supported-workload boundary and feasibility proof; neither “Linux-compatible” nor S3 API support establishes current OpenCode/Stow compatibility. Qualify actual artifacts and the same committed bytes, then measure startup and recovery behavior. This research does not presume rewriting the agent loop.

For architectural comparison only, Actors can also coordinate a separately owned native Linux executor without agentOS; agentOS is not required to use Actors. That alternative still needs an execution provider, storage authority and lifecycle integration. No Rivet-based profile was runtime-qualified here.

The requested historical `architecture/agent-sessions/` URL returned 404 on this inspection; current architecture, persistence and self-hosting pages supply the verified lifecycle evidence above. No session guarantees were inferred from unavailable indexed content.
