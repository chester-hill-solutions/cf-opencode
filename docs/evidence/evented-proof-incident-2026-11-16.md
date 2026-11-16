# Evented proof refusal and a wedged Slack conversation — 2026-11-16

Scope: read-only inspection of one production conversation plus two
`recovery` `retry` calls. No prompt was sent, no hold was released, no image or
Worker was changed. Exact identifiers are recorded because the conversation is
still held.

## What the user saw

A question in a Slack thread ("give me another export of the sms campaigns since
last time") produced, in order:

1. `⏳ Container busy — queued; I'll retry shortly.`
2. `⚠️ Couldn't start the session: OpenCode accounting policy is not effective:
   evented canary runtime did not confirm persistent events`
3. after a later turn, `🔐 Approval needed — shell` for `ls -la /workspace`,
   `echo "---"`, `ls /workspace`, `head -50`
4. `⚠️ Settlement paused: turn exceeded its time limit; dispatched reservation
   retained while context is checked`

## Live state

`GET /api/conversations/C0CFT4X2NQG:1794844846.286289/recovery` →
`kind: dispatched`, `actions: ["retry"]`, `blockers: []`.

- conversation `df83c0e9e5168ccdbf382524834839cee34fc1205565e94b77a59459ac51db97`
  (container instance `C0CFT4X2NQG:1794844846.286289`, currently inactive)
- session `ses_e1adb94eeffeTrXDQUvxncOk3w`
- reservation `dcf00521-ce4b-4fdc-9dea-e43307cc59cb`, `dispatched: true`,
  date 2026-11-16, central hold `$0.10`
- `phase: running`, `settlementError: turn exceeded its time limit; dispatched
  reservation retained while context is checked`
- `lastTurnError: … evented canary runtime did not confirm persistent events`
- queued follow-up present, `attempts: 0`
- `usageTerminal` present (`msg_1e5251d25001t15aY0jMiA5Ucz`, seq 23) but marked
  `last_observed_not_fresh_provider_proof`; `usageExecution.terminalSeq: 0`

`POST …/recovery {"action":"retry","expectedSnapshotID":"267477dd…"}` returned
`202 {"ok":true,"scheduled":true}` twice. One poll observed `kind: blocked`
(`live_local_operation`) while `pumping: true`; the rest stayed `dispatched`. No
settlement, so the `$0.10` hold and the queued message remain.

## Deployment of record

`wrangler deployments list` (newest first):

| Created | Version | Message |
|---|---|---|
| 2026-11-15T20:52:38Z | `f276b83b-a8f8-4f6d-9f82-15857909cf7c` | 15a916a baseline plus isolated arfin canary ingress |
| 2026-11-12T04:30:14Z | `4f0b2def-d7db-4e55-98bf-04e733d73c5d` | Slack image handling and safe conversation recovery |

Live `wrangler tail` confirms `scriptVersion.id: f276b83b-…`. The build message
names commit `15a916a` as its baseline, which is why the thread still contains
`Container busy and a message is already queued.` — wording deleted from the
repo on 2026-11-14 by `c52bd4f`.

**The deployed build has no source of record.** `git log --all --grep` for
"canary ingress", "arfin canary" and "isolated arfin" finds nothing, and no
branch matches; nor does anything since 2026-11-14. Production therefore runs a
hand-assembled working tree, which is why this failure cannot be reproduced from
the repository.

Separately, `wrangler containers list` shows an isolated application
`cf-opencode-arfin-canary-20261115-conversation` created 2026-11-15T20:47:51Z.
All of its instances are inactive.

## Why the proof check cannot be satisfied

`src/conversation/readiness.ts` refuses an evented conversation when
`/container/start` omits `eventPersistence: true`. Every commit in this
repository that returns `accountingPolicy: ACCOUNTING_POLICY_ID` also returns
`eventPersistence: true` on a successful start — verified by scanning every
revision of `control-server.ts` (`git rev-list --all -- control-server.ts`). Any
other answer omits `accountingPolicy` too and would have produced
`container start returned no valid accounting runtime proof` instead.

So this refusal cannot come from any checked-in build. Two candidates remain:
the custom `f276b83b` build resets its proof flag on the path that answered, or
the process behind port 4001 is not the image named in `wrangler.jsonc` (the
`CONTAINER_URL` secret is the other way that happens).

Neither the recovery `retry` action nor the accounting reconciliation endpoints
can close the hold without one successful runtime start: `retry` sends no prompt
and releases no hold, and both reconciliation decisions require fresh native
quiescence proof.

## What closes it

1. Reconcile the deployed build with a commit, or deploy `main`.
2. Confirm the running evented image matches the pinned digest
   `sha256:826337168d6d3820181d39c69764787da6e934217889370c0a91399adc5da431`,
   and add an `org.opencontainers.image.revision` label so provenance is
   answerable next time.
3. Start the container once. Settlement then reads terminal usage and the queued
   follow-up drains; no manual release is needed.
