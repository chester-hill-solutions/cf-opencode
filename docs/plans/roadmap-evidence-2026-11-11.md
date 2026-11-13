# Roadmap evidence history — 2026-11-11

These dated notes are preserved from the roadmap before the execution-service
revision. They describe successive checkpoints, not a single current state.
Statements such as “Live validation has not started” apply to their historical
checkpoint and are superseded by later entries. The
[current gate ledger](../roadmap.md#current-gate-ledger) is the planning authority.
Detailed operational evidence stays in the linked runbook and scoped plans.

**Local repair update — 2026-11-11.** R0-10, R0-13 and R0-14 now pass their local
regressions and the full local gate. The original audit 30/31 reproductions are fixed,
but R0-11 remains partial. F1 now includes source accounting, foreground-only runtime
policy, execution-completion fences and previewed legacy cutover. Scoped F2 now adds
passive recovery inspection, safe pre-dispatch cancellation, alarm-only recovery
retry and permanent reservation retirement (371 tests in the latest gate).
Actual accounting cutover, deployed-container verification and unprovable
legacy/orphan/manual reconciliation cases remain open. Legacy opening balances remain
explicitly unreconciled with historical bills. Audit 32's trusted-repository
documentation/probe evidence is recorded; credential isolation and G1 remain open. G0
remains open pending deployed/container and real Slack/HTTP/model task validation. See the
[audit status and evidence](../production-audit.md#local-repair-verification--2026-11-11)
and [local regressions and limits](../testing.md#local-repair-verification--2026-11-11).

**Slack connection update — 2026-11-11.** With operator approval, the existing
OpenCode app in Team Nate uses the production Worker's verified HTTP event and
interaction URLs, with Socket Mode off. Mention, DM and engaged-thread event
subscriptions are saved. The credential-preserving restart fix is deployed and
a real HTTP model reply was observed, but accounting settlement did not identify
the corresponding execution/terminal events because stock CLI 2.2.5 does not
persist Bus events (`persist:false`). Its sequence 11 cursor is only a watermark,
not unrecognized event rows. The published server API supports event persistence,
and a custom Bun entrypoint was implemented and first verified on isolated canary
`event-retention-canary-20261111-02`. Its fresh HTTP task returned `READY` with
terminal usage evidence and exact ledger acknowledgement. With separate user
approval, fresh-conversation routing was enabled and the approved `#arfin-test`
thread passed `!help`, `!new`, `!model`, a text reply, question Continue and
permission approval. The task requested `SLACK_READY`; the final response
matched. The two older `$0.10` holds remain for operator/manual reconciliation;
do not auto-zero them. The operator approved a temporary cap of 3, including its
incremental runtime cost, until S8 reconciliation. Settings version 7 was verified
with two held runtimes and one available slot. Restore the cap to 2 after S8 safely
frees the held runtimes. G0 text-reply/button evidence is passed; the wider product
goal remains open for S8 and S10 image handling. See the
[connection record](../runbook.md#slack-connection--2026-11-11) and
[current usability evidence](slack-usability.md#current-evidence).

**Slack usability follow-up.** The deployed bot's `!help`, `!usage` and model
catalogue commands have been verified in the operator's DM. The paid model key is
connected and persisted across a real settings restart. A fresh HTTP conversation
answered `READY` with reported cost `$0.0017703`, but its usage replay failed to
reconstruct execution and terminal events because the stock CLI Bus uses
`persist:false`; sequence 11 is a watermark. Its hold remains, as does the
separate `$0.10` hold from the Slack DM that failed with `provider.no-route`.
Neither supports a zero-charge claim. A later isolated evented-image canary
returned `READY` and its usage was acknowledged; that does not reconstruct the
older turns. Fresh-conversation routing was enabled with separate approval. The
operator-approved `#arfin-test` thread passed `!help`, `!new`, `!model`, a text
reply, question Continue and permission approval. The two older holds remain for
S8 manual reconciliation. An approved temporary third slot provides capacity for
new work while the two older runtimes remain held. Slack image attachments remain
planned under
[S10](slack-usability.md#s10--image-attachments): authenticated image
delivery, model capability checks and an explicit response with compatible-model
suggestions when the selected model cannot read images. Selection stays unchanged
until the user switches models and resubmits. See the
[usability evidence](slack-usability.md#current-evidence).

**Initial assessment — 2026-11-11 (historical).** The initial 269-test snapshot reproduced
checkpoint retention, budget reservation and malformed-input failures, and demonstrated
that repository-executed code could read synthetic provider state under the shared
identity. No fixes had been made at that assessment point. Later local repair evidence
supersedes its open status for locally verified findings, not its credential or deployment
limitations.

**Next iteration:** [R0 reliability execution plan](r0-reliability-iteration.md)
keeps W1–W12 as reviewable slices, with W4a–W4c/W6a making broad edits manageable
for Luna. Luna handles bounded implementation, tests and documentation; the parent
locks decisions and integrates, with Terra/high for focused critical review. Targeted
[source research](r0-simplification-research.md) removed a broader reservation
protocol from this pass. Local implementation and verification are complete for the stated
repair scope. The [F1 follow-up](r0-reliability-iteration.md#f1-accounting-follow-up--2026-11-11)
adds verified local accounting repairs. The [policy/cutover follow-up](r0-reliability-iteration.md#f1-policy-and-legacy-cutover--2026-11-11)
implements the remaining local F1 contract. Scoped F2 recovery is also locally
verified; R0-11 remains partial for unprovable legacy/manual cases and live
cutover/container verification.
Live validation has not started.

**Latest scoped implementation:** [F2 held-turn recovery](r0-held-turn-reconciliation.md)
is implemented and reviewed locally, with Luna ownership for retirement, passive
inspection, safe pre-dispatch cancellation and existing recovery retries. It adds
no expiry or ambiguous prompt resend. Unprovable legacy/orphan cases remain
explicit blockers; no live recovery action has run.

