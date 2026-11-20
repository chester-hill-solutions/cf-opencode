import type { Env } from "./env"
import type { Alert } from "./alerts"

/**
 * Post one alert to Slack. A human-needed alert goes to the escalation channel
 * and nowhere else; routine notices stay on the alert channel.
 */
export async function postAlert(env: Env, alert: Alert): Promise<void> {
  const escalate = alert.severity === "escalation"
  const channel = escalate ? env.ESCALATION_CHANNEL ?? env.ALERT_CHANNEL : env.ALERT_CHANNEL
  if (!env.SLACK_BOT_TOKEN || !channel) return
  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channel,
        text: `${escalate ? ":rotating_light:" : ":warning:"} ${alert.message}`,
      }),
    })
  } catch {
    /* alerts are best effort */
  }
}
