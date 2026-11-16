# SDK harness peers: control, recovery and accountability

Inspected 2026-11-15 against current primary documentation and official source.
This is capability research, not a runtime benchmark of Claude, Codex or OpenHands.
The separate Aboiteau/OpenCodeHarness smoke does not qualify these peers or establish
a general coding-quality, security, recovery or cost winner.

The comparison is between coding-agent SDKs and an operated execution service.
SDK features can supply service internals; their presence is not proof that every
hosted application exposes them, and an example's omission is not platform absence.

## Twelve source-backed facts

| # | Peer and built-in behavior | Implication for Aboiteau's proposed distinction |
|---|---|---|
| 1 | **Claude sessions persist conversation history**, including tool calls/results; continue, resume and fork are supported. Current SDKs can mirror transcripts through a `sessionStore` adapter to an application backend for cross-host resume; directory identity matters. [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions#resume-across-hosts) | Session persistence and cross-host transcript storage already overlap. Filesystem recovery is a separate requirement. |
| 2 | **Claude file checkpointing backs up tracked Write/Edit/NotebookEdit modifications.** It can restore file contents without rewinding conversation history. Arbitrary Bash-only edits and subagent edits are not comprehensively tracked by this feature. [Checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing) | File rollback is already present, with defined coverage. Compare actual workspace recovery boundaries rather than equating this with portable whole-workspace archives. |
| 3 | **Claude has permission modes, allow/deny rules, hooks and a `canUseTool` callback.** Deny rules can prevent a callback from being reached; hooks are part of an ordered evaluation. [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions) | Generic approvals are parity. Connector delivery, durable operator decisions and sandbox credential containment require separate integration evidence. |
| 4 | **Claude exposes `maxBudgetUsd` and usage/cost results.** The budget uses a client-side estimate, can overshoot and counts the current call rather than restored session spend. After a process crash, final cost fields can be zeroed; documented reconstruction has gaps, including output/subagent usage. [SDK options](https://code.claude.com/docs/en/agent-sdk/typescript#options), [cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking#recover-totals-after-a-session-crash) | Aboiteau cannot claim unique spend tracking or a hard cap. Its candidate edge is an integrated, tested policy for reservations, unknown usage and reconciliation across service lifetimes. |
| 5 | **Codex TypeScript SDK wraps a local Codex CLI process** and exchanges JSONL events; `runStreamed()` exposes intermediate progress and terminal usage events. [Official SDK source README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) | A local embeddable harness and event/usage surface already exist. Hosting and operating the enclosing service remains an integration choice. |
| 6 | **Codex threads persist locally and can be resumed by ID** after the in-memory Thread object is lost; the SDK README identifies `~/.codex/sessions`. [SDK persistence](https://github.com/openai/codex/blob/main/sdk/typescript/README.md#resuming-an-existing-thread), [SDK guide](https://developers.openai.com/codex/sdk) | Durable conversation identity/resume already overlaps. This evidence does not establish a portable filesystem snapshot or resurrection of a killed process. |
| 7 | **Codex SDK thread options expose sandbox and approval policies**, working directory, additional directories and network-access configuration. [Official option types](https://github.com/openai/codex/blob/main/sdk/typescript/src/threadOptions.ts) | Sandboxing/approvals are existing harness controls. Their actual deployment, credential scope and caller contract still need configuration and tests. |
| 8 | **Current Codex App Server distinguishes history reversal from file reversal:** `thread/revert` changes conversation history without reverting local files. It separately exposes background-terminal list/cleanup APIs. Current docs say the older `thread/rollback` method was removed. [App Server](https://developers.openai.com/codex/app-server) | Do not claim that Codex has no process cleanup, or that conversation reversal is filesystem recovery. These APIs do not themselves establish rollback of external effects. |
| 9 | **OpenHands automatically saves conversation state and events** under a persistence directory and restores using the same conversation ID. The docs describe crash recovery of that saved state, with base state and event files stored separately. [Persistence](https://docs.openhands.dev/sdk/guides/convo-persistence) | Persistent state/event history already overlaps. Recovering saved agent state is distinct from restoring all workspace bytes or an in-flight shell process. |
| 10 | **OpenHands Agent Server is an explicitly self-hostable remote execution layer:** containers on Kubernetes, VMs, on-premises or cloud; HTTP/WebSocket control; local, Docker and remote workspace abstractions. [Remote server architecture](https://docs.openhands.dev/sdk/guides/agent-server/overview) | This is a close service/backend reference, not merely an in-process loop. “Self-hosted remote coding agent” is not a unique Aboiteau category. |
| 11 | **OpenHands provides confirmation policies and pending-action handling:** AlwaysConfirm, NeverConfirm, risk-based confirmation, rejection and continuation. [Security and confirmation](https://docs.openhands.dev/sdk/guides/security) | Operator control and approvals already overlap. Delivery reliability and the precise execution/authorization boundary remain implementation-specific. |
| 12 | **OpenHands tracks per-LLM and combined conversation metrics and has a persisted conversation budget.** The documented limiter restores across restart, checks after steps and can overshoot; missing pricing is not proof of free usage, and an in-flight call's cost arrives only with usage reporting. [Metrics and budgets](https://docs.openhands.dev/sdk/guides/metrics) | Budget persistence and cost aggregation already overlap substantially. Compare unknown-usage behavior, enforcement timing and recovery/accounting invariants rather than feature labels. |

## What remains a candidate distinction

**Inference from the sources:** Aboiteau's strongest candidate is the assembled
operator workflow: own-account Cloudflare deployment, public API/connector parity,
durable admission and caller identity, portable encrypted workspace/history
recovery, and held/unknown usage reconciliation exposed coherently to an operator.
These peers already supply many constituent mechanisms. This research does not
establish that another product lacks the same combination, or that Aboiteau's
combination is easier or more reliable.

The evidence needed for a service-level advantage is a defined failure followed
by observed recovery and correct effects/accounting: interruption during a tool,
lost acknowledgement, host/container loss, failed checkpoint publication and
provider usage arriving late or never. Resuming a transcript, reverting tracked
files, or stopping one terminal is not proof of exactly-once tool execution,
rollback of a pushed commit/API call, whole-process memory restoration, or final
provider settlement. Those guarantees were not established by this inspection
for any peer and are not inferred absent.

## Inspection limits

Local-first OpenAI check: the installed launcher was found at
`/Users/ladmin/.bun/install/global/node_modules/@openai/codex/bin/codex.js`, with
package version **0.116.0**. It is a native CLI launcher; no local
`@openai/codex-sdk` source was found in the inspected locations. Consequently,
current official SDK source and documentation supplied the SDK facts above.
Their newer APIs must not be attributed to that older installed binary without
version-specific verification. The OpenAI documentation skill was read; only
official OpenAI documentation and the `openai/codex` repository were used for
Codex claims.

The SDK repository links refer to moving `main`, and documentation is a dated
inspection rather than a package-qualified implementation receipt. No peer SDK
was installed, no credentials were inspected, and no model/deployment command
was executed for this research. Package/runtime pins and equivalent task/fault
protocols would be required before extending the live comparison to these peers.
