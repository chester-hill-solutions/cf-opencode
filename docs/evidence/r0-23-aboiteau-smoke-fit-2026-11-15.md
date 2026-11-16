> Superseded implementation detail: the first live smoke proved that a proxied
> DurableObjectState is rejected by DurableObjectBase. The corrected staging arm
> passes the original state and wraps only the runtime container view through a
> protected seam. The four failed cells and original source remain retained in
> [live evidence](r0-23-live-2026-11-15-03.json) and the
> [v6 archive](r0-23-v6-source-2026-11-15.tar.gz).

# R0-23 Aboiteau smoke implementation fit — 2026-11-15

Read-only source/API investigation at repository commit
`ec5f6b44f1457ab9b8bc7e600b169ac3e9c7d1b2`. No credentials were read, provider
calls made, resources deployed or product code changed for this investigation.
This is an implementation recommendation, **not a runtime qualification**.

## Recommended arm

Deploy a disposable Worker importing the actual `Conversation` and `Settings`
classes, with new DO namespaces and a new empty R2 checkpoint bucket. Use the
frozen digest-pinned evented image and the same native instance shape as the
baseline. A thin benchmark-only `Conversation` subclass can supply a native
Container facade through its constructor's `DurableObjectState`. The facade
must preserve native lifecycle behavior and modify only network restrictions,
provider configuration and frozen-fixture preparation. `Settings` can be
exported directly; no copied orchestration or Settings subclass is necessary.

Keep `Conversation.transport` and `CONTAINER_URL` unset. Those shortcuts bypass
native startup and disable native lease enforcement, so they are a weaker fit
for this comparison. Do not start the native container before delegating to
`Conversation.fetch`: `rawPort` skips `startContainer()` when it is already
running, bypassing its token/lease-before-start path. Actual startup acquires
the Settings lease, starts the image, proves control/OpenCode readiness, creates
the session and uses the existing dispatch, durable events, accounting,
checkpoint and recovery machinery.

Source: [Conversation constructor and native startup](https://github.com/chester-hill-solutions/cf-opencode/blob/ec5f6b44f1457ab9b8bc7e600b169ac3e9c7d1b2/src/conversation.ts),
[runtime rawPort/start/stop](https://github.com/chester-hill-solutions/cf-opencode/blob/ec5f6b44f1457ab9b8bc7e600b169ac3e9c7d1b2/src/conversation/runtime.ts),
[session creation](https://github.com/chester-hill-solutions/cf-opencode/blob/ec5f6b44f1457ab9b8bc7e600b169ac3e9c7d1b2/src/conversation/sessions.ts).

## Exact benchmark extensions

The following facade is a source-supported composition candidate, not an
already tested adapter. A native-object `Proxy` must read getters with the
native object as receiver and bind delegated methods to that native object.
Do the same for any wrapped DO state methods; spreading a native state object
loses prototype methods. Qualify this in the isolated Worker before a paid run.

| Extension | Exact behavior |
|---|---|
| Constructor | Pass a facade of the real state to `super`, replacing only its `container` view. Preserve `id`, `storage`, lifecycle callbacks and all native methods. |
| `container.start(options)` | Delegate to the real container with the original image, entrypoint, env, instance and lifecycle, overriding only `enableInternet:false`. Keep the real root control-server entrypoint, not the baseline's `sleep infinity`. |
| Native interception | Await `interceptOutboundHttp("provider.aboiteau", trustedEntrypoint)` before the first delegated fetch/alarm can start Linux. Reinstall/verify on DO reconstruction. Give the entrypoint an attempt-scoped nonsecret grant, never the provider key in props or Linux. |
| `getTcpPort(4001).fetch` after `/configure` | Await a successful real response, then merge the nonsecret provider overlay below into `/var/lib/aboiteau/state/config/opencode/opencode.json` using trusted native exec. Preserve existing permissions/model/accounting settings. Failure blocks readiness. |
| `getTcpPort(4001).fetch` after `/start` | Await the real success/proof; before returning it to Conversation, materialize only frozen public fixture base files, deterministic Git identity/commit and the attempt marker. Verify fixture hashes and ownership. Never include reference repairs or oracle tests. |
| Repeat `/start` | Verify an existing matching attempt marker/fixture identity instead of resetting edited files. The control endpoint is called for warm readiness as well. Refuse a different attempt; a crash mid-setup needs explicit setup recovery, not silent reseeding. |
| Runner | Send the prompt via actual `POST /message` with `idempotencyKey`; observe actual state/events/accounting through private disposable routing. Do not call the SDK session prompt directly and call that Conversation orchestration. |

The launch-options seam already exists as protected `startOptions()`, but the
constructor currently wires runtime `options: () => this.images.startOptions()`
directly. **A subclass override currently has no effect.** Likewise constructor
snapshot callbacks bypass the corresponding protected methods. If a small
product seam change is acceptable later, delegating to those protected methods
and adding an explicit awaited preparation hook around readiness is clearer
than a native-state facade. The facade avoids product changes for this smoke;
it still requires a runtime fit check for native object branding/delegation.

Sources: `src/conversation.ts:122–137, 505, 981–1022, 1226`,
`src/conversation/runtime.ts:242–294`, `src/conversation/readiness.ts:209–241`;
the [Cloudflare native API](https://developers.cloudflare.com/containers/api/durable-object-container/)
documents start, native exec and outbound intercepts. Uncovered network traffic
remains reachable with `enableInternet:true`; HTTP interception does not cover
HTTPS. The proposed internal HTTP route avoids needing Linux to trust the
Cloudflare interception CA. The Worker-to-provider connection remains HTTPS.

## Workspace startup trap

`prepareWorkspaceIdentity()` refuses a nonempty `/workspace` with no native
identity. Therefore do **not** run the baseline fixture installer into the
workspace before the first real `/start`. Let `/start` establish the empty
native Stow workspace first; then load fixtures before returning that successful
response to Conversation. `ConversationSessions.ensure()` next creates its
session at **`/workspace`**. The baseline currently uses `/workspace/r0-23`, so
choose and record the path difference explicitly, or place the task files at
`/workspace` for this actual-product arm. Stow's `.stow` metadata is legitimate
workspace infrastructure: exclude it from exported task-file snapshots without
deleting or recursively changing its ownership.

Leave `WORKSPACE_REPO` empty in this isolated Env. `defaultSettings` accepts the
empty default; public Settings `/put` validation requires an HTTP URL, so do
not use a bogus repository URL just to configure the model. `/configure` sets
the internal repository only for a truthy value, and `/start` clones only when
uninitialized and a repository is set. A fresh Worker/bucket avoids restored
workspace state and account seeds. Fixture installation after successful start
is explicit benchmark setup overhead and must be recorded separately if cold
startup timing is reported.

Sources: [control server](https://github.com/chester-hill-solutions/cf-opencode/blob/ec5f6b44f1457ab9b8bc7e600b169ac3e9c7d1b2/control-server.ts)
`prepareWorkspaceIdentity` at 257, `startRuntime` at 783, `/configure` at 1068;
`src/settings.ts:99–120, 151+`; `src/conversation/sessions.ts:64–69`.

## Same paid model, key outside Linux

The installed 2.2.5 catalog's `opencode/deepseek-v4.1-flash` entry routes to
`https://opencode.ai/inference/openai/v1/chat/completions`, using native package
`@opencode/ai/providers/openai-compatible` with `reasoning_content`
compatibility. Current official [OpenCode model documentation](https://opencode.ai/docs/console/models/)
agrees; `/docs/zen/` redirects there. Do not assume the old `/zen/v1` route or
reuse this repo's fixed OpenAI egress as though it routes to OpenCode Console.

Merge this shape after real `/configure`, before real `/start` loads config:

```ts
{
  providers: {
    opencode: {
      settings: {
        apiKey: attemptScopedNonsecretGrant,
        baseURL: "http://provider.aboiteau/v1"
      },
      models: {
        "deepseek-v4.1-flash": {
          settings: { baseURL: "http://provider.aboiteau/v1" }
        }
      }
    }
  }
}
```

Keep the selected model `opencode/deepseek-v4.1-flash`. The overlay retains its
installed model metadata/compatibility rather than creating an unrelated
provider. Set **both** provider and model settings: catalog model-level
`baseURL` can otherwise win. A nonempty config API key activates the paid model
without registering a credential/OAuth integration. The trusted intercept must
validate the grant, exact URL/path/method, model, bounded body, expiry,
per-attempt call/token/time limits and global remaining budget; strip all
Linux-controlled authorization/headers; inject the real key only into a newly
constructed fixed HTTPS request; reject redirects. Enforce selected output and
temperature settings there if no exact native config parity has been verified.
Record the actual outbound settings and any rewrite as an arm difference.

The existing `providerProxyConfig()` creates a different `aboiteau-proxy`
provider with a 1024-token output limit, and `proxyProviderRequest()` fixes the
upstream to `https://api.openai.com/v1/chat/completions`. Reuse their validation
patterns, not their unmodified destination or claimed equivalence.

Sources: installed `runtime/opencode/node_modules/@opencode/core/dist/chunks/`
`location-e8xs0hrs.js` catalog (parsed specifically at `opencode.models`, not a
different provider with the same model name), `location-jzy5v0rq.js:153–217`
config provider/model overlays, `location-p6asq4h2.js:249–275` paid-key gate;
[provider config](https://github.com/chester-hill-solutions/cf-opencode/blob/ec5f6b44f1457ab9b8bc7e600b169ac3e9c7d1b2/src/provider-proxy-config.ts)
and [fixed egress](https://github.com/chester-hill-solutions/cf-opencode/blob/ec5f6b44f1457ab9b8bc7e600b169ac3e9c7d1b2/src/provider-egress.ts).

## Configuration and sync pitfalls

- `control-server.writeOpencodeConfig()` replaces the user config with model
  and permissions; arbitrary `providers` sent to `/configure` are ignored.
  Installing an overlay before `/configure` loses it. Reapply only when actual
  configuration runs, preserving task edits on ordinary warm readiness.
- `buildOpencodeEnv()` intentionally allowlists child env and replaces
  `OPENCODE_CONFIG_CONTENT` with the accounting policy. Passing provider keys,
  model-fetch flags or provider config through container env does not make them
  appear in the child. Keep this restriction intact.
- `Settings.onboarding.opencodeConnectedAt` must stay absent. With a truthy
  timestamp, legacy non-onboarding conversation keys can sync credentials from
  the special onboarding conversation. No onboarding conversation/account
  seed/provider connection is needed for the config-placeholder path.
- Configure `EVENTED_FRESH_CONVERSATIONS:"true"` and avoid arbitrary extra
  Conversation storage keys before first image selection. Freshness checks
  enumerate allowed keys. Prefer the existing workspace attempt marker or
  separate benchmark coordinator journal, rather than pre-populating product
  DO state with benchmark rows. Both base and evented named images should point
  at the pinned tested image if both are configured; record that choice.
- Use only new namespaces/bucket and no Slack, GitHub, TENANCY or production
  bindings. If portable checkpoints are required with no vault key, this repo
  requires explicit `ALLOW_PLAINTEXT_ARCHIVES:"1"`; the empty bucket will then
  contain public fixtures and nonsecret placeholders, not account credentials.
- Product `dailyBudgetUSD` is not an atomic maximum provider spend. Enforce the
  four-attempt/$5 envelope in the trusted intercept/coordinator, with in-flight
  worst-case reservations. Unknown provider usage must remain unknown and
  consume its reservation until reconciled.

Sources: `control-server.ts:449–491, 1068–1082`,
[readiness](https://github.com/chester-hill-solutions/cf-opencode/blob/ec5f6b44f1457ab9b8bc7e600b169ac3e9c7d1b2/src/conversation/readiness.ts):98–101,
130–218, 267–275; `src/conversation/images.ts:82–180`; `src/env.ts`.

## What remains to qualify

1. Type/local-check the native facade; demonstrate that actual Conversation
   cold startup acquires/releases the isolated Settings lease and retains its
   control token, event-persistence proof and accounting policy.
2. Run one non-provider setup probe: empty workspace starts; fixture writes
   follow native identity creation; repeat `/start` preserves modifications;
   effective model points only at the internal intercept. Provider-denial
   probes must show HTTPS/direct-IP fallback cannot escape Linux.
3. Demonstrate fixture export excluding `.stow`, native stop/destroy confirmation
   and explicit cleanup receipts. An aborted HTTP wait or terminal assistant
   message does not prove descendant quiescence. Preserve unresolved spend or
   execution evidence instead of clearing storage to make cleanup look clean.
4. Only then run the authorized paid smoke. Describe it as product-default
   end-to-end orchestration with disclosed tool, prompt, workspace and config
   differences. This does not qualify matched-orchestration equivalence, the
   full diagnostic suite, recovery/fault performance or G0 workload fitness.

No source/API blocker requires copying the Conversation state machine. The
remaining concrete blocker is qualification of the thin benchmark adapter and
effective provider/config/fixture boundary. If the state facade is rejected by
the runtime, add small explicit lifecycle hooks in product source with focused
validation; do not silently fall back to a separate hand-written session loop.
