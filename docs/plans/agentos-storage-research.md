# AgentOS and Stow storage research

Research date: 2026-11-12 UTC. Scope: concepts for Aboiteau and feasibility of isolated WASM execution with durable storage. This is source research, not a deployment or runtime compatibility certification.

**Planning status — retained research.** Keep OpenCode in Cloudflare Containers,
the current stow-s3 workspace and R2 checkpoints. No AgentOS adoption, WASM/storage
port or alternative-runtime experiment is scheduled. The
[roadmap runtime direction and revisit gate](../roadmap.md#runtime-direction--retain-the-current-stack)
take precedence over the possible architectures and qualification tasks below.
Use the applicable capability, recovery and resource-limit concepts in the existing
roadmap tickets; future execution adapters require a measured product need.

## Findings

**A durable WASM workspace is technically plausible, and Stow already supplies more of the object-storage bridge than its native server integration suggests.** The remaining work includes a Workers-compatible loader, a qualified durable adapter, and a filesystem/syscall layer for tools that expect POSIX files. AgentOS is evidence for this separation of concerns, but its current whole runtime is native software.

Source snapshots inspected through the GitHub connector:

- Stow: [`506b4ed09033430adffe092a7a2f41110866487d`](https://github.com/chester-hill-solutions/stow-s3/tree/506b4ed09033430adffe092a7a2f41110866487d).
- AgentOS: [`11ee7ada8bd43d59bb622f51ce1a1ab613a339f9`](https://github.com/rivet-dev/agentos/tree/11ee7ada8bd43d59bb622f51ce1a1ab613a339f9).

These are upstream main snapshots. Aboiteau's [Dockerfile](../../Dockerfile) pins native Stow `0.3.7` separately; the embedded APIs below must not be assumed to exist in, or be exercised by, that native integration. This research did not verify which image is deployed. Cached web pages returned older content in places; conclusions about current APIs use the pinned connector reads.

## Stow already has an asynchronous host-storage boundary

The pinned [`wasm-bridge.ts`](https://github.com/chester-hill-solutions/stow-s3/blob/506b4ed09033430adffe092a7a2f41110866487d/packages/stow-s3/src/wasm-bridge.ts) defines `HostObjectStoreBridge.call(metadata, data)` returning a promise of metadata plus binary data. `AsyncWasmBridge.openHost(metadata, store)` attaches such a store beneath the Go WASM runtime. This is substantially more useful for asynchronous platform storage than the older JSON/base64-only synchronous embedded interface.

[`AsyncEmbeddedStow`](https://github.com/chester-hill-solutions/stow-s3/blob/506b4ed09033430adffe092a7a2f41110866487d/packages/stow-s3/src/async-embedded.ts) exposes buckets, object operations, range reads, streams, conditional writes when supported, observation-based guarded saves, and resolution of durable save requests when advertised. It can attach a receipt from an already-open host-backed runtime, avoiding a second store. These are object operations: they do not constitute `open/read/write/seek/stat/rename/symlink` filesystem syscalls.

[`ContentObjectHost`](https://github.com/chester-hill-solutions/stow-s3/blob/506b4ed09033430adffe092a7a2f41110866487d/packages/stow-s3/src/content-object-host.ts) implements the callback bridge over a content store. It stages streamed content, publishes catalog records, bounds open streams, protects active reads, and serializes calls per store object. [`ContentAdapter`](https://github.com/chester-hill-solutions/stow-s3/blob/506b4ed09033430adffe092a7a2f41110866487d/packages/stow-s3/src/content-types.ts) separates immutable chunks and records from mutable generation-bearing heads, with staging, publication, protections, accounting, and collection methods.

**Design inference:** DO SQLite could own heads, catalogs, generations, and publication decisions while R2 holds immutable content chunks. Writing blobs first and advancing a transactional DO head only after successful writes would provide a candidate commit protocol. Its crash, orphan collection, duplicate-request, and uncertain-response semantics require explicit implementation and tests; the interface alone does not guarantee them.

## A `/worker` export does not certify Cloudflare Workers support

Stow's [`worker-host.ts`](https://github.com/chester-hill-solutions/stow-s3/blob/506b4ed09033430adffe092a7a2f41110866487d/packages/stow-s3/src/worker-host.ts) is a `postMessage`-based worker protocol. It bounds in-flight calls and bytes and explicitly reports that cancellation after dispatch can leave a mutation committed. Its name must not be interpreted as a ready Cloudflare adapter.

The current [`browser-wasm-host.ts`](https://github.com/chester-hill-solutions/stow-s3/blob/506b4ed09033430adffe092a7a2f41110866487d/packages/stow-s3/src/browser-wasm-host.ts) imports Go's JS runtime, fetches and instantiates a WASM artifact, and provides a browser `Worker` wrapper. A Cloudflare profile needs its own qualified loading and lifecycle path; browser success is not workerd proof.

Stow's own [ADR 0017](https://github.com/chester-hill-solutions/stow-s3/blob/506b4ed09033430adffe092a7a2f41110866487d/docs/adr/0017-workers-profile-qualifies-platform-objects.md) remains **proposed** and expressly ships no API, implements no profile, and certifies no deployment. It proposes DO identity/metadata and candidate R2 persistence while leaving execution caller-owned. Treat its platform measurements and limits as historical context that needs current platform verification, rather than Aboiteau capacity evidence.

## AgentOS's whole runtime is native

The [architecture](https://rivet.dev/agentos/docs/architecture/) assigns the trusted native sidecar the virtual kernel, VFS, processes, sockets, permissions, resource policy, and language execution. Its protocol uses OS file descriptors. Source confirms [`agentos-runtime`](https://github.com/rivet-dev/agentos/blob/11ee7ada8bd43d59bb622f51ce1a1ab613a339f9/crates/runtime/Cargo.toml) uses Tokio's multithreaded runtime and networking, while [`agentos-v8-runtime`](https://github.com/rivet-dev/agentos/blob/11ee7ada8bd43d59bb622f51ce1a1ab613a339f9/crates/v8-runtime/Cargo.toml) links native V8 and libc. The [workspace manifest](https://github.com/rivet-dev/agentos/blob/11ee7ada8bd43d59bb622f51ce1a1ab613a339f9/Cargo.toml) explicitly leaves browser support disabled in ordinary builds during the native reactor work.

**Conclusion:** there is no demonstrated path to importing the current whole AgentOS kernel into workerd as one WASM module. Its WASM guests and reusable ideas are distinct from its native host implementation. The inspected execution stack uses V8; this research found no basis to describe it as a Wasmtime-hosted product.

AgentOS tools use `wasip1` plus custom process/user/network imports and a kernel-backed WASI shim. A generic WASI filesystem adapter is therefore insufficient to execute every AgentOS binary unchanged: process spawning and sockets require their additional ABI. [POSIX syscall architecture](https://rivet.dev/agentos/docs/architecture/posix-syscalls/).

## S3 compatibility is not filesystem-format compatibility

The actual [`chunked_s3` mount plugin](https://github.com/rivet-dev/agentos/blob/11ee7ada8bd43d59bb622f51ce1a1ab613a339f9/crates/native-sidecar/src/plugins/chunked_s3.rs) constructs a `ChunkedFs` with separate metadata storage and an S3 block store under `<prefix>blocks/`. Metadata is SQLite or a host callback; the plugin does not mount arbitrary pre-existing object keys as raw files. Its filesystem implements rename, links, and other operations through its metadata engine. [Chunked filesystem source](https://github.com/rivet-dev/agentos/blob/11ee7ada8bd43d59bb622f51ce1a1ab613a339f9/crates/vfs/src/engine/engines/chunked.rs).

AgentOS also has an [`S3ObjectBackend`](https://github.com/rivet-dev/agentos/blob/11ee7ada8bd43d59bb622f51ce1a1ab613a339f9/crates/vfs-store/src/s3/object_backend.rs) that stores `vfs-*` metadata. Its existence does not make it the selected `chunked_s3` plugin or establish compatibility with Stow's directory-backed workspace. Stow can potentially provide the S3 transport for a block store, but that would place AgentOS blocks in Stow; it would not automatically share the ordinary `/workspace` file representation.

## Concepts to carry into our implementation

1. **One storage authority, several execution adapters.** Keep object content and workspace identity independent of guest lifetime. Both native and WASM tools should commit through the same authority.
2. **Capability-confined filesystem access.** Route every guest operation through a scoped VFS. A WASI preopen grants a subtree, not the host disk. AgentOS applies its VFS to both JS and WASM executors. [Filesystem architecture](https://rivet.dev/agentos/docs/architecture/filesystem/).
3. **Separate metadata from immutable bytes.** This enables small transactional namespace updates, versioned views, and sharing unchanged chunks. Our exact durability guarantees need conformance testing.
4. **Explicit interrupted and uncertain outcomes.** Distinguish a cancelled observation from confirmed command termination, and a lost write response from a confirmed failed write. Stow's worker error and guarded-save APIs already provide useful models.
5. **Bound every interface.** Apply byte limits, stream limits, range reads, cursors, and a reserved cleanup lane. This matters more in a memory-constrained isolate than merely making tools start quickly.

## Qualification work before a full WASM product claim

- Instantiate the pinned Go WASM artifact in workerd through a supported loader and measure startup, memory, CPU, and bundle size with a realistic workspace.
- Implement and verify a DO/R2 `ContentAdapter` or a narrower host bridge; prove committed bytes survive object eviction and container absence.
- Define a VFS contract for directories, executable bits, symlinks, hard links if required, file descriptors, partial writes, truncation, atomic rename, and `fsync` meaning. Object put/get/list alone does not provide this.
- Choose the asynchronous syscall strategy for WASM guests: preloaded working sets, suspension-capable execution, or an async/component ABI. A synchronous WASI import cannot simply return an asynchronous R2 promise.
- Fence writers by workspace identity/generation; test concurrent saves, stale handles, retry after lost response, multi-file publication, and cleanup races.
- Prove no guest can access storage bindings, secrets, another tenant, or unauthorized egress through supplied host imports.
- Run a supported-tool workload matrix. Native OpenCode/Bun/Go binaries are not made WASM-compatible by adding storage.

No code integration, dependency change, deployment, or benchmark was performed for this note.
