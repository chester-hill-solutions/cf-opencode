import type { Env } from "./env"
import { logEvent } from "./log"
import { slackActorVerdict } from "./slack-auth"

type ActorEnv = Pick<Env, "SLACK_TEAM_ID" | "SLACK_ALLOWED_USERS" | "SLACK_ALLOWED_CHANNELS">

/**
 * Refuse an actor who may not start or steer work, before any conversation is
 * touched. Slack proves the event came from Slack; this decides whether the
 * person behind it may spend the deployment's money and act on its repositories.
 *
 * Each allow-list is opt-in: unset keeps the previous behaviour (any member of a
 * channel the bot was invited to), and a configured list that matches nobody
 * denies rather than allowing everyone.
 */
export function admitSlackActor(
  env: ActorEnv,
  event: { user?: string; channel?: string },
  teamId: string | undefined,
): boolean {
  const verdict = slackActorVerdict({
    teamId,
    userId: event.user,
    channelId: event.channel,
    allowedTeams: env.SLACK_TEAM_ID,
    allowedUsers: env.SLACK_ALLOWED_USERS,
    allowedChannels: env.SLACK_ALLOWED_CHANNELS,
  })
  if (verdict === "allow") return true
  logEvent("slack.actor_refused", { reason: verdict, channel: event.channel })
  return false
}
