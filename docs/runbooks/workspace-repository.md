# Bind a fresh workspace root to a repository

Threads start in general workspaces; repository selection is optional. You can
work first, then ask OpenCode to clone/create a repository in a workspace
subfolder and carry selected work into it while retaining originals and history.
See [workspace-first usage](workspace-first.md).

This opt-in shortcut binds a fresh workspace root to one GitHub repository,
base branch and working branch for managed checkout/check evidence. A private
repository is cloned with the GitHub credential from onboarding, used only for
that clone as a one-shot HTTP header; the checkout carries no credential.
OpenCode remains the coding harness. Existing workspaces are not replaced or
retargeted by this API; normal tool-managed repository work can continue in them.

Load the existing API token through your usual secret-loading mechanism into
`ABOITEAU_API_TOKEN`. The CLI accepts no token argument. Use an HTTPS service
origin; HTTP loopback is allowed for local development. Redirects are refused.

```sh
bun scripts/workspace-repository.ts get \
  --url https://your-aboiteau-service.example \
  --conversation task-123 --json

bun scripts/workspace-repository.ts select \
  --url https://your-aboiteau-service.example \
  --conversation task-123 \
  --repository https://github.com/octocat/Hello-World \
  --base-branch master \
  --working-branch aboiteau/task-123 --json
```

These commands are examples; running them contacts your configured service.
`get` is passive. `select` saves durable intent only: it does not start a runtime,
clone the repository, create an OpenCode session or call a model provider.
Submit a message through the existing conversation workflow to attempt the
checkout and task. That later operation can execute work and incur provider cost.

## API and response

```text
GET /api/conversations/:key/workspace/repository
PUT /api/conversations/:key/workspace/repository
```

PUT accepts `repository`, `baseBranch` and `workingBranch`. The CLI requires all
three explicitly. The API can default an omitted repository/base branch once
from current settings on first selection; omitted values on identical retries
use the existing binding. The working branch is required.

Repository URLs must be credential-free HTTPS GitHub URLs. Canonical responses
use lowercase owner/repository names without a `.git` suffix. Branch validation
rejects options, ref expressions and unsupported names; the working branch must
differ from the base branch. Private repositories are cloned with the account's
stored GitHub token, which is not written into the checkout and not exposed to
the agent's own Git commands. Saving intent does not prove repository existence,
visibility, clone success or access rights.

Successful responses contain only the binding envelope:

```json
{
  "workspaceRepository": {
    "repository": "https://github.com/octocat/hello-world",
    "baseBranch": "master",
    "workingBranch": "aboiteau/task-123",
    "schemaVersion": 1,
    "bindingID": "11111111-1111-4111-8111-111111111111",
    "status": "pending",
    "baseCommit": null
  }
}
```

GET returns `workspaceRepository: null` when nothing is selected. Initial PUT
returns HTTP 201; an identical selection returns HTTP 200 and retains the same
binding ID, even after work has started. Conflicting selections or existing
work return HTTP 409. Keep working in the same workspace and request a child
checkout/file transfer through the agent. A new conversation is needed only if
you specifically want a different managed root binding.

`pending` means the selection is saved and its original base commit has not yet
been acknowledged. `bound` includes the actual resolved original `baseCommit`.
That commit remains immutable; it is not the task's latest working commit.
Neither status means dependencies were installed, checks passed or the task
finished. Global default changes do not switch an explicitly selected task.

Full workspace/state checkpoint and cold restore must preserve binding evidence,
Git data and Stow identity. Account credential seeds must not copy task bindings
between conversations. A mismatch blocks preparation; it does not authorize
overwriting a checkout or silently cloning again. An uncertain copy phase blocks
instead of retrying the copy. A cold restore with a bound mirror cannot upgrade
a still-pending controller binding: it needs the trusted bound controller/base
or the surviving trusted runtime receipt. No binding repair or rebind endpoint
is shipped. Preserve evidence for manual operator recovery or use a new
conversation; do not overwrite the checkout to clear the conflict.

## Limits and exit codes

The CLI validates success metadata, bounds response consumption and request time,
and prints generic errors without raw server bodies, credentials or Git stderr.
`--json` emits the validated success envelope; errors go to stderr. Exit codes
are 0 for a successful API operation, 2 for HTTP 409 binding conflict and 1 for
invalid arguments, authentication, transport or invalid response metadata.

Authentication remains the existing shared operator bearer token. This is not
per-user or per-repository authorization and does not close G1 strict tenancy or
the outstanding credential/egress gates. Legacy private clone behavior retains
its separate limitations. This slice does not implement setup execution, trusted
check execution, push or draft-PR publication. Local CLI/tests do not constitute
deployment or live checkout qualification.
