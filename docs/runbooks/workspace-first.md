# Work with or without a repository

A thread owns a general workspace and conversation. Work can start from nothing
and never become a repository. Use it for analysis, documents, scripts,
experiments, prototypes or an entirely new project. A normal message starts work
in `/workspace`; neither repository selection nor Git initialization is required.
A project name alone does not identify a checkout or grant access to one.

The retention contract distinguishes two uses:

- **Persistent work (default):** retain files, conversation and recovery
  checkpoints. Optionally name the workspace, then resume it through the same
  thread. Persistence uses the owned workspace storage; it does not require a
  Git commit, remote repository or publication.
- **Disposable work:** explicitly choose a scratch workspace for a one-off task.
  Recovery checkpoints remain while it is active. Discard it explicitly when
  finished, or keep it as persistent work in place. Finishing a model turn,
  leaving a thread or stopping an idle runtime does not delete work.

These retention controls are deployed and verified in the internal `#arfin-test`
canary. No existing workspace is reclassified or discarded automatically. The
canonical plan records broader release and qualification status.

```text
!workspace                              # inspect name, retention and cleanup status
!workspace persistent My new project    # name/keep work without creating a repository
!workspace disposable One-off analysis  # explicitly mark this workspace disposable
!workspace persistent                  # keep existing scratch work in place
!workspace discard                     # explicitly remove disposable work when idle
```

Names are optional labels within the thread; they do not create Git directories
or a shared project catalogue. Status/retention/name commands start no model or
runtime. Marking work disposable removes nothing by itself. `!workspace discard`
refuses persistent work and unresolved execution, usage holds, permissions,
check execution or final delivery. A refused or uncertain discard is not a
successful deletion. Inspect `!workspace` and retry the explicit discard to
resume its original cleanup. Recorded request identities prevent an old retry
from deleting later work.

A completed discard removes this workspace's working files, internal session
state and checkpoints. The next workspace starts persistent with a new control
identity. Slack messages, provider logs and minimal financial/control records
remain; this is not an erase-everywhere operation. `!new` changes the agent
session, and `!leave` stops following the thread; neither discards files.

The matching authenticated API uses the same controls:

```text
GET  /api/conversations/:key/workspace/profile
PUT  /api/conversations/:key/workspace/profile
GET  /api/conversations/:key/workspace/discard?requestID=UUID
POST /api/conversations/:key/workspace/discard
```

A profile returns its `profileID`, `revision`, retention, optional name and
`active`/`discarding` status. PUT supplies `expectedProfileID`, `expectedRevision`,
`retention` and an optional `name`; this is a metadata-only compare-and-set.
POST discard supplies a stable `requestID`, `expectedProfileID` and
`expectedRevision`. Keep that exact tuple when retrying. GET discard without an
ID inspects the current pending operation. A `prepared` request is bound but has
not started deletion; `pending` is unconfirmed cleanup; only `complete` confirms
it. The historical receipt remains valid after later work has started. Early
Slack command failures may require a new command event; retries are bound safely
rather than silently redirected to the latest workspace.

Ask for general work directly, for example:

> Draft a small prototype and save it in this workspace.

If you decide to use a repository, give the agent its location and the work to carry into it:

> Clone https://github.com/OWNER/REPO into a new subfolder in this workspace.
> Copy the prototype we created into that checkout, preserving the originals.
> Show me any file conflicts before overwriting anything.

You can also ask it to create a new local Git repository. These operations use
OpenCode's existing tools and permission controls. They keep the conversation
and the surrounding workspace. A checkout does not grant credentials; accessible
public repositories are the current qualified case. Private access remains a
separate credential boundary. Copy requested work rather than workspace/runtime
metadata. Committing, pushing or publishing requires the user's instruction.

The normal full workspace checkpoint includes user files and nested Git
checkouts; the session/state checkpoint preserves conversation history. Ordinary
cache exclusions still apply. A repository in a subfolder is managed through the
agent's tools. It is not automatically a registered root repository binding or
trusted `!check` input.

`!repo` remains an optional shortcut for binding a fresh workspace's root to a
public GitHub repository. Its immutable binding protects the selected base and
trusted committed-source checks. It cannot replace an existing workspace or
retarget an already bound root. A thread with work can continue using ordinary
repository instructions above. If you specifically need a different managed
root binding, use a separate fresh task. See [root repository binding](workspace-repository.md)
and [trusted committed checks](workspace-check.md).

Path-aware registration/checks for nested repositories, structured transfer
receipts and conflict-resolution UI remain planned; ordinary tool operations do
not claim those guarantees.
