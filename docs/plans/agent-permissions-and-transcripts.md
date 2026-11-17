# Agent permissions and research transcripts

Status: proposed, 2026-11-17. Motivated by running a daily research agent
(the parliament-facts ballot) against this instance over HTTP, with no Slack
target and no human watching.

## Context

A conversation driven by `POST /api/conversations/:key/messages` has no Slack
thread, so permission requests have nowhere to appear. The turn stops on the
first `ask`. In practice that meant a research agent ran for over an hour while
a watcher approved one shell command at a time, and it still never finished.

Two gaps, both inside this repo:

1. The default permission policy is too narrow for research, and there is no
   supported way to widen it per conversation.
2. There is no way to read a conversation's messages or tool calls after the
   fact, so an agent's work is unobservable once the turn ends.

## 1. Permission presets

`buildPermissionRules(permissions, workspace, state)` already accepts a
`PermissionLists` object, and `POST /configure` already forwards
`settings.permissions`. What is missing:

- a place to store the preset per conversation;
- a route to set it (`POST /api/conversations/:key/settings` with
  `{permissions: {...}}`);
- named presets so callers do not hand-write globs.

Proposed presets:

| Preset | allow | ask | deny |
|---|---|---|---|
| `read-only` | current safe list | — | current deny list |
| `coding` | `read-only` + `git commit*`, `bun test*`, `bun run*` | everything else | unchanged |
| `research` | `read-only` + `curl https://*`, `python3 *`, `jq *`, `date *`, `sleep *` | everything else | unchanged |

`research` is deliberately not the default. It grants outbound HTTP and
arbitrary local code, which is acceptable inside the sandbox for a research
agent and wrong as a global default.

Also: `decision: "always"` should be allowed to persist per **conversation**
for non-Slack callers, not only per interactive session, otherwise each new tool
shape asks again.

## 2. Permission requests with no Slack target

Today a request with no target is delivered nowhere and blocks until timeout.
Options, in order of preference:

1. **Policy-first**: if the command matches the conversation's allow list, never
   ask. This is the main fix.
2. **Fail fast**: if a request cannot be delivered, end the turn with
   `permission_unroutable` and record the command. Better than hanging.
3. **Auto-approve window**: an opt-in setting that approves `ask` requests for
   N minutes. Useful for scheduled agents; must be explicit and logged.

The current workaround (an external Worker polling `/permissions` every two
minutes) should not be the long-term path; it is slow and invisible.

## 3. Transcripts

`GET /api/conversations/:key` returns turns, queue, phase and permissions, but
not messages or parts. `/messages` is POST-only. Checkpoints contain the
OpenCode state archive, but encrypted with `VAULT_MASTER_KEY` and not a query
interface.

Proposed:

- `GET /api/conversations/:key/transcript?turn=<id>&limit=N` returning a
  bounded JSON list of `{role, type, text, tool, args, result, ts}` derived from
  the stored message/part records. Read-only, same bearer policy as the rest of
  the API.
- An optional R2 export on settle: `transcripts/<conversation>/<turn>.jsonl.gz`,
  gated by a setting, so long research traces survive archive/prune.

This is what makes "agent research traces" real rather than a self-report. The
parliament-facts ballot currently depends on the agent manually posting a
`research` array; that is a workaround, not evidence.

## Acceptance criteria

- A conversation can be created with `permissions: "research"` and runs a shell
  command matching the preset without any permission prompt.
- A permission request that cannot be delivered fails the turn with a named
  reason instead of blocking indefinitely.
- `GET /transcript` returns the tool calls of a settled turn, including
  arguments and a truncated result.
- The transcript export can be enabled per conversation and lands in R2.

## Rollout

1. Presets + settings route (Worker only).
2. Fail-fast for unroutable requests (Worker only).
3. Transcript read route (Worker, reads existing stored records).
4. R2 export (Worker + scheduled job).

Steps 1 and 2 remove the need for external approval polling. Step 3 unlocks
evaluation of agent runs; step 4 makes those traces durable.

## Security notes

- `research` must stay opt-in per conversation; a global default would widen
  shell access for every workspace.
- The deny list stays in force regardless of preset (`sudo *`, `rm -rf *`,
  pipe-to-shell), because a preset is about convenience, not trust.
- Transcripts contain prompts, file contents and tool output; treat the export
  as sensitive data and keep it out of public buckets.
