# Local checks on a committed workspace snapshot

This opt-in path exports a bound public repository's exact committed Git tree
and runs an explicit command in a disposable local Docker container. The source-export intent
retains `checksNotRun: true`. The direct CLI produces `local_operator` receipts.
The separately authenticated service collector can attach validated execution
evidence in a separate record and deliver a bounded Slack summary. Ordinary API
callers cannot upload a result. Deployment qualification and G0/G1/G1-C remain open.

Build the owned model-free checker explicitly from this repository root, then
record its immutable local image ID. The CLI never builds or pulls an image and
never executes a repository's Dockerfile.

```sh
docker build -f runtime/check/Dockerfile -t aboiteau-check:local .
docker image inspect --format '{{.Id}}' aboiteau-check:local
```

The operator must trust the pinned checker image and local Docker daemon. A
profile label/config check prevents accidental use of the full agent image; it
does not independently prove an arbitrary image contains no embedded secrets.
The checker contains Bun and the trusted bootstrap, with no OpenCode, Stow,
service state, Git credentials or provider credentials. This first profile is
useful for dependency-free Bun checks. It supplies no package installation or
networked dependency setup; missing dependencies are failures, not a pass.

Select a fresh repository binding using [workspace-repository.md](workspace-repository.md).
The first normal message materializes it. Create a new export while the verified
task workspace is already warm and idle; export does not prepare a cold runtime.
Commit the changes to be checked and obtain the full 40- or 64-character commit object ID. The CLI requires that ID,
an explicit command, timeout and a new evidence directory:

```sh
export ABOITEAU_API_TOKEN='your-api-token'
bun scripts/workspace-check.ts run \
  --url https://your-worker.example --conversation task-123 \
  --binding-id 11111111-1111-4111-8111-111111111111 \
  --commit FULL_COMMIT_SHA \
  --image sha256:LOCAL_CHECKER_IMAGE_ID \
  --timeout-ms 120000 --out ./check-evidence-1 --json \
  -- bun --no-env-file --no-install test test/example.test.ts
```

`--binding-id` is optional: absent it, the CLI reads and freezes the server's
current bound identity. Authentication is environment-only and remains in the
outside collector. HTTPS is required except for HTTP loopback. Redirects are
refused. The shared administrative bearer is still the API authorization
boundary; this feature adds no per-user or per-repository access control.
Use a service running this revision with its matching source-export agent image;
the repository changes alone do not deploy that service.

Cold or unverified runtimes refuse a new export. Ordinary runtime preparation
can start the harness, apply settings or capture a legacy checkpoint, so this
read-only export path uses a passive warm borrow instead. It does not renew idle
time. Existing frozen sources and intent status remain downloadable when cold;
HEAD freshness is then unknown. The existing task workflow must prepare the
workspace before another new export.

The service requires `VAULT_MASTER_KEY` for encrypted check-source storage;
`ALLOW_PLAINTEXT_ARCHIVES` does not bypass that requirement. Each conversation
can retain ten immutable check intents. New intents beyond that limit are
refused without pruning old evidence. The service accepts at most 4 MiB of
snapshot JSON; the shared snapshot validator's 8 MiB wire ceiling is an upper
bound for other consumers, not the service's supported limit. Source files are
also limited by object, file, depth and expanded-byte quotas. Oversized exports
are refused as a whole.

The command is an argv array after `--`, with no implicit shell interpretation.
An explicitly requested `/bin/sh -c ...` remains a shell command selected by the
operator. Repository guidance, test scripts and preflight suggestions do not
authorize execution themselves. Avoid placing secrets in command arguments or
tracked source; both are retained in local evidence and given to the checker.

Before execution the collector verifies Git object hashes and the complete
reachable tree, binding, requested commit and canonical snapshot digest. The
export includes all supported committed files regardless of Git export
attributes. It excludes `.git`, native workspace metadata, uncommitted files,
untracked files and harness state. Unsupported symlinks, gitlinks, reserved or
unsafe paths and snapshots beyond fixed object/file/byte limits are refused.

The Docker profile uses nonroot UID/GID 65532, no network, ports, host mounts,
Docker socket, passed service environment, added capabilities or privilege
escalation. The root image is read-only. Private writable scratch is limited to
128 MiB at `/workspace` and 64 MiB at `/tmp`; the profile sets 512 MiB memory,
one CPU, 64 processes and 128 file descriptors. The maximum command deadline is
120 seconds. These limits belong to this small checker, not the full agent
runtime. Kernel/container isolation and the trusted Docker host remain part of
the boundary.

Evidence includes `request.json`, `snapshot.json`, `journal.json`, `receipt.json`,
`receipt-sha256.json`, `stdout.log` and `stderr.log` in a private directory. The
journal is persisted before Docker creation/start. The collector observes exit
and uses a unique journaled collector ID for its container name/ownership label,
so two collectors of the same immutable intent cannot remove each other's work.
It observes OOM state using Docker, so text claiming success cannot override a failing
exit. Preparation/launch exit 125 is conservatively `collector_error`, including
a user command that independently returns 125. Each output stream retains at
most 64 KiB; exceeding 1 MiB observed on a stream stops collection and execution.
Log digests cover captured bytes, with observed byte counts and truncation flags;
they are not hashes of unseen output. Raw logs are files and are not rendered as
terminal instructions. Timeout, OOM, failure, collector error, not-run and
unconfirmed cleanup remain distinct. Container removal and absence must be
confirmed before a command can be recorded as passed.
The receipt digest covers the canonical parsed receipt object, rather than the
pretty-printed file's whitespace.

Commit/tree/snapshot identities identify the immutable **input**. `/workspace`
is private writable scratch during the command; evidence does not assert the
command left those bytes unchanged. A command exit of zero is not independent
correctness proof. `baselineChecks: not_run` and `testOrConfigChanges:
not_evaluated` remain explicit until a separate base comparison/review exists.

The CLI checks HEAD immediately before and after collection: changes are stale,
unavailability is unknown. A new local `run` exits zero only for a passed command
with confirmed cleanup and matching point-in-time HEAD observations. This does
not certify a clean working tree, detect a head that changed and changed back,
or cover concurrent/uncommitted edits. `mode: committed_only` and
`worktreeChanges: unverified` are always retained. Subsequent changes require new
evidence for the relevant committed tree.

Never reuse an evidence directory to request another execution. `run` against
any existing directory returns nonzero and does not run tests, even if historical
evidence passed. Observe retained evidence explicitly:

```sh
bun scripts/workspace-check.ts observe --out ./check-evidence-1 --json
```

Observation does not check current HEAD or rerun the command. An incomplete
journal yields running, stopped-unsettled or unknown status. There is no
automatic recovery run, automatic cleanup on observation, or server completion
bridge. Preserve uncertain evidence and inspect the named, request-labeled
container with trusted operator tools before manual removal; never assume a
timed-out client proved its container stopped.

## Slack commands and the trusted service collector

These commands are verified in the internal `#arfin-test` canary for new root
threads after its fixed cutoff. The owner-approved frozen collector runs as the
`ca.chesterhill.aboiteau-arfin-check-runner` login service on this Mac. Checks
require this Mac and Docker to remain available. See the canonical roadmap
for deployment and broader gate status. Start a new channel thread with an app mention and repository selection:

```text
@OpenCode !repo https://github.com/OWNER/REPO BASE_BRANCH task/WORKING_BRANCH
```

Continue in that thread with the coding request. Once the agent has committed
the intended changes and the runtime is warm and idle, request a check:

```text
!check ["bun","--no-env-file","--no-install","test"]
!checks
```

`!check` without arguments uses the default Bun test command. The command is an
argument vector, with no implicit shell. The operator chooses the checker image
and timeout. The queue freezes the current committed input; a pass describes
that committed tree only. Working edits, baseline comparison and test/config
review remain unverified. A cold or busy workspace refuses a new export.

The runner uses its own host-only `CHECK_COLLECTOR_TOKEN`, distinct from the API
token, plus a fixed collector UUID and immutable checker image ID. A durable
global owner allows one unresolved attempt. Its private journal survives process
restarts; lost acknowledgements reuse the same attempt. Existing or uncertain
attempts never automatically rerun. A cleanup-only reconciliation can release
ownership after independently observing Docker absence, while retaining the
original result. Reset/deletion refuses unresolved attempts.

The service verifies receipt identity and captured log hashes, encrypts those
logs in R2, and persists an outbox addressed to the initiating Slack thread.
Delivery retries do not execute checks again. Slack gets the bounded outcome,
commit, exit and freshness summary; repository-controlled raw output is never
rendered into Slack. See [runner and release readiness](../evidence/slack-check-runner-readiness-2026-11-15.md).
