# R0-23 baseline fit — 2026-11-14

Source/API feasibility evidence for the canonical roadmap's comparison. This is
not a benchmark, a deployment receipt or another scheduling authority. No
packages were installed, credentials read, model calls made or live resources
created. Repository HEAD when inspected: `ec5f6b44f1457ab9b8bc7e600b169ac3e9c7d1b2`.

## Conclusion

The installed Agents SDK has the required OpenCode harness interface, but the
Workerd OpenCode host dependency is absent. A Linux tool adapter is also needed;
the published DO example's JavaScript Workspace is not a build/test shell.
Version/provider/tool equivalence must be established before an honest runtime
comparison. An implementation skeleton or simulated transport test cannot close
that fit check.

## Installed dependency and version facts

| Surface | Observed |
|---|---|
| Root `agents` | Exact `0.33.0`, installed and locked. Exports `agents/harness/opencode` and `agents/models/opencode`. |
| `@opencode/sdk` | No installed package at root or `runtime/opencode`; absent from both lockfiles. Importing `@opencode/sdk/workerd` requires an isolated dependency install and lock. |
| Agents' SDK expectations | Installed `agents/package.json` has optional peers `@opencode/sdk` and `@opencode/plugin` at `^2.0.24`; its own dev dependencies pin both to `2.0.24`. This is not proof of every later 2.x version working. |
| Existing native runtime | `@opencode/server`, schema/util and transitive plugin/core/AI are `2.2.5`; Effect is pinned to `4.0.6`. `@opencode/plugin` is transitive under `runtime/opencode`, not a root dependency. |
| Current upstream SDK source | Default `dev` branch package reports `2.3.0`; it must not be treated as an installed/tested `2.2.5` host. A same-version `2.2.5` SDK is a candidate only until package availability, lock, types and bundling are verified. |

Evidence: `package.json`, `bun.lock`, `node_modules/agents/package.json`,
`runtime/opencode/package.json`, `runtime/opencode/bun.lock`; inspected upstream
[SDK package](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/package.json)
blob `7d90452f20f03bbfeba33b37cf2f213f818f6ad2`.

## Exact usable harness shape

Installed declarations and implementation support this composition:

```ts
import { DurableObject } from "cloudflare:workers"
import { Lifecycle } from "agents/lifecycle"
import { OpenCodeHarness } from "agents/harness/opencode"
import { OpenCodeWorkerd } from "@opencode/sdk/workerd"

class Baseline extends DurableObject<Env> {
  readonly harness = new OpenCodeHarness({
    opencode: ({ storage }) => OpenCodeWorkerd.create({
      storage,
      config: { default_agent: "build" },
      models: { fetch: false },
      plugins: [/* pinned provider and Linux-tool plugins */],
    }),
    defaults: { model: { providerID: "pinned-provider", id: "pinned-model" }, agent: "build" },
  })
  readonly lifecycle = Lifecycle.install(this).use(this.harness)
}
```

This is an API shape, not executed code. The factory receives the harness's
prefixed SQLite storage; pass that storage rather than bypassing it with raw
`ctx.storage`. Use `submit(input, { operationId })` for a durable receipt,
`wait(operationId, { signal })` for completion, and `session(id).log({ after,
follow, signal })` for durable event replay. A cancelled wait stops the wait,
not execution. `abort()` withdraws queued input or requests interruption of the
run it joined. It is not a blanket proof of descendant process termination.

The installed `enqueue()` schedules the session wake before admission, derives
the OpenCode message ID from the operation ID, explicitly selects `queue` or
`steer`, and returns `accepted`. Host code still supplies authenticated routing,
resource ownership and experiment instrumentation. Lifecycle startup runs
automatically for its installed fetch/alarm handlers; native RPC entrypoints
must call `lifecycle.start()` because they bypass fetch.

The [official example](https://github.com/cloudflare/agents/blob/main/examples/next/harnesses/opencode/src/server.ts)
shows this composition, blob `79dad9cfeccf1d1617bac0cdb23e34e3083c2ac4`.

## Provider equivalence

`agents/models/opencode` exposes `createAI(settings)`, whose callable provider
registers Workers AI IDs, AI Gateway catalog IDs or dynamic routes as provider
`cloudflare`. It uses a bundled carrier package and replaces the AI SDK language
model through `ctx.aisdk.hook("language", ...)`; it does not simply proxy an
arbitrary Aboiteau provider reference. The implementation also adapts AI SDK V4
to V3 and drops V4-only parts. Equal-looking names across provider routes are not
evidence of equal model deployment, settings, protocol or token accounting.

The local native `providerProxyConfig` uses the bundled
`@opencode/ai/providers/openai-compatible` package with an internal base URL and
scoped proxy token. A fair provider route for the baseline needs the same
resolved upstream model and request settings, with credentials outside Linux.
Possible paths are a pinned bundled OpenCode provider definition or a bundled
provider/language plugin. Select and test one; do not silently substitute the
Workerd example's Workers AI model for the native runtime's default model.

**Version caveat:** current [OpenCode Workerd docs](https://opencode.ai/docs/build/sdk/cloudflare/)
show a custom `fetch` option, but installed `@opencode/server@2.2.5` Workerd
declarations expose only storage/app/password/config/models. The inspected
upstream SDK is newer. A Service Binding `fetch` override must be verified on the
actually installed SDK rather than copied from current docs into an older pin.
Code Mode's own `globalThis.fetch` is separately scoped in the current docs.

### 2.2.5-compatible in-process provider candidate

The installed source provides a route that does not need the newer `fetch`
option: provide an AI SDK language model from a bundled plugin. SDK/instance
plugins are installed after internal `pre` plugins and before internal `post`
plugins (`@opencode/core/dist/chunks/location-zjxfhs87.js:156-165`). The dynamic
SDK loader is a `post` plugin; its hook returns immediately if a previous hook
already populated `event.sdk` (`location-5m9w47nd.js:12-17`). The `aisdk:` package
prefix accepts a string identifier (`location-z3d87w74.js:338-343`). Thus a
bundled plugin can register its own provider, then supply the SDK before the npm
fallback. This is preferable to relying on a fictional bundled carrier package.

```ts
import { Plugin, Provider, Model } from "@opencode/plugin"

const providerID = Provider.ID.make("r0-23-in-process")
const modelID = Model.ID.make("synthetic")
const packageID = "aisdk:r0-23-in-process"
const plugin = Plugin.define({
  id: "r0-23.provider",
  async setup(ctx) {
    await ctx.provider.transform((editor) => editor.add({
      info: { id: providerID, name: "R0-23 synthetic", activation: "enabled", package: packageID },
      models: [{ ...Model.Info.default(providerID, modelID), package: packageID,
        limit: { context: 32768, output: 1024 } }],
    }))
    await ctx.aisdk.hook("sdk", (event) => {
      event.sdk = { languageModel: () => syntheticLanguageModelV3 }
    }, { providerID })
  },
})
```

`syntheticLanguageModelV3` must be a real `@ai-sdk/provider` LanguageModelV3
implementation: `specificationVersion: "v3"`, provider/model IDs, supported URLs,
`doGenerate` and `doStream`. It may emit a fixed tool call, consume its resulting
tool message and emit a fixed terminal response/usage, all inside the trusted
Worker. Reuse the same protocol events expected by the native fixture where
possible, and assert the request progression rather than returning a marker
without invoking the tool. This route was source-traced but not executed here;
the isolated pinned SDK must still compile, bundle and pass that wiring probe.

A real provider implementation behind this hook needs its own pinned V3 adapter
and the exact same upstream/model/settings as the other arm. The native arm's
bundled OpenCode provider and an AISDK model path are still a declared
product-default tool/provider-path difference, not a matched-orchestration
experiment. No provider-equivalence or performance conclusion follows from the
synthetic model.

## Linux tools and safety/recovery boundary

Installed `@opencode/server@2.2.5` Workerd replacements make local file reads,
listing, search and writes unavailable; process spawning, npm installs and PTY
are unavailable; VCS and snapshots degrade to no-op results. Merely attaching a
container does not redirect those built-in services.

The [example tool plugin](https://github.com/cloudflare/agents/blob/main/examples/next/harnesses/opencode/src/workspace.ts)
removes `read`, `write`, `edit`, `patch`, `glob`, `grep`, `shell` and adds
replacement tools through `ctx.tool.transform`. Its `options: { codemode: false }`
offers them by name. Plugin `execute(input, context)` receives a stable call ID,
session/message IDs and `AbortSignal`; the plugin API also has
`ctx.permission.assert(...)` to evaluate and wait for permission. Raw replacement
tool execution must not be assumed to inherit native tool authorization.
Inspected example blob: `8becea3dd80e12d0fdb8cdd0ac60ac28255d8898`.

A minimum separate Linux plane can use native
`ctx.container.exec(commandArray, { cwd, env, signal, stdin, stdout, stderr })`.
It returns a process with `pid`, streams, `exitCode`, `output()` and `kill(signal)`.
For an intentional shell tool, `['bash', '-lc', command]` is executable shell
input; file tools should use fixed handlers with data through stdin rather than
interpolating filenames/content into shell commands. Constrain real paths and
symlinks to the fixed disposable checkout, bound output/time/resources, and
record actual exit codes. Clean up only the experiment's owned container.

The installed Workers types expose these APIs, not their complete runtime
semantics. Passing an abort signal or killing the direct process does not prove
all descendants stop. A native process/descendant cancellation probe is needed
before claiming observed stop. Tools with external side effects need durable
call identity and an explicit ambiguous-outcome policy; never automatically
replay an arbitrary shell command merely because the DO restarted.

## Fairness and fit checks before runtime comparisons

1. Install/lock an exact SDK/plugin set in an isolated baseline package; typecheck
   and bundle under `workerd` conditions. Do not upgrade the production runtime
   or root dependencies merely to make the baseline compile.
2. Prove real model-free tool operations against a disposable native container:
   read/write/edit, shell/tests, binary/large output limits, path errors,
   cancellation, restart and owned-resource cleanup.
3. Verify one SDK turn with a synthetic provider that requests a tool and emits
   terminal usage. This establishes wiring, not real model effectiveness or
   billing accuracy. Then pin the actual common model route before paid runs.
4. Declare the comparison stratum: product-default end-to-end behavior permits
   documented tool/system-prompt differences; isolating orchestration requires
   matching those definitions/policies across both arms. A native toolset versus
   a different plugin toolset cannot isolate the effect of moving the loop.
5. Freeze recovery points and how container loss/DO eviction are injected.
   Native container snapshots, Aboiteau's portable archives and DO transcript
   replay must be scored for their actual guarantees, not called interchangeable.

## Inspected artifact identities and limits

SHA-256 of installed source/declarations:

| File | SHA-256 |
|---|---|
| `node_modules/agents/dist/harness/opencode/index.js` | `3696ac11cb2b5493866f306dd6ea9a2d5f060b439432c3fba4fdc5cd1ec3fd3b` |
| `node_modules/agents/dist/harness/opencode/index.d.ts` | `a64cd732ea70fe4a15f710744f7705f504562e92d622ddf2446fad7020deeba1` |
| `node_modules/agents/dist/models/opencode/index.js` | `3e8693301625e3a768dd384e28d45a8dcd88a8fef2dfee88a14218cae91ce3f6` |
| `node_modules/@cloudflare/workers-types/index.d.ts` | `808fa0d22d3f47ca36f75d468c35855a2c715853da334ce8aee11d971edd625a` |

Upstream SDK Workerd entrypoint blob
`d4a9aa623d1bf3481a164808725630ac468a753e`; internal profile blob
`13db7a0cc625a2ccd58118c183129bb268b5677d`, both on the inspected `dev` branch
reporting package version 2.3.0. Local plugin types came from installed 2.2.5.
These sources/declarations establish fit candidates, not a tested package pairing
or a completed Linux adapter. Provider equivalence, native tool behavior,
fault recovery and comparative outcomes remain open.

## Implemented follow-up

The isolated pairing is now installed and locked under
[`bench/comparison/baseline`](../../bench/comparison/README.md). Agents 0.33.0,
SDK/plugin 2.2.5 and provider types 3.0.8 typecheck and bundle together. Because
the installed 2.2.5 Workerd entrypoint lacks the inspected upstream 2.3.0 fetch
option, the fixed synthetic model uses the plugin's in-process AI SDK hook;
it does not imply equivalent real-provider routing.

The rebuilt Worker completed its five-tool synthetic cycle under local Workerd
with a simulated tool plane. The process adapter also passed local host tests
for file operations, path refusals, bounds and caller cancellation, including
unconfirmed process exit. The native template pins the qualified production
image but has not been deployed or exercised here. Local compatibility date is
2026-11-11; the native template is 2026-11-14. Source-loading through Vite failed
before assertions; the precompiled Worker smoke passed. No external provider
call ran. See the [preparation receipt](r0-23-preparation-2026-11-14.json) for
commands and limits. This improves the package-pairing evidence, not the native
tool/recovery or comparative-effectiveness evidence.

The v2 follow-up adds the general task plugin, a pinned OpenAI-compatible V3
provider adapter and durable effect/usage journal. Its local Workerd probe uses
the real provider request/parser code with mocked HTTP/SSE and simulated tools;
the native controller's missing-binding failure, immutable admission and cleanup
tombstone are also exercised. This is still no native or paid qualification.
[Commands and proof limits](r0-23-task-adapter-2026-11-14.json).
