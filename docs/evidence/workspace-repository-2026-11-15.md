# Task repository binding — 2026-11-15

**Result: public repository binding implemented and verified locally; not
deployed.** This is the first opt-in public-repository increment of R2-9.1. It
does not complete the repo-to-draft-PR workflow or authorize release.

## Implemented contract

- Authenticated GET/PUT `/api/conversations/:key/workspace/repository` reads or
  selects a fresh task's repository, base branch and working branch. PUT records
  intent without starting Linux, registering execution, creating a session or
  reserving provider spend. Identical retries retain the binding ID; competing
  selections and prior work are refused.
- Repository identity is a canonical credential-free HTTPS GitHub URL. Optional
  API defaults are captured once; subsequent global changes do not retarget the
  task. The CLI requires all three selection fields explicitly.
- The controller persists a pending binding before checkout. The control server
  records root-protected intent before clone/copy, returns the actual resolved
  base commit, and the controller acknowledges that receipt before session or
  provider dispatch. The original base commit remains immutable after edits.
- Bound checkout uses fixed, bounded Git operations as the agent user with a
  curated environment, empty templates and disabled hooks, redirects, credential
  helpers, lazy fetching, object replacements and grafts. It never inherits the
  legacy GitHub clone token. Existing checkout conflicts do not authorize an
  overwrite or another clone.
- A full checkpoint retains Git data, Stow identity and a nonsecret binding
  mirror. Cold restore requires a matching trusted controller receipt and actual
  workspace root, origin, working branch and base ancestry. The archived mirror
  alone supplies no authority. Account seeds exclude and reject binding data.

OpenCode remains the coding harness. The binding contract and checkout/recovery
implementation belong to this repository; the current controller still uses
Cloudflare. This increment does not implement the standalone PORT replacement.

## Review and regression coverage

Shared-store tests exercise concurrent selection, lost storage acknowledgements,
immutable base receipts, prior-work refusal and bypass prevention. Worker tests
exercise passive authenticated routes, captured defaults, runtime proof refusal,
receipt-before-dispatch ordering and mocked encrypted split-checkpoint restore.
CLI tests exercise safe targets, credential handling, validated output, bounded
bodies and stalled requests. Host tests use real temporary Git repositories.

Review identified and corrected a mirror-write symlink race and Git ancestry
replacement/graft ambiguity. An independent actual-Git reproduction also found
that `core.worktree` could redirect Git outside `/workspace` while metadata
checks passed. Canonical worktree/Git-directory checks now reject that same
case with `WORKSPACE_REPOSITORY_CONFLICT`; the regression test is retained.

The final sequential project gate passed: **525 unit/qualification tests plus
5 OpenCode runtime tests (530 Bun total)** and **394 Worker tests across 65
files**. Full TypeScript checks, configuration validation, UI build and
`git diff --check` passed. A repeated `.git` URL suffix was also found to
normalize differently on a second parse; unsupported repeated suffixes now
fail consistently, with accepted-input idempotence regression coverage.
The [JSON receipt](workspace-repository-2026-11-15.json) records 28 relevant
source hashes, test hashes, check durations and raw-log hashes.

## Image verification

Both tests used Linux amd64 images on the aarch64 Docker host via emulation,
with one disposable runtime active at a time. No model execution was requested.

| Check | Exact image | Result |
|---|---|---|
| Broader native sequential smoke | `sha256:24ed327e705ba5cdd15bc786f9214d6ee419a768190bfb67bf6031d3101a27b2` | Passed control/preflight, Stow/native APIs, workspace/state checkpoints and restore, unsafe-link refusal, account-seed separation/lifecycle races, and fresh-container cold recovery. |
| Final repository-binding smoke | `sha256:b128a064a64736b5f2ddb85bae4957af4e4c5f5da474bbd3207d71aa58a8e4bc` | Passed actual public clone, exact binding receipt, retry/conflict checks, immutable base after a working commit, account export/seed boundaries, split cold restore and tampered-mirror refusal before OpenCode starts. |

The broader image predates only the additional repeated-`.git` URL rejection;
the other previously captured source hashes match. The final binding image
contains that guard, weighs **493,046,441 bytes**, and is retained locally as
`aboiteau-repository:20261115`. These are separate receipts, not a claim that the
entire broader suite ran on the final image. The final project gate and focused
binding smoke cover the validator change.

The real public fixture was `https://github.com/octocat/hello-world`, base
`master`, working branch `aboiteau/image-binding-smoke`. The resolved original
base was `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`. A synthetic local working
commit `9e9273d515fb04d4d32c5c086f841c09b57d07bd` survived cold restore while
that original base remained unchanged. The Stow identity
`ws_66d0ea47f1ff4b6f` also survived.

Raw logs: `/tmp/aboiteau-repository-container-smoke.log` and
`/tmp/aboiteau-repository-binding-smoke.log`. The latter printed its final PASS
and exited 0; its small summary is copied into the JSON receipt. All owned smoke
containers were removed. Existing `deploy-studio-1` retained ID `8fd750f3c29a`
and its local HTTP endpoint returned 200 after verification. Unrelated stopped
containers and volumes were preserved.

## Deliberate limits

The API retains the existing shared operator bearer-token boundary; it does not
provide per-user or per-repository authorization. Private authenticated checkout
and the existing legacy credential residual remain G1/R1-7 work. Existing
unbound workspaces retain their legacy behavior.
The initial bound clone retrieves the selected branch's history; shallow/on-demand
history optimization and clone/setup ready-time measurement remain open.

An uncertain copy remains blocked. A cold restore with only a bound archive
mirror while the controller still records pending intent cannot be adopted
automatically. There is no repair/rebind endpoint in this increment; retain the
evidence for operator recovery or start a separate conversation. No automatic
overwrite, forced branch reset or prompt resend repairs uncertainty.

Setup and trusted checks, review/local patch handoff, publication and requested
revisions remain subsequent work. No model inference or publication is required
by this verification. Local image tests do not qualify Cloudflare/R2 storage,
strict tenancy, simultaneous load, external pilots or G0/G1/G1-C/C0/PORT-G.

Usage: [repository binding runbook](../runbooks/workspace-repository.md).
