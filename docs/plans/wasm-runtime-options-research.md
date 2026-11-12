# WASM execution and persistent storage options

Research checked 2026-11-11. Scope: runtime feasibility for Aboiteau, using primary documentation and upstream source. This note records researched capabilities and proposed experiments; it does not report a deployed or benchmarked implementation. OpenCode compatibility and stow-s3 internals are covered by the companion investigation.

**Planning status — deferred.** The product owner chose to retain OpenCode in
Cloudflare Containers, stow-s3 and R2. No alternative-runtime prototype is scheduled.
The [roadmap runtime direction and revisit gate](../roadmap.md#runtime-direction--retain-the-current-stack)
supersede this note's earlier experiment recommendation. Reliability, isolation and
onboarding remain the priorities; comparisons below are retained as research.

## Finding

**A persistent WASM sandbox is feasible as an architecture. A Linux-compatible development machine entirely inside Cloudflare Workers is a separate, larger compatibility project.** Storage, execution isolation, and a POSIX/WASI interface are distinct pieces. A durable database does not automatically give a WASM guest a filesystem; the embedding must implement and authorize the filesystem operations exposed to it.

The most direct platform-native starting point is a trusted Durable Object supervisor plus Dynamic Workers running JavaScript and WASM, with explicitly scoped storage capabilities. Dynamic Workers accept WASM modules, and Durable Object Facets can give dynamically loaded classes a separate SQLite database. Those documented pieces establish a credible path to durable isolated workloads; they do not establish compatibility with arbitrary Linux commands. [Dynamic Workers quickstart](https://developers.cloudflare.com/dynamic-workers/getting-started/), [facet model](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/).

## Options and boundaries

| Option | Verified capability | Implication for Aboiteau |
| --- | --- | --- |
| Dynamic Worker + host capabilities | Loader supports JS, Python, and WASM modules. Custom service bindings can expose scoped application APIs. | Best first investigation for bounded tool execution and storage operations under the existing control plane. |
| Dynamic Worker + DO Facet | A supervisor instantiates dynamic DO classes with isolated SQLite storage. | Useful for generated applications or tools needing their own durable state. Still requires a guest filesystem adapter if POSIX access is needed. |
| Direct WASM + custom imports | Workers executes WASM; WASI support is explicitly experimental and partial. | Practical for individual compiled tools with a small import surface; a full shell ecosystem needs more host implementation. |
| Extism JavaScript SDK | Upstream explicitly supports Cloudflare Workers using the JavaScript host's WASM engine. | Candidate for bounded plugin functions with explicit storage host calls; not evidence of an OS-like process or POSIX environment. |
| Jco + WASI shims | Components can be transpiled to JS/core WASM; browser shim has injectable filesystem interfaces. | Useful interoperability/toolchain research; Cloudflare support and async filesystem compatibility need a concrete spike. |
| Wasmer JavaScript SDK | Executes WASIX packages in Node.js/browser through their WASM engines, without a Node native addon. Browser mode requires Web Workers and shared memory. | Browser compatibility does not establish Workers compatibility: Workers lacks the Web Worker/threading facility used by browser mode. |
| Wasmtime or WasmEdge | Native embedding/runtime options with host filesystem and system integration. | Plausible for a shared Linux/container host running many restricted WASM jobs, but not direct npm-style replacements for the managed Workers runtime. |

Sources: [loader languages](https://developers.cloudflare.com/dynamic-workers/getting-started/), [bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/), [facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/), [Workers WASM](https://developers.cloudflare.com/workers/runtime-apis/webassembly/), [Extism JS SDK](https://github.com/extism/js-sdk), [Jco](https://github.com/bytecodealliance/jco), [Wasmer JS SDK](https://docs.wasmer.io/runtime/js/), [Wasmtime platform support](https://docs.wasmtime.dev/stability-platform-support.html), [WasmEdge installation/platforms](https://wasmedge.org/docs/start/install/).

## Storage: persistent bytes versus a guest filesystem

Dynamic Worker custom bindings follow a capability model: the host defines methods, passes references, and can scope storage keys and inspect operations. Aboiteau could expose a workspace-scoped file API without exposing a bucket-wide credential or raw Durable Object namespace. This is an architectural inference from the documented binding model. A WASM guest would reach it through a deliberate import layer. [Custom capabilities and scoped storage](https://developers.cloudflare.com/dynamic-workers/usage/bindings/).

A facet has its own SQLite database, separate from the supervising DO's database, while remaining part of the overall DO. This makes it attractive for application state. It should not be confused with a shared workspace file tree visible to OpenCode and stow-s3; the storage mapping and authority would be our design. [Facet storage isolation](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/).

WASI filesystem APIs are the compatibility boundary. Cloudflare's referenced `workers-wasi` implementation includes an **ephemeral** littlefs filesystem and lists unsupported calls including directory enumeration, links, polling, and socket operations. It is not a ready durable agent filesystem. The broader Workers documentation also labels WASI experimental and partial. [workers-wasi README](https://github.com/cloudflare/workers-wasi), [WASI support status](https://developers.cloudflare.com/workers/runtime-apis/webassembly/).

For a proof of concept, a bounded workspace loaded into an in-memory guest filesystem, followed by an explicit write-set commit, avoids making every synchronous guest read depend on remote I/O. This is a proposal, not an upstream guarantee. The commit needs a base revision, conflict handling, atomic publication, and defined failure behavior. Otherwise concurrent container/WASM edits can silently overwrite each other.

## The async boundary matters

Core WASM and synchronous WASI/WIT functions require host imports to appear synchronous to the guest. A Promise returned by an ordinary JS host function is not sufficient. Wasmtime bridges async host functions with its native async execution machinery; that implementation is not automatically available in a V8 Worker. [Wasmtime async embedding](https://docs.wasmtime.dev/api/wasmtime/).

Emscripten documents Asyncify and JavaScript Promise Integration (JSPI) for suspending synchronous C/C++ execution around asynchronous JS operations. Asyncify changes compiled code; JSPI relies on engine features. These are possible mechanisms for storage fetches, not a verified Aboiteau solution. Check the deployed workerd compatibility version and actual guest imports before selecting one. [Emscripten async integration](https://emscripten.org/docs/porting/asyncify.html), [JSPI specification](https://webassembly.github.io/js-promise-integration/js-api/).

Jco transpilation offers a route from components to ES modules plus core WASM. Its Preview 2 browser shim supports in-memory filesystem adapters and replacement filesystem namespaces; persistence, permissions, synchronization, and external handles remain the embedding application's responsibility. `--instantiation=async` describes module instantiation and should not be treated as proof that every synchronous filesystem syscall can await remote storage. [Jco transpilation](https://github.com/bytecodealliance/jco/blob/main/docs/src/transpiling.md), [Preview 2 shim](https://github.com/bytecodealliance/jco/blob/main/packages/preview2-shim/README.md).

## Languages, tooling, and limits

Python execution on Workers is already a documented WASM use case: Python Workers run CPython compiled to WASM via Pyodide within V8. Dynamic Workers documents Python support as well. This establishes a language execution path, not arbitrary native Python extension compatibility or an automatically persistent shared workspace. [Python Workers internals](https://developers.cloudflare.com/workers/languages/python/how-python-workers-work/), [dynamic languages](https://developers.cloudflare.com/dynamic-workers/getting-started/).

Workers has no Web Worker API or WASM threading. Wasmer's browser execution uses Web Workers and `SharedArrayBuffer`, so its documented browser entrypoint cannot be assumed compatible with Workers. The Node entrypoint targets Node.js APIs and requires separate investigation. [Workers threading](https://developers.cloudflare.com/workers/runtime-apis/webassembly/), [Wasmer entrypoints](https://docs.wasmer.io/runtime/js/).

Wasmtime provides deterministic fuel and epoch interruption for guest compute. Blocking host I/O still needs host-level cancellation and timeouts. These are useful concepts if we build a native execution service, rather than capabilities that automatically transfer to a V8-hosted WASM instance. [Wasmtime interruption](https://docs.wasmtime.dev/examples-interrupting-wasm.html), [blocking host calls](https://docs.wasmtime.dev/api/wasmtime/struct.Config.html).

Dynamic Workers supports per-invocation CPU and subrequest limits; exceeding them raises an exception. Its documented concurrent dynamic-worker limits are four per ordinary Worker request and ten for a Durable Object's shared I/O context at the time checked. Design bounded jobs and admission around platform limits instead of equating lightweight instances with unlimited simultaneously running tasks. [Custom limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/), [concurrency limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/).

## Conditional experiment after the revisit gate

Only schedule this work after the roadmap's measured-need gate is met and a
baseline/target is recorded. Select the smallest backend that addresses that need;
the following WASM experiment is one option, not a current work item.

1. Execute one small, precompiled file-transform WASM tool in a Dynamic Worker. Record guest ABI, module hash, allowed imports, input/output limits, exit result, and tool duration.
2. Supply a bounded snapshot of a test workspace through an in-memory filesystem or a narrow custom storage import. Commit the resulting writes through a trusted workspace service.
3. Recreate the sandbox and confirm the committed file persists. Separately kill execution before commit and confirm partial work is not published as complete.
4. Attempt traversal, oversized writes, denied network access, and cross-workspace references. Validate storage capabilities independently of model permission prompts.
5. Run the same task via the Linux execution path and compare behavior, cold latency, total cost, and storage overhead. No benchmark claims should precede this measurement.
6. Only then add a shell/runtime and broaden the compatibility suite. Keep arbitrary binaries, native addons, watcher-heavy dev servers, and unsupported tooling on the existing Linux path until proven otherwise.

The proposed staged design preserves a credible path toward a fuller WASM environment while delivering useful bounded tool execution earlier.

## Open questions to resolve in code

- Which WASI/import ABI do the actual selected shell, Git, search, and language artifacts require? A `.wasm` extension does not establish compatible imports.
- Does deployed workerd expose the selected async suspension feature, and do cancellation/resource limits work across suspended host storage calls?
- What is the workspace authority when container and WASM execution coexist? A shared S3 protocol alone does not define coherent open-file, rename, or concurrent-write semantics.
- Is per-job preloading affordable for the real repository sizes and tool access patterns, or is a paged filesystem with async I/O necessary?
- Which jobs require persistent background processes rather than persistent files? Database/file persistence does not preserve an arbitrary suspended stack or process.
- Does the platform account have Dynamic Workers and facets enabled with the documented limits? Verify with a non-production spike before scheduling a product migration.
