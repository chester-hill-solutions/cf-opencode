# Inspect a workspace before coding

Preflight is read-only. It reports repository identity, available
tools, detected project files and suggested setup/check commands. It never
installs dependencies, runs project scripts/checks, clones a repo or calls a
model provider. Suggestions require separate authorization and execution.

## Inspect a local repository

From the Aboiteau source checkout, with Bun installed:

```sh
bun scripts/workspace-preflight.ts --workspace /path/to/repository
bun scripts/workspace-preflight.ts --workspace /path/to/repository --json
```

Local inspection does not require a Cloudflare account, running Aboiteau service,
provider credentials or an API token.

## Inspect an existing running workspace

Supply the existing API token through `ABOITEAU_API_TOKEN`, using your usual
secret-loading mechanism. The CLI accepts no token command-line argument.

```sh
bun scripts/workspace-preflight.ts \
  --url https://your-aboiteau-service.example \
  --conversation channel:thread \
  --json
```

The authenticated API is:

```text
GET /api/conversations/:key/workspace/preflight
```

The origin must use HTTPS, except HTTP loopback for local development. Redirects
are refused. The response is not cacheable. Unsupported methods return 405.

Remote inspection borrows an already verified, running runtime. It does not
prepare/start a container, create a session or budget reservation, register the
conversation, or renew its idle window. A cold workspace returns HTTP 409 with
`code: WORKSPACE_NOT_RUNNING`; preparation remains an explicit existing workflow.
Local mode can inspect a directory without first starting a service runtime.

## Interpret the report

The versioned JSON report uses `schemaVersion: 1` and `mode: read_only`.

- `blocked` means inspection found a blocker, such as unsafe repository metadata.
- `needs_verification` means inspection succeeded; setup and checks have not run.
- `verification.setup` and `verification.checks` are both `not_run`.
- Tool availability, lockfiles and dependency-directory presence are observations,
  not proof that the project builds or its dependencies are correct.
- Working-tree changes are reported as unknown (`repository.dirty: null`). The
  inspector avoids Git status/diff operations because mutable repository filters
  can execute commands. Inspecting a repository is not permission to run them.
- Setup suggestions initially cover validated plain-JSON Bun/npm lock profiles.
  JSONC-style Bun locks, binary Bun locks, pnpm and Yarn profiles require manual
  validation before setup is proposed. This does not prevent metadata inspection.
- Script names can inform suggestions; raw script definitions, remote URLs and
  Git stderr are not included. Inspector processes and output are bounded.
- Git metadata must remain inside the inspected workspace. Linked worktrees
  whose `.git` pointer leaves that directory are currently reported as blocked.

CLI exit codes are 0 for an inspected report, 2 for blocked/cold workspaces and 1
for invalid arguments, authentication, transport or malformed report errors.
Exit 0 never means tests passed or the workspace is fully ready to code.

The report is an observation, not an atomic filesystem snapshot. Files and
branches may change afterward; revalidate repository/commit identity before any
mutating operation. Inspection does not enforce the outstanding service-wide
credential/egress or strict tenancy boundaries.

## Implementation scope

This is the first R2-9 readiness increment. Per-task repo/branch binding,
authorized setup, trusted check execution, review packages, requested revisions
and draft-PR publication retain their separate implementation/qualification work.
No deployment or live model task is implied by a passing local preflight test.
