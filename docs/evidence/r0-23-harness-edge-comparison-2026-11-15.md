# Aboiteau's edge against coding-agent harnesses

Inspected 2026-11-15. This compares current primary documentation and selected
source, not peer runtime performance. The only live comparative result remains
the [four-cell Aboiteau/OpenCodeHarness smoke](r0-23-smoke-2026-11-15.md).
SDKs, runtime substrates and finished services are different layers; compare
equivalent assembled systems before drawing an outcome or cost conclusion.

## Finding

Self-hosting, durable sessions, approvals, sandbox execution, checkpoints and
usage tracking are shared capabilities. They do not establish an Aboiteau moat.
Exo is the closest Cloudflare control-plane/recovery architecture peer;
OpenHands is a close self-hosted remote coding-service reference. Open SWE is a
close integrated workflow reference, with an important current hosting caveat.

The candidate value is an integrated Cloudflare operating package: workspace
and session recovery, admission/usage accounting that preserves uncertainty,
and explicit operator reconciliation. Whether that package reduces work or
failure cost remains unmeasured. This is positioning inferred from the
implementations, not evidence of customer demand or competitive superiority.

## Comparison

| Peer | Already supplies | Implication for Aboiteau |
|---|---|---|
| Cloudflare OpenCode/Pi/Think harnesses | Durable submissions and recovery, with different queue/steer/approval/replay contracts. Think Actions adds settled-result receipts and grants. Linux sandbox and workspace save/restore can be composed separately. | Much custom orchestration overlaps upstream. Justify retained code by measured operator outcomes. [Primary-source findings](r0-23-durable-harness-peers-2026-11-15.md) |
| Exo | Cloudflare DO coordination outside Linux, account state/vault, R2, recovery alarms, control receipts, snapshots and provider-network policy. | Closest architecture competitor: “Cloudflare + durable + credentials outside Linux” is not unique. No equivalent or missing monetary hold/reconciliation contract was established by this inspection. [Official integration](https://developers.cloudflare.com/agents/harnesses/exo/), [pinned provider source](https://github.com/exoharness/exo/blob/1eeab021a854dc8db502d82b9fe656cbaf044671/exoharness/cloudflare/src/provider.ts) |
| OpenHands SDK / Agent Server | Persisted conversation state/events, self-hosted remote execution, confirmation policies, aggregated usage and a budget restored across restart. | Broad control/recovery/accounting overlap. Compare actual workspace restoration and ambiguous usage behavior; persisted budgets alone are not a distinction. [Agent Server](https://docs.openhands.dev/sdk/guides/agent-server/overview), [metrics](https://docs.openhands.dev/sdk/guides/metrics) |
| LangGraph / Deep Agents | Durable checkpoints, interrupts, resumable graphs and a coding-oriented harness with filesystem/sandbox integration. SDK self-hosting is supported; managed hosting is separate. | Durable workflow is a framework capability. LangGraph explicitly documents at-least-once retry and unknown acknowledgements; “honest recovery” is not unique. [Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview), [fault tolerance](https://docs.langchain.com/oss/python/langgraph/fault-tolerance) |
| Open SWE (current deployment docs: Robin) | Team workflow through GitHub/Slack and other integrations, sandboxes, usage recording and deliberate handling of uncertain sandbox loss. | Close application comparison. Current coding runtime uses Managed Deep Agents; deploying its backend yourself is not evidence that the entire stack is independent of managed services. [Installation](https://github.com/langchain-ai/open-swe/blob/main/docs/INSTALLATION.md), [runtime](https://github.com/langchain-ai/open-swe/blob/main/mda/agent.py) |
| Claude Agent SDK | Sessions including cross-host transcript adapters, approvals/hooks, tracked file rollback and estimated usage/budget controls. | Aboiteau packages service-level lifecycle and recovery around an agent. Compare full workspace coverage and accounting after interruption, not whether sessions or budgets exist. [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [file checkpoints](https://code.claude.com/docs/en/agent-sdk/file-checkpointing), [cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) |
| Codex SDK / App Server | Persistent resumable threads, tool/usage events, sandbox and approval policies, and process-control APIs. Conversation reversal is separate from restoring files. | Cloud operation and workspace lifecycle remain integration choices. No evidence here establishes Aboiteau as a better coding loop. [SDK source](https://github.com/openai/codex/blob/main/sdk/typescript/README.md), [App Server](https://developers.openai.com/codex/app-server) |

Detailed [SDK findings](r0-23-sdk-harness-peers-2026-11-15.md) and
[Cloudflare/Exo findings](r0-23-durable-harness-peers-2026-11-15.md) preserve
the individual limitations and sources.

## Open SWE source checks

Current `mda/agent.py` delegates the model loop, tools and checkpointing to the
managed runtime while the backend retains application responsibilities. The old
graph entry point now exposes a read-only graph for older threads. Avoid
describing an older architecture as the current coding path.

`openswe/middleware/sandbox_circuit_breaker.py` explicitly declines silently
replacing an unresponsive sandbox: a fresh sandbox could discard unpushed work
while appearing recovered. `record_run_usage.py` finalizes terminal usage,
including model errors; `agent_cost.py` persists invocation usage and retries
deferred cost enrichment. These are meaningful accountability/recovery overlaps,
not proof of equivalence to Aboiteau's reservation ledger.

Inspected source paths and blob IDs:

- [Managed runtime](https://github.com/langchain-ai/open-swe/blob/main/mda/agent.py): `d867db36b88a71889f2866d6a2f603544eac4e7d`.
- [Sandbox circuit breaker](https://github.com/langchain-ai/open-swe/blob/main/openswe/middleware/sandbox_circuit_breaker.py): `8b219f8614d4bd6b102af25e7dc8ab79a6409c8e`.
- [Usage middleware](https://github.com/langchain-ai/open-swe/blob/main/openswe/middleware/record_run_usage.py): `5d9e20efeaf460b666fbe67ba5d8e344aae7cc35`.
- [Invocation usage/cost](https://github.com/langchain-ai/open-swe/blob/main/openswe/agent_cost.py): `9fe14c6bca4d6f3082c383a59a2622756c55c70d`.

Its monitor `budget.py` limits monitor events/time allowance; this is not evidence
of a monetary agent-spend cap. A file named `turn_checkpoint.py` is likewise not
proof of a complete filesystem snapshot. Do not infer missing capabilities from
this bounded inspection.

## What the proposed edge must prove

Aboiteau's [checkpoint lifecycle](../../src/conversation/idle-close.ts) verifies
encrypted workspace/state publication before idle closure. Its
[reservation handling](../../src/conversation/budget-reservations.ts) and
[operator reconciliation](../../src/conversation/reconciliation.ts) preserve
ambiguous ownership/usage rather than treating it as zero. These are concrete
implementation choices. The fixed $0.10 admission hold is an estimate, not a
provider-spend cap or billing-grade result.

R0-23/C0 should establish:

1. Less operator time to deploy, upgrade, recover and reconcile equivalent work.
2. Correct surviving files/history and honest unknown/failed states after named
   faults, with no false recovery or premature hold release.
3. Lower total cost per accepted task, including infrastructure and interventions,
   or a documented operational benefit that justifies extra cost/code.

Conversation resume, workspace restoration, process-memory restoration and
external-effect deduplication are separate guarantees. No inspected system,
including Aboiteau, earns an exactly-once claim from a checkpoint alone. Broader
runtime comparisons need a decision-specific protocol and separate budget; this
research does not expand the authorized smoke or close C0/G0.
