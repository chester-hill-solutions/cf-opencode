# R1 design — agent boundary and tenant isolation

Status: partially implemented; isolation gate open · Updated: 2026-11-11 · Scope: R1 (tenancy foundations)
Related: `docs/roadmap.md` R1-1…R1-11, audit findings on agent credentials, control
plane, checkpoints and tenancy.

**Runtime direction — 2026-11-11:** retain OpenCode in Cloudflare Containers,
stow-s3 for the hot workspace and R2 for recovery. R1's credential and tenant
boundaries must be established on this stack. Runtime extraction in R1-4 does not
authorize migrating the harness into an isolate, adding a generic backend framework
or replacing storage. The [roadmap decision and revisit gate](../roadmap.md#runtime-direction--retain-the-current-stack)
defer alternative runtimes until measured startup, idle-cost or concurrency needs
justify investigation. AgentOS's scoped-capability and recovery concepts refine
the existing boundary work without adding a runtime dependency.

**Execution-service sequencing — 2026-11-11:** the
[delivery plan](../plans/execution-service-delivery.md) promotes caller-visible
turn identity, status, neutral questions/cancellation and public replay into
R1-4a–R1-4c before the admin console; protected runtime/event extraction follows
in R1-4d. R1-7a proves egress/credential feasibility early on disposable resources.
This changes sequencing, not the trust boundary below. A non-Slack reference
client must pass G1-C, and own-account external pilots still require G1.

This document covers **one question**: what exactly separates a tenant's agent from
the harness, from other tenants, and from credentials it should never see. It does
not repeat the release plan; ticket ids refer to `docs/roadmap.md`.

**Assessment update (Nov 11):** initial audit findings 29–33 and subsequent local repair
evidence are recorded in [the production audit](../production-audit.md#local-repair-verification--2026-11-11).
R0-10 retention/restore behavior is locally repaired and regression-tested; a fresh
real-container restore check remains open. R1-7 remains mandatory before executing untrusted
repository code; command permission patterns do not isolate credentials. Historical Nov 7
container results below were not rerun after these changes.

---

## 1. Current trust zones (what exists today)

```
Worker + Durable Object  ── trusted ──┐
        │  control port :4001 + token  │  container :4001 control server   (root)
        └────────────────────────────►│      └── /opencode/* proxy ──► :4000 OpenCode + tools (agent)
                                      │  /var/lib/aboiteau/state            (root:agent)
                                      └─ /workspace                        (repo + agent output, agent)
```

The current configuration selects **one container per conversation** under
`scheduling_policy: "durable_object"`, with a global lease cap (default two) and
onboarding exempt from that cap. There is still one global `Settings` DO, one shared
HTTP `API_TOKEN` and a default account snapshot; optional channel/agent namespaces
are only a partial tenancy implementation. The control
server runs as root and owns `CONTROL_TOKEN` and the OpenCode password; OpenCode,
its tools and stow-s3 run as `agent`. The agent can no longer read the control
server's environment, and `/workspace` no longer contains harness config or
credentials.

That is acceptable for a single trusted operator. It is not acceptable for the
multi-tenant target the product has chosen: the agent still reads
`/var/lib/aboiteau/state` (OpenCode needs its DB) and still inherits
`OPENCODE_PASSWORD`, so provider credentials and the OpenCode API remain inside
the sandbox until the egress proxy and secret-scrubbing spike land.

---

## 2. Threat model

**Assets**

- Tenant source code and workspace contents.
- Model provider credentials, GitHub tokens, Slack bot tokens, vault keys.
- Conversation transcripts, events and checkpoints.
- Harness control: container lifecycle, permission policy, repo/branch config.

**Actors**

- **Operator** — trusted; controls the deployment.
- **Tenant member** — authenticated through Slack channel membership or an API
  key; trusted to use their own tenant, not another tenant.
- **The agent** — *untrusted at runtime*. Prompt injection can make it run arbitrary
  shell commands, read files, fetch URLs and attempt self-approval.
- **Other tenants** — untrusted; may share the deployment.

**Assumptions**

- The Worker and Durable Objects are trusted.
- The container is untrusted once OpenCode is running.
- Slack signatures and channel membership are the Slack authorization boundary
  (already implemented).

**Non-goals for R1**

- Protecting a tenant from its own authorized members.
- Per-tenant arbitrary Dockerfiles.
- SOC 2 controls.

---

## 3. Target architecture

### 3.1 Filesystem layout

Move harness state **out of the agent's workspace**:

| Path | Owner | Contents | Checkpointed |
| --- | --- | --- | --- |
| `/workspace` | `agent` | Repo, agent output | Workspace archive |
| `/var/lib/aboiteau/state` | `root:agent`, `0770` | OpenCode config, data, DB | State archive |
| `/var/lib/aboiteau/run` | `root`, `0700` | Control token, pid/health files | No |
| `/tmp` | `agent` | Scratch | No |

- `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` point at
  `/var/lib/aboiteau/state`.
- The init marker moves to `/var/lib/aboiteau/state/initialized`.
- Repo checkout writes only `/workspace`; it can no longer overwrite harness config.
- The workspace archive excludes `node_modules`, `.stow` and anything outside
  `/workspace` by construction.

**Residual:** OpenCode and its tools run as the same `agent` user, so tools can
still read `state` (OpenCode needs write access to its DB). The fix is not file
permissions; it is keeping long-lived credentials out of `state` (see 3.4).

**Observed execution path (audit 32):** `bun test` and `bun run typecheck` are
default-allowed commands that execute repository-controlled code. A disposable Bun
test could read a synthetic sibling-state marker under the shared identity. Putting
state outside `/workspace` and denying its literal path in tool rules does not stop
that code from opening it. Keep initial use limited to trusted repositories until
the external credential boundary in §3.4 is verified in a real container.

### 3.2 Process model and control-plane auth

```
Durable Object ── bearer CONTROL_TOKEN ──► control server :4001 (root)
                                              │
                                              ├─ spawns OpenCode :4000 (agent)
                                              └─ proxies /opencode/* with OPENCODE_PASSWORD
```

1. The DO generates a random `CONTROL_TOKEN` per container start and passes it in
   `container.start({ env: { CONTROL_TOKEN } })` (`ContainerStartupOptions.env`).
2. `control-server.ts` rejects every route except `/health` without
   `Authorization: Bearer <CONTROL_TOKEN>`. The comparison is constant-time.
3. `startOpencode()` spawns OpenCode with an **allowlisted environment**, not
   `...process.env`. `CONTROL_TOKEN` is not included, so the agent's shell cannot
   read it and cannot call `/configure`, `/start`, `/restore`, `/seed-state`,
   `/checkpoint` or `/state-checkpoint`.
4. The control server proxies `/opencode/*` to `127.0.0.1:4000` with the OpenCode
   password. The DO no longer receives or stores the password; `/start` stops
   returning it.
5. OpenCode binds to `127.0.0.1` only. The container's port binding is the control
   server, not OpenCode.

**Dependency:** the token is only secret from the agent once OpenCode runs as a
non-root user. If both processes run as root, the agent can read
`/proc/<control-pid>/environ`. The user split (`control server = root`,
`OpenCode + tools = agent`) is part of P0b, not optional.

**Residual / open question:** OpenCode's own process environment still contains
`OPENCODE_PASSWORD`, and tools are its children, so a prompt-injected agent may
read it and call OpenCode's loopback API. The spike (§8.1) confirmed this:
OpenCode has no file/fd password option, `--stdio` only scrubs `process.env` but
not `/proc/<pid>/environ`, and tools cannot run as a different user. Do not rely
on OpenCode's API as an approval boundary; the egress proxy remains the
credential boundary, and high-risk actions should be denied rather than asked in
multi-tenant deployments.

### 3.3 Storage and checkpoint layout

Split the two archives and namespace them by tenant/conversation:

```
tenants/<tenantID>/account/state.tar.gz                      account seed (per tenant)
tenants/<tenantID>/conversations/<conversationID>/workspace/<ts>.tar.gz
tenants/<tenantID>/conversations/<conversationID>/state/<ts>.tar.gz
```

- A checkpoint is a **manifest** with both object keys and verified sizes. The DO
  proves both objects exist and match the uploaded size before advancing the
  fingerprint; encrypted archives are additionally authenticated end to end by
  AES-GCM, so tampering or truncation fails restore.
- `workspaceFingerprint` hashes git HEAD, status, diff and **ignored files** (or a
  manifest of the archive), so a turn that only touches ignored files still
  checkpoints.
- Restore writes the workspace archive to `/workspace` and the state archive to
  `/var/lib/aboiteau/state`, never across the two.
- Reset/delete removes both prefixes plus the manifest.
- Use the R1-1 target key layout directly for new supported state. Under the
  pre-customer hard-cut decision (2026-11-12), copy legacy keys only for named
  operator data to retain; no universal copy job or fallback reader is required.
- Until tenancy lands, the implemented keys are
  `workspaces/<DO id>/workspace-<ts>.tar.gz` and `state-<ts>.tar.gz`, with the
  manifest in DO storage.

**Locally verified repair (audit 29 / R0-10):** pruning now paginates and recognizes the
exact `workspace-<ts>.tar.gz` and `state-<ts>.tar.gz` basenames, retains the newest five
per class plus active manifest/legacy references, and serializes publication with pruning.
Restore fails before destructive restore/configure/start calls when a declared part is
missing; intentionally stateless and proven legacy restores remain supported. Local tests cover:

- Retention classifies actual object names and never deletes an object referenced by
  the active manifest, even when an unchanged part is older than five versions.
- A checkpoint reported successful remains a complete recovery point after pruning.
- Restore rejects a missing required part or selects a verified complete recovery point;
  it must not silently turn a split checkpoint into a workspace-only restore.
- Tests cover both unchanged-state and unchanged-workspace retention, pagination, old active
  references, unknown names, missing parts, and legacy cold restore. See `docs/testing.md`.
  Fresh real-container verification remains open.

### 3.4 Credentials and egress

The sandbox must not hold long-lived provider or git credentials.

- `enableInternet: false` by default. The container reaches an `EgressProxy`
  WorkerEntrypoint (R1-7).
- The proxy enforces a per-spec allowlist (model provider, GitHub, language
  package registries) and injects model/git credentials **outside** the sandbox.
- `webfetch` and `websearch` tools go through the proxy; direct internet access is
  denied.
- OpenCode authenticates to the model through the proxy with a short-lived,
  conversation-scoped token; the real provider key never enters the container.
- Git clone happens in the control server as root, with the GitHub token passed
  per command (`http.extraheader`), never written to `.git/config`. Agent-initiated
  pushes stay ask-gated and use a proxy-injected credential when R4 needs them.

### 3.5 Tenancy

**Tenant → Agent → Channel.** A tenant is a team (one self-hosted install to start).
A tenant owns one or more **agents**: named sandbox configurations (repo/branch,
model, permissions, egress allowlist, budget, image/size later). Each agent is
installed into one or more Slack channels or group DMs. A channel binding routes
messages to conversations owned by that agent; anyone in the channel may use the
agent and approve its permission requests.

- `tenants` (D1) records the team; `agents` records each agent's `tenant_id` and
  configuration; `channel_bindings` maps `(team_id, channel_id) → agent_id`.
- `Settings` becomes per agent: `env.SETTINGS.getByName("agent:<id>")`. The global
  singleton remains only as the legacy/admin instance during R1.
- `ACCOUNT_STATE_KEY` becomes `tenants/<id>/agents/<agentID>/account/state.tar.gz`.
- Conversation DO names become `tenant:<tenantID>:agent:<agentID>:<conversationKey>`.
  The thread/conversation key stays as it is today (`channel:thread` or `channel:ts`).
- Hashed, revocable API keys per tenant (R1-6), scoped to the tenant and optionally
  to one agent. The shared `API_TOKEN` becomes an operator-only token and stops
  working for tenant routes after the single cutover.
- Slack: `team_id` + `channel_id` resolve the agent; channel membership remains the
  approval boundary.
- R1 optimizes for **self-hosted per team**: one tenant per deployment by default.
  The same model is the foundation for managed multi-tenant hosting, where many
  tenants share a deployment.

**Implemented in this slice:**

- `migrations/0001_tenancy.sql` defines `tenants`, `agents` and
  `channel_bindings`.
- `src/tenancy.ts` resolves `(slack_team_id, channel_id) → agent`, formats
  conversation keys as `tenant:<tenantID>:agent:<agentID>:<legacyKey>`, parses
  them back, and derives the per-agent account-seed key
  `tenants/<tenantID>/agents/<agentID>/account/state.tar.gz`.
- Slack events resolve the channel binding before choosing the conversation DO;
  interactivity rejects a namespaced button whose channel is bound to a
  different agent.
- `Env.TENANCY` is **optional**. Without it, or for an unbound channel, routing
  stays on the legacy key. A namespaced conversation never falls back to the
  legacy global account seed. This unbound-channel fallback is transitional: R1-5
  strict mode fails closed instead, and any retained compatibility path is an
  explicit operator setting rather than an error fallback. Bind D1 and insert
  channel rows to activate:

  ```jsonc
  "d1_databases": [
    { "binding": "TENANCY", "database_name": "cf-opencode-tenancy", "database_id": "<id>" }
  ]
  ```

  ```bash
  wrangler d1 migrations apply cf-opencode-tenancy --remote
  ```

- Still open: per-agent `Settings`, per-tenant/agent API keys, per-agent
  onboarding into the namespaced account key, and strict mode that rejects
  unbound channels instead of falling back.

**Encryption:** workspace and state archives are encrypted with a tenant-scoped key
before they reach R2. The key is derived from the deployment's vault master key and
the tenant id, so a bucket leak does not expose credentials or source. Key rotation
follows the vault key.

**Agent layer is deliberately not a new runtime:** an agent is a configuration and a
set of bindings, not a separate process. One container still serves one conversation;
agents only decide which spec that container gets.

### 3.6 Credential storage and archive keys (CHS vault)

`@chester-hill-solutions/vault` is the credential authority. The origin implementation
(0.2.0) provides:

- HKDF-SHA256 per-workspace keys with the **master key as input keying material**, so
  changing the master key invalidates everything written under the old one.
- AES-256-GCM with a random 12-byte IV and a `v2:<keyRef>:<payload>` ciphertext.
- A keyring (`activeKeyId` + keys) for master-key rotation, `reencryptSecret` and
  `reencryptWorkspace`.
- `listSecretMetadata`, so a settings screen can show “configured, last changed”
  without decrypting anything.
- A ciphertext-only `VaultStore` interface plus in-memory and Postgres stores.

Where it fits:

| Need | Vault support |
| --- | --- |
| Tenant/agent provider and git credentials at rest | **Yes** — `Vault` over the DO key/value store, scoped by tenant or agent id. |
| Per-tenant archive key | **Yes, derivation only** — `deriveWorkspaceKey(master, tenantID)` gives the key. |
| Streaming workspace/state archive encryption | **Yes** — `src/archive-crypto.ts` frames a chunked AES-GCM stream; checkpoints and the account snapshot use it when `VAULT_MASTER_KEY` is set. |
| Master-key rotation | **Yes** for stored secrets; archive ciphertext carries the key reference, so rotation can re-wrap archives too. |
| Keep credentials out of the running sandbox | **No** — that is the user split + egress proxy. Vault is where the proxy reads them from. |

**Vendoring note:** cf-opencode previously vendored vault 0.1.0, whose
`deriveWorkspaceKey` ignored the master key (a different master decrypted the same
ciphertext). The vendored copy is now 0.2.0 with a driver-free `./core` entry and a
key/value store adapter, so the Worker does not pull Postgres/drizzle. Secrets
written by 0.1.0 cannot be read; they must be re-entered (the package refuses them
with an actionable error).

**Archive frame.** `src/archive-crypto.ts` writes `ABO1 | u32 chunkSize`, then
frames of `iv[12] | u32 finalFlag+length | ciphertext+tag`. Each frame authenticates
its chunk index as additional data; the final frame authenticates a sentinel, so
truncation, reordering or a dropped final marker all fail. Checkpoints store
`customMetadata.encrypted = "1"`; restore decrypts only when that marker is present,
and toggling encryption bypasses the dedupe fingerprint so the first encrypted
checkpoint is always a full archive. The key is
`deriveWorkspaceKey(master, workspaceID(env))` today; it becomes the tenant/agent id
when tenancy lands.

---

## 4. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | State lives outside `/workspace`. | Prevent checkout/restore from replacing state; this path split does not isolate state from repository code running as `agent`. |
| D2 | Control plane requires a per-start bearer token. | The agent can reach `:4001`; it must not be able to reconfigure or restore. |
| D3 | The DO never holds the OpenCode password. | Shrinks the secret's blast radius and removes it from Worker logs/memory. |
| D4 | Workspace and state checkpoint separately, with a manifest. | Restores stay correct, tenancy is namespaceable, and verification is possible. |
| D5 | Credentials live in the egress proxy, not the sandbox. | File permissions cannot separate OpenCode from its own tools. |
| D6 | One container per conversation under `durable_object`. | Tenancy without per-conversation isolation is not tenancy (roadmap R1-2/R1-3). |
| D7 | Tenant identity scopes settings, checkpoints, tokens and DO names. | Required for G1: no cross-tenant reads. |
| D8 | Slack approvals are authorized by channel membership. | Implemented 2026-11-07; any member of the channel may approve. |
| D9 | Tenancy is **tenant → agent → channel**. | Teams create multiple agents and install each into selected channels; membership controls access. |
| D10 | R1 optimizes for self-hosted per team. | Matches the commercial bet; the same model supports managed hosting later. |
| D11 | Tenant records live in D1. | Queries, limits and admin views are simpler; conversation state stays in DOs. |
| D12 | State archives are application-encrypted with a tenant-scoped key. | A bucket leak must not expose credentials or source. |
| D13 | Investigate OpenCode secret scrubbing before accepting the residual. | Evidence beats assumption for the self-approval risk. |

---

## 5. Concrete changes by area

### `control-server.ts`

Implemented in P0b:

- Reads `CONTROL_TOKEN`; rejects unauthenticated requests (constant-time compare).
- `STATE_ROOT` (`/var/lib/aboiteau/state`) owns XDG dirs; the marker is
  `STATE_ROOT/initialized`, outside the workspace.
- `/start` returns `{ ok }` only (no password).
- `/opencode/*` proxies to `127.0.0.1:4000` with basic auth; the DO uses it.
- Spawns OpenCode and stow through `setpriv --reuid/--regid` as `agent` (Bun
  ignores `uid`/`gid` on Linux); the control server is root.
- `/checkpoint?part=workspace|state&since=` returns one archive or `204`, with
  `x-aboiteau-checkpoint: split` on the workspace part.
- `/restore?part=workspace|state` validates members, stops the relevant
  processes and extracts each archive into its own root.
- `/seed-state`, `/state-checkpoint` operate on the state root.
- Archives are listed before extraction and rejected if any member is absolute
  or contains `..` (`src/tar.ts`).

Remaining:

- Pin the base image and OpenCode artifact by digest.
- Add a health response that reports token generation without leaking the token.

### `Dockerfile` / `entrypoint.sh`

- The image creates `agent`; `entrypoint.sh` exports the state XDG/HOME paths,
  keeps the state root `root:agent` `0770`, and gives its contents to `agent`
  (OpenCode must own its database to chmod it).
- The old `ENV HOME=/workspace/.state` and related XDG vars are gone.
- The base image is pinned by manifest-list digest, and OpenCode is installed
  from its npm tarball with the registry's sha512 integrity check (stow-s3 is
  already checksum-verified). The install script is no longer used.

### `src/conversation.ts`

Implemented in P0b:

- `startOptions()` passes `env: { CONTROL_TOKEN }`.
- OpenCode calls go through `opencodeViaControl`; the DO never stores a password.
- `checkpoint()` uploads workspace and state objects with a `checkpointManifest`
  (keys + verified sizes), keeps legacy single-object checkpoints readable, and
  bypasses dedupe when encryption toggles.
- `latestCheckpoint()` prefers the manifest and falls back to the legacy layout.
- Restore sends `part=workspace` and `part=state` separately.
- `onReset`/`onDelete` delete the conversation prefix, covering both parts.

### `src/settings-do.ts` / `src/index.ts`

- Settings DO lookup becomes tenant-scoped; `current()` reads `tenant:<id>`.
- API auth resolves a tenant from a hashed key; every DO stub is built with the
  tenant id.
- Slack event routing resolves `team_id` to a tenant before choosing the
  conversation DO.
- Admin routes (`/api/tenants`, `/api/specs`) are operator-only until R2.

### Tests

- **Container**: unauthenticated `:4001` → 401; token not present in OpenCode's
  environment; `.state` absent from `/workspace`; workspace archive excludes
  state; restore never crosses roots.
- **Worker**: tenant A cannot read tenant B's state, events, settings, checkpoint
  or account seed; a shared token no longer works for tenant routes.
- **Egress**: sandbox cannot reach an unlisted host; proxy injects model/git auth;
  no long-lived provider token is readable in the container.
- **Checkpoint**: manifest verification, ignored-file-only changes, two-archive
  restore, legacy fallback, retention beyond five updates with one part unchanged,
  active-reference protection, and missing-part restore rejection.
- **Repository execution**: run allowed test/typecheck commands that attempt to read
  synthetic provider state through code, not only direct tool paths; enforce the
  target credential boundary in the real container and egress proxy.

---

### P0 status

| Item | State |
| --- | --- |
| Per-start control token + constant-time auth | **Done** (static + container) |
| Curated OpenCode environment | **Done** (container) |
| Root → `agent` split; OpenCode binds loopback | **Done** (container, uid verified) |
| State moved out of `/workspace`; marker moved | **Done** (container) |
| `/opencode/*` proxy; DO holds no password | **Done** (static + container) |
| Split workspace/state checkpoints + manifest | **Locally verified repaired** — retention/preflight regressions pass; fresh real-container verification remains open |
| Restore member validation | **Done** (unit + container) |
| OpenCode secret-scrubbing spike | **Done — residual confirmed and documented (§8.1)** |

**Runtime validation (2026-11-07, `linux/arm64`).** The image builds and runs.
Verified in the container:

- `GET :4001/health` is open; every other control route is `401` without the
  token and `200` with it.
- OpenCode and stow-s3 run as uid/gid 1001; the control server runs as root.
- `CONTROL_TOKEN` is absent from OpenCode's environment, and the agent cannot
  read `/proc/1/environ` (permission denied).
- `/workspace/.state` is absent; state lives under `/var/lib/aboiteau/state`.
- Direct OpenCode `:4000` returns `401`; `/opencode/api/info` through the
  control server returns `200` and `401` without the token.
- Workspace and state archives are separate; the state archive carries a
  consistent `data/opencode/opencode.db` and no WAL/SHM files.
- Both parts restore to their own roots, ownership is correct, and OpenCode
  starts again.
- An archive containing `../escape` is rejected with `400`.

Three bugs only the runtime pass could find, all fixed:

1. **Bun ignores `uid`/`gid` on Linux.** A child spawned with uid 1001 still ran
   as root. The control server now uses
   `setpriv --reuid/--regid/--init-groups`.
2. **OpenCode v2 stores its DB at `$XDG_DATA_HOME/opencode/opencode.db`.** The
   old `.backup` path never matched, so archives carried a live WAL. The path is
   probed (v2 first, legacy second) and a failed backup now fails the checkpoint.
3. **State files must belong to `agent`.** OpenCode chmods its own database;
   restoring it as `root:agent` made `/start` fail with `EPERM`. The state root
   stays `root:agent` `0770`, but its contents are `agent:agent`.

Workers Builds (R0-1) is still the deployment blocker; this was a local image
build and container run, not a published image.

## 6. Migration phases

| Phase | Work | Roadmap |
| --- | --- | --- |
| P0 | Control token, curated OpenCode env, control proxy, state relocation, marker move | R1-2 prerequisite |
| P1 | R0-10 retention/restore correctness and stable checkpoint keys; conditional export only for named retained data | R1-1 |
| P2 | Verify deployed `durable_object` policy and per-conversation lifecycle already present in code/configuration | R1-2/R1-3 |
| P3 | Runtime extraction (`ContainerRuntime`, `EventStream`) | R1-4 |
| P4 | Tenant model, per-tenant settings/account/keys, DO names | R1-5/R1-6 |
| P5 | Egress proxy, credential injection, default-deny | R1-7 |
| P6 | Isolation tests + single cutover and backout | R1-9/R1-10 |

P3 is now delivered as the bounded R1-4 contract/client/extraction slices rather
than an extraction-only project. Design and disposable fixtures may proceed in
parallel, but broader rollout still requires G1. P5 starts with R1-7a's early
feasibility proof before the full tenant/onboarding schedule is committed.

P0's process/state split is implemented and P2 is present in code/configuration;
deployed cutover and isolation still need verification. R0-10 retention/restore fixes
pass local regressions, but deployed recovery verification and P1's target key
layout remain open. Legacy copying is conditional on data retention. P4/P5 require
verified P2 behavior, not just a configuration change.

**Pre-customer cutover:** select one supported version and update control calls,
clients, bindings and Slack URLs together. No dual-run or unauthenticated legacy
control path is required. Backout uses the previous image with a matching saved
recovery point, or an intentional reset of disposable test state; never assume an
old image can read incompatible new state. Name retained operator data before
any reset. This policy does not itself authorize deleting stored data.

---

## 7. Acceptance criteria (G1)

- Two tenants run concurrently in separate containers.
- A probe from tenant A cannot read tenant B's workspace, state, events, settings,
  checkpoints or account seed.
- Strict identity resolution fails closed for unknown/invalid bindings and resolver
  outages. It cannot select legacy/global settings or credentials after an error;
  legacy compatibility is optional and explicit if retained. Test the same scope for questions,
  permission decisions, cancellation, recovery and revoked API keys.
- No global `Settings` singleton in the request path; changing a spec restarts only
  that sandbox.
- Unauthenticated control-plane calls fail, and the agent cannot read the control
  token.
- The sandbox holds no long-lived provider or git credential; unlisted egress is
  denied. Repository-controlled test/typecheck probes cannot recover synthetic
  credentials through files, environment or process state.
- A checkpoint restore reproduces both the workspace and the OpenCode state, and a
  deleted object forces a re-archive before reuse or a visible restore failure.
- More than five updates to either part leave every active-manifest object intact;
  cold restore after retention preserves both roots.

---

## 8. Open questions

1. **OpenCode secret handling (spike) — resolved: residual confirmed.** OpenCode
   2.2.5 reads the server password only from `OPENCODE_PASSWORD` /
   `OPENCODE_SERVER_PASSWORD` (or the `--service` config file). It has no
   password-file or password-fd option; upstream issue
   [anomalyco/opencode#52156](https://github.com/anomalyco/opencode/issues/52156)
   tracks that feature and is still open.
   - `opencode serve --stdio` deletes the password from `process.env` before it
     spawns tools, so tools no longer see it with `env`. The initial environment
     block remains readable at `/proc/<server-pid>/environ` for the life of the
     process, and the agent runs as the same uid, so this is not a boundary. The
     upstream issue documents the same limitation.
   - `--service` reads the password from `service.json`, but tools run as the same
     uid and can read that file too.
   - Tools are children of the server and run as the same uid; there is no
     supported way to run them as a different user.
   - Confirmed in our image: the agent can read `OPENCODE_PASSWORD` from its own
     process environment, authenticate to the loopback API (`GET /api/session` →
     `200`), and reach `POST /api/session/{id}/permission/{id}/reply`
     (`404` for bogus ids means the route is authenticated and routed, not
     rejected).
   - **Decision:** accept and document the residual for single-tenant
     self-hosted. Do not rely on the OpenCode API as an approval boundary.
     Multi-tenant work must keep the egress proxy as the credential boundary and
     should either (a) adopt an upstream password-file/fd plus env scrub, (b)
     run tools as a different uid, or (c) deny — not ask — high-risk actions so
     there is nothing to self-approve. `--stdio` is not adopted now: it removes
     the easy `env` leak but not `/proc`, and it adds a stdin lease.
2. **Container egress mechanics.** Confirm the Container→WorkerEntrypoint path and
   whether `enableInternet: false` plus an HTTP proxy covers DNS, websockets and
   package managers.
3. **Tenant key origin.** Derive the archive key from `VAULT_MASTER_KEY` + tenant id,
   or store a separate per-tenant key in the Settings DO? Decide before P1
   encryption lands.
4. **Conversation scope in Slack.** Is a conversation a thread (current behaviour:
   `channel:thread`) or a whole channel? Threads keep parallel work separate; a
   whole channel is simpler for group DMs.
5. **Binding uniqueness.** Can several channels bind the same agent? (Proposed yes.)
   Can one channel bind several agents? (Proposed no; use a command or a second
   channel.)

---

## 9. Out of scope

- Billing, metering, admin console (R2/R3).
- Per-tenant images, sizes, network policy UI (R3).
- Git PR loop and previews (R4).
