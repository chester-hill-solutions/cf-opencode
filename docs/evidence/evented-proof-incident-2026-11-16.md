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

The router half of that build has no source of record: `git log --all --grep`
for "canary ingress", "arfin canary" and "isolated arfin" finds nothing, and no
branch matches; nor does anything since 2026-11-14. Its behaviour is described in
[slack-workspace-checks-2026-11-15.md](./slack-workspace-checks-2026-11-15.md)
("minimal signature-validated service-binding router"), but the source itself was
never committed. The `15a916a` baseline underneath it *is* a commit, and that
baseline is where the proof race below lives.

Separately, `wrangler containers list` shows an isolated application
`cf-opencode-arfin-canary-20261115-conversation` created 2026-11-15T20:47:51Z.
All of its instances are inactive.

## Why the proof check could not be satisfied

`src/conversation/readiness.ts` refuses an evented conversation when
`/container/start` omits `eventPersistence: true`. The deployed baseline is
`15a916a`, whose `control-server.ts` has **no lifecycle gate**: `/start`,
`/restore`, `/checkpoint` and `/state-checkpoint` all run concurrently.

`startOpencode()` in that baseline begins with `if (opencode && opencode.exitCode
=== null) return` and only sets `opencodeEventPersistence = true` after
`/api/info` readiness. So when two `/start` requests overlap:

1. the first spawns OpenCode and sets `opencodeGeneration` synchronously;
2. the second sees the live child, returns early with `opencodeEventPersistence`
   still `false`, passes the `!opencodeGeneration` guard and answers
   `200 {ok, accountingPolicy, opencodeGeneration}` without `eventPersistence`;
3. the Worker rejects that proof.

That is the only shape in this history that produces `accountingPolicy` without
`eventPersistence`, and it is intermittent — which matches the 11:16 turn running
normally on the same conversation between failed admissions.

`0c43bda` (2026-11-12) added `createLifecycleGate()` and wrapped `/start` in
`enqueueLifecycle(startRuntime)`, which serializes those handlers and removes the
race. `main` carries it (`control-server.ts:1322`). Production does not, because
the deployed ingress is frozen at the `15a916a` baseline.

The remaining option was endpoint drift — `CONTAINER_URL` pointing at a
different control server. The deployed version config pins the same base and
evented digests as the repository, so the image is not a mis-pin; it is the
ungated baseline behaviour above.

Neither the recovery `retry` action nor the accounting reconciliation endpoints
can close the hold without one successful runtime start: `retry` sends no prompt
and releases no hold, and both reconciliation decisions require fresh native
quiescence proof.

## What closes it

1. Deploy a build containing `0c43bda` or later. `main` already fixes the race,
   and PR #24 adds the truthful queue notice plus the slow retry while a
   dispatched hold blocks draining. The production-only pieces to carry forward
   are the signature-validated ingress router from
   [slack-workspace-checks-2026-11-15.md](./slack-workspace-checks-2026-11-15.md)
   and the pinned digests, which the deployed version already matches.
2. Add an `org.opencontainers.image.revision` label to the Dockerfile so a
   running image can be traced to a commit.
3. Start the container once. Settlement then reads terminal usage and the queued
   follow-up drains; no manual release is needed.

