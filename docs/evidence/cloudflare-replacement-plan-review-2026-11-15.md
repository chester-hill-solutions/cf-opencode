# Cloudflare replacement plan validation — 2026-11-15

## 1. Plan validation summary

**Adjust — identified handoff gaps addressed in the canonical plan.** Reviewed
[roadmap §5.6](../roadmap.md#56-cloudflare-replacement--owned-core-replaceable-execution-port)
against existing implementation, canonical constraints and current API source.
The user clarified that OpenCode remains the coding harness, supervision and
workspace are ours, and execution runtimes remain replaceable. This review is
source/design validation, not a replacement implementation, deployed API test or
runtime qualification. No dedicated architectural ADR collection was found;
the canonical roadmap records the explicit PORT exception to older C0 sequencing.

## 2. What the plan already covers well

- Reuses Stow Workspace, Vault, native OpenCode/control server, accounting rules,
  recovery classifiers and the existing FIFO/steer/interrupt behavior.
- Maps all configured CF responsibilities plus dormant D1 and the provider proxy.
  One standalone host is the initial failure domain; high availability is not
  implied by using SQLite or an embedded runtime.
- Separates lightweight startup targets from demonstrated compatibility, and
  archive/filesystem recovery from process-memory or external-effect recovery.
- Requires a fenced single-writer migration with unknown usage retained and
  backout after new dispatch based on the latest authority state.

## 3. Gaps, conflicts, or redundancies to fix

The following adjustments are now incorporated into §5.6 and §7:

1. **Transaction joining:** the current store and wake writer participate in
   enclosing DO transactions. The replacement passes one transaction context;
   failure between dispatch mutation and wake publication must roll both back.
2. **Runtime creation/stop:** lost create acknowledgement requires durable intent
   plus discoverable generation-bound execution identity. Missing handles cannot
   justify another writer. Descendant/cgroup termination is verified separately
   from supervisor-child exit.
3. **Full migration inventory:** include SSE sequence/events, dated tombstones,
   pending close/upgrade state, cursors and SDK SQL wake intents, not just the
   conversation state object. Test old `Last-Event-ID` reconnect and duplicate
   request retry after cutover.
4. **Runtime upgrade contract:** retain native `expectedPlanID` and digest-pinned
   OCI `targetImage`. Light targets need an explicitly versioned representation;
   pending old plans must migrate or remain visibly blocked.
5. **Key recovery:** legacy ABO1 headers lack key IDs. Record original key/scope
   references in authenticated migration data and retain or migrate old keys and
   archives; Vault rotation does not automatically rotate archive encryption.
6. **Portable imports/streams:** split CF telemetry, Lifecycle descriptors and
   entrypoint exports early. Replace `FixedLengthStream` and whole-archive RAM
   fallback with counted standard streaming/bounded disk spooling.
7. **Native restore:** freeze guest paths and UID/GID/rootless mappings rather
   than assuming a restored Stow identity can be relocated arbitrarily.
8. **Broker/gate consistency:** execution may reach a scoped broker endpoint,
   while management and long-lived credentials stay inaccessible. Retire CF-only
   checks only when their adapter is retired; retain shared correctness/security
   tests and qualify their standalone replacements.

No second controller framework, generic multi-cloud SDK or rewritten agent loop
is needed to implement these adjustments.

## 4. Existing code/product references to reuse or extend

- [Conversation composition](../../src/conversation.ts), [store](../../src/state.ts),
  [admission](../../src/conversation/admissions.ts) and
  [dispatch fences](../../src/conversation/budget-reservations.ts).
- [Wake scheduler](../../src/conversation/scheduler.ts),
  [job definitions](../../src/conversation/jobs.ts) and
  [SSE lifecycle](../../src/conversation/event-stream.ts).
- [Settings/accounting authority](../../src/settings-do.ts),
  [reconciliation](../../src/conversation/reconciliation.ts) and
  [lease decisions](../../src/leases.ts).
- [Workspace identity](../../stow-workspace.ts),
  [control server](../../control-server.ts),
  [checkpoints](../../src/conversation/checkpoints.ts),
  [archive crypto](../../src/archive-crypto.ts) and
  [Vault integration](../../src/vault.ts).
- [Runtime](../../src/conversation/runtime.ts),
  [upgrades](../../src/conversation/runtime-upgrades.ts),
  [upgrade schema](../../src/runtime-upgrade.ts) and
  [stop lifecycle](../../control-lifecycle.ts).
- [Provider egress protocol](../../src/provider-egress.ts),
  [HTTP entrypoint](../../src/index.ts),
  [telemetry](../../src/telemetry.ts) and [rate limiting](../../src/rate-limit.ts).

## 5. API impact and validation notes

Host extraction can preserve current public routes, payloads and bounded replay
semantics. It must preserve authentication, Slack signatures, approval ownership,
queue/steer/interrupt outcomes and execution-versus-accounting distinctions.
R1-4's new public turn/status contracts are separate work, not a hidden requirement
to move hosts. Source inspection found native upgrades bound to OCI images;
supporting another target kind requires an explicit versioned contract and
matching bundled callers. No live API validation was performed in this review.

## 6. Final adjusted plan, summarized

1. Freeze invariants, current data/API/runtime artifacts and startup measurements.
2. Implement the private transaction repository, owned supervisor/wake dispatcher
   and shared accounting/Vault authority with early import/rollback fault checks.
3. Qualify Stow archive storage, native execution and light execution separately;
   retain OpenCode as the harness and one workspace authority.
4. Attach public API/connectors and enforce broker/credential boundaries.
5. Package install, independent backup, telemetry, rate limiting and maintenance.
6. Run native fault/security/recovery checks, rehearse complete export/import,
   cut over with fencing and retain a current-state backout path.
7. Retire CF resources/tooling only after the retention/restore criteria pass.

The numbered PORT rows in the canonical roadmap own dependencies and status.
This evidence note does not schedule work or close PORT-G/G0/G1/G1-C/C0.

## 7. Handover items for engineering, enumerated

1. **PORT-0 / contracts:** pin source, data schema, image/harness versions and
   supported resource shape; freeze fault IDs and startup samples/targets.
2. **PORT-1/2 / state + jobs:** share transaction context; verify rollback,
   controller death, overdue sweep and stale-generation rejection.
3. **PORT-3/4 / authority + recovery:** retain unknowns/receipts; prove streamed
   encrypted archive publication and old/new-key restore on independent storage.
4. **PORT-5 / execution:** reconcile uncertain create/stop; qualify guest identity,
   descendant shutdown and native/light compatibility against the same harness.
5. **PORT-6/7 / public and privileged operations:** run source-compatible API
   fixtures plus real execution egress/credential probes and version upgrade kinds.
6. **PORT-8/9 / operator workflow:** install, restart, upgrade, back up and restore
   on a fresh Linux host; record runtime/resource/startup results and failed cases.
7. **PORT-10/11/12 / cutover:** preserve cursors/tombstones/key scopes and pending
   intents, demonstrate single-writer handoff/backout, then retire CF-only gates.
