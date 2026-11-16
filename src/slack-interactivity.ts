import type { SlackInteractionPayload } from "./adapters/slack"
import { mrkdwnEscape } from "./adapters/slack"
import type { Env } from "./env"
import { logEvent } from "./log"
import { approvalVerdict, fetchChannelMembers } from "./slack-auth"
import { parseConversationKey, resolveAgentForChannel } from "./tenancy"

const DECISIONS = { oc_perm_once: "once", oc_perm_always: "always", oc_perm_reject: "reject" } as const
type Options = {
  env: Pick<Env, "SLACK_BOT_TOKEN" | "TENANCY">
  dispatch(key: string, path: "/form" | "/permission", body: Record<string, unknown>): Promise<Response>
}

/** Runs after Slack's acknowledgement; only confirmed responses retire the controls. */
export async function handleSlackInteraction(payload: SlackInteractionPayload | undefined, options: Options): Promise<void> {
  const action = payload?.actions?.[0]
  if (!action?.value || !action.action_id) return
  const decision = Object.hasOwn(DECISIONS, action.action_id) ? DECISIONS[action.action_id as keyof typeof DECISIONS] : undefined
  const formAction = action.action_id === "form_answer" || action.action_id === "form_cancel"
  if (!decision && !formAction) return
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(action.value)
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    parsed = value as Record<string, unknown>
  } catch { return }
  if (typeof parsed.key !== "string" || !parsed.key || typeof parsed.requestID !== "string" || !parsed.requestID) return

  const channel = payload?.channel?.id
  const user = payload?.user?.id
  const token = options.env.SLACK_BOT_TOKEN
  const slack = async (method: "chat.update" | "chat.postEphemeral", body: Record<string, unknown>) => {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    })
    const result = await response.json() as { ok?: boolean }
    if (!response.ok || result?.ok !== true) throw new Error("Slack feedback was not acknowledged")
  }
  const notify = async (text: string) => {
    if (!channel || !user || !token) return
    try { await slack("chat.postEphemeral", { channel, user, text }) }
    catch { logEvent("slack.interaction.feedback_failed", { action: action.action_id }) }
  }

  try {
    const sourceAgent = parseConversationKey(parsed.key)
    if (sourceAgent) {
      const bound = await resolveAgentForChannel(options.env, payload?.team?.id, channel)
      if (!bound || bound.tenantID !== sourceAgent.tenantID || bound.agentID !== sourceAgent.agentID) {
        logEvent("permission.tenant_mismatch", { channel })
        await notify("This response belongs to another agent.")
        return
      }
    }
    const membershipSignal = AbortSignal.timeout(5000)
    const members = await fetchChannelMembers(channel ?? "", token ?? "", (input, init) =>
      fetch(input, { ...init, signal: membershipSignal }),
    )
    const verdict = approvalVerdict({ userId: user, channelId: channel,
      buttonChannel: typeof parsed.channel === "string" ? parsed.channel : undefined, members })
    if (verdict !== "allow") {
      logEvent("permission.unverified", { verdict })
      await notify(verdict === "wrong_channel" ? "This response belongs to another channel."
        : verdict === "deny" ? "Only members of this channel can answer this request."
        : "Couldn't verify channel membership; check the Slack app scopes.")
      return
    }
    if (formAction && (typeof parsed.sessionID !== "string" || !parsed.sessionID || typeof parsed.channel !== "string")) {
      await notify("This question is missing its session details. Use !answer to see the current question.")
      return
    }
    const response = await options.dispatch(parsed.key, formAction ? "/form" : "/permission", formAction ? {
      sessionID: parsed.sessionID, formID: parsed.requestID, channel,
      ...(action.action_id === "form_cancel" ? { cancel: true } : { field: parsed.field, value: parsed.value }),
    } : { requestID: parsed.requestID, decision })
    const result = await response.json().catch(() => undefined) as { ok?: boolean; error?: string } | undefined
    if (!response.ok || result?.ok !== true) {
      logEvent("slack.interaction.rejected", { action: action.action_id, status: response.status })
      // Upstream error bodies may contain credentials; expose only known local errors.
      const reason = result?.error === "stale question or wrong channel" ? "This is a stale question or the channel changed. Use !answer to see the current question."
        : result?.error === "unknown request" ? "This approval is no longer pending. Use !status to check the current run."
        : result?.error === "runtime upgrade is pending" ? "A runtime upgrade is pending. Resume it before answering this request."
        : "Your response could not be confirmed. Use !status or !answer to check the current request before trying again."
      await notify(reason)
      return
    }
  } catch {
    logEvent("slack.interaction.failed", { action: action.action_id })
    await notify("Your response could not be confirmed. Use !status or !answer to check the current request before trying again.")
    return
  }

  const label = action.text?.text ?? String(parsed.value ?? "")
  const confirmation = decision === "once" ? "✓ Approved once."
    : decision === "always" ? "✓ Always allow recorded."
    : decision === "reject" ? "✓ Denied."
    : action.action_id === "form_cancel" ? "✓ Question skipped."
    : `✓ Answered: ${mrkdwnEscape(label.slice(0, 100))}`
  const ts = payload?.message?.ts ?? payload?.container?.message_ts
  if (!ts) { await notify(confirmation); return }
  const original = payload?.message?.text ?? ""
  const blocks = (payload?.message?.blocks ?? []).filter(block => block.type !== "actions").slice(0, 48)
  if (!blocks.length && original) blocks.push({ type: "section", text: { type: "mrkdwn", text: original.slice(0, 2800) } })
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: confirmation }] })
  try {
    await slack("chat.update", { channel, ts, text: `${original}\n${confirmation}`.trim(), blocks, attachments: [] })
  } catch {
    logEvent("slack.interaction.update_failed", { action: action.action_id })
    await notify("Your response was recorded, but I couldn't remove the old buttons. Don't submit it again.")
  }
}
