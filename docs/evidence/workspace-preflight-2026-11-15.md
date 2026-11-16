# Read-only workspace preflight — 2026-11-15

First local implementation increment for R2-9/readiness. The full request →
checked/reviewed revision → draft-PR workflow remains open in the
[canonical plan](../roadmap.md#57-product-usefulness--complete-the-coding-job).
[Usage](../runbooks/workspace-preflight.md),
[source hashes and bounded receipt](workspace-preflight-2026-11-15.json).

## Implemented

- Portable inspector and versioned allowlisted report/validator with no CF
  imports. Reports HEAD/branch, trusted-path tool availability, bounded project
  metadata and approval-required command suggestions. Never runs project setup,
  checks, package managers, provider calls or clone/fetch operations.
- Local/remote CLI. Remote mode uses an environment token, refuses redirects,
  bounds response bodies and sanitizes errors. Exit 0 means inspected, with
  setup/checks explicitly `not_run`; blocked/cold exits 2.
- Authenticated `GET /api/conversations/:key/workspace/preflight` forwarding to
  the control server. Cold access returns typed 409 without lifecycle startup,
  preparation, registration, token creation, admission or idle renewal.
- A dedicated passive runtime-port path avoids the existing startup/health retry
  path. Warm borrowing covers response consumption; cancellation propagates to
  the external-host test adapter. No new Cloudflare platform dependency.
- Control server serializes with destructive lifecycle operations, invokes the
  fixed trusted inspector through the existing agent-UID wrapper and validates
  its bounded output. Timeout/output failure kills its isolated process group.
- Docker packages both inspector and DTO. Explicit frontend supports the existing
  checksum-pinned source ADD; context excludes environment secrets and local
  agent-board/REPL data. Existing Stow source/checksum pins remain unchanged.

## Consequential finding resolved

Initial Git status inspection could execute a clean filter added concurrently
after configuration inspection. Independent review reproduced the command
execution with a synthetic marker. All worktree probes were removed: dirty is
now `null` with `worktree_changes_unverified`. The regression injects a new filter
while metadata is being inspected and proves no execution or index mutation.
Fixed metadata-only Git calls, hook/fsmonitor overrides and disabled protocols/
lazy fetch remain. This is bounded verification, not a general sandbox proof.

## Verification

Sequential full gate on macOS arm64, Bun 1.3.5:

| Check | Result |
|---|---|
| `bun run typecheck` | Pass, including all existing source/test/UI/qualification/runtime projects |
| `bun run check:config` | Pass |
| `bun run test` | 498 unit/qualification tests + 5 runtime tests pass, zero failures |
| `bun run test:workers` | 381 tests / 64 files pass, zero failures |
| `bun run build:ui` | Pass |
| `git diff --check` | Pass |

Preflight-specific coverage includes real temporary repos, unchanged index data,
malformed/oversized/symlink metadata, hooks/filters/concurrent injection, passive
auth/cold/warm/stop races, request abort, safe CLI targeting, bounded output,
process-group cleanup and lifecycle serialization. Control tests run the actual
entrypoint over stdio because a sandboxed local socket attempt failed; native
Linux UID-drop behavior has not been established by those fixtures.

Earlier loaded runs retained in local logs had one existing lifecycle timeout
and one fingerprint timeout; both the targeted lifecycle rerun and final
sequential gate passed. No timeout was increased and no regression was skipped.
The unsupported `Bun.JSONC` API was removed for installed/pinned Bun compatibility;
unvalidated JSONC/binary Bun, pnpm/Yarn lock profiles stay explicit limitations.

## Qualification boundary

The local image smoke first exposed an old Dockerfile frontend lacking checksum
ADD support. An explicit stable frontend resolved that. The next build reached
Go compilation, then Docker's build filesystem became read-only. Host storage
reported 100% usage with approximately 684 MiB free. No test runtime/container
was started by the smoke script, no image was published and no model was called.
Native image smoke remains **environment-blocked**, not passed. Restore storage
health and rerun `scripts/smoke-container.sh` before image/release qualification.

Changing `control-server.ts` also invalidated an equality assertion against the
historical frozen R0-15 image. All frozen artifact pins, probe checks and receipts
are preserved. The current-source guard now runs in the actual qualification
preflight **before any write or child process**, with tests of that ordering.
Ordinary source tests no longer claim the current controller equals a historical
image; the actual preflight correctly rejects its drift. A new image and receipt
are still required to qualify current source for that storage rollout.

No deployment, real-provider inference, setup/check execution, Git publication,
trace contribution or G0/G1/G1-C/C0 closure occurred. Per-task repo binding,
trusted setup/checks and review/revision/publication remain next work.
