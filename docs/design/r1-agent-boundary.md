# R1 design — agent boundary and tenant isolation

Status: proposed · Date: 2026-11-07 · Scope: R1 (tenancy foundations)
Related: `docs/roadmap.md` R1-1…R1-11, audit findings on agent credentials, control
plane, checkpoints and tenancy.

This document covers **one question**: what exactly separates a tenant's agent from
the harness, from other tenants, and from credentials it should never see. It does
not repeat the release plan; ticket ids refer to `docs/roadmap.md`.

---

## 1. Current trust zones (what exists today)

```
Worker + Durable Object  ── trusted ──┐
        │  control port :4001 + token  │  container :4001 control server   (root)
        └────────────────────────────►│      └── /opencode/* proxy ──► :4000 OpenCode + tools (agent)
                                      │  /var/lib/aboiteau/state            (root:agent)
                                      └─ /workspace                        (repo + agent output, agent)
```

Everything runs in **one container per deployment** (`max_instances: 1`), with one
global `Settings` DO, one shared `API_TOKEN` and one account snapshot. The control
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
read it and call OpenCode's loopback API. That matters if the OpenCode API can
approve its own permission requests. Options: (a) find an OpenCode bootstrap that
reads the secret from a file or fd and scrubs it before tools; (b) run OpenCode as
a different user from tools; (c) disable API-based permission decisions and route
all approvals through the harness. Until one is proven, document self-approval
through the local API as a known residual and keep the egress proxy as the
credential boundary.

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
- Existing keys (`workspaces/<DO id>/…`) are migrated by R1-1; the legacy key is
  read-only until the copy job completes.
- Until tenancy lands, the implemented keys are
  `workspaces/<DO id>/workspace-<ts>.tar.gz` and `state-<ts>.tar.gz`, with the
  manifest in DO storage.

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
  working for tenant routes after dual-run.
- Slack: `team_id` + `channel_id` resolve the agent; channel membership remains the
  approval boundary.
- R1 optimizes for **self-hosted per team**: one tenant per deployment by default.
  The same model is the foundation for managed multi-tenant hosting, where many
  tenants share a deployment.

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
| D1 | State lives outside `/workspace`. | The repo must never be able to overwrite harness config or credentials. |
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
- Remaining: pin the base image by digest and verify the OpenCode artifact
  (stow-s3 is already checksum-verified).

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
  restore, legacy fallback.

---

### P0 status

| Item | State |
| --- | --- |
| Per-start control token + constant-time auth | **Done** (static + container) |
| Curated OpenCode environment | **Done** (container) |
| Root → `agent` split; OpenCode binds loopback | **Done** (container, uid verified) |
| State moved out of `/workspace`; marker moved | **Done** (container) |
| `/opencode/*` proxy; DO holds no password | **Done** (static + container) |
| Split workspace/state checkpoints + manifest | **Done** (vitest + container) |
| Restore member validation | **Done** (unit + container) |
| OpenCode secret-scrubbing spike | **Open** |

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
| P1 | Stable checkpoint keys, manifest layout, copy job for existing checkpoints | R1-1 |
| P2 | `durable_object` policy, per-conversation containers | R1-2/R1-3 |
| P3 | Runtime extraction (`ContainerRuntime`, `EventStream`) | R1-4 |
| P4 | Tenant model, per-tenant settings/account/keys, DO names | R1-5/R1-6 |
| P5 | Egress proxy, credential injection, default-deny | R1-7 |
| P6 | Isolation tests + dual-run/cutover | R1-9/R1-10 |

Each phase is independently shippable and reversible. P0/P1 can land on the
current single-container policy; P4/P5 are gated on P2.

**Rollback:** the v2 replacement app runs beside v1 with the same image; the
control server accepts both token-authenticated and (temporarily) legacy calls
during dual-run, then legacy calls are removed.

---

## 7. Acceptance criteria (G1)

- Two tenants run concurrently in separate containers.
- A probe from tenant A cannot read tenant B's workspace, state, events, settings,
  checkpoints or account seed.
- No global `Settings` singleton in the request path; changing a spec restarts only
  that sandbox.
- Unauthenticated control-plane calls fail, and the agent cannot read the control
  token.
- The sandbox holds no long-lived provider or git credential; unlisted egress is
  denied.
- A checkpoint restore reproduces both the workspace and the OpenCode state, and a
  deleted object forces a re-archive.

---

## 8. Open questions

1. **OpenCode secret handling (spike).** Can OpenCode read its server password from a
   file or fd and scrub it before spawning tools? If not, can tools run as a
   different user? This determines whether self-approval through the local API is a
   real residual risk. This is the first investigation in P0.
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
