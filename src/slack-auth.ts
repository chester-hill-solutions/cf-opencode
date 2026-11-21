/** Slack approval authorization: channel membership is the access boundary. */

export interface SlackMembersPage {
  ok?: boolean
  members?: string[]
  response_metadata?: { next_cursor?: string }
}

/**
 * Fetch the member ids of a channel. Returns `undefined` when membership
 * cannot be proven (missing token, missing scope, API error, or a channel too
 * large to page through), so callers can fail closed.
 */
export async function fetchChannelMembers(
  channel: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  maxPages = 10,
): Promise<Set<string> | undefined> {
  if (!token) return undefined
  const members = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const url = new URL("https://slack.com/api/conversations.members")
    url.searchParams.set("channel", channel)
    url.searchParams.set("limit", "200")
    if (cursor) url.searchParams.set("cursor", cursor)
    let body: SlackMembersPage
    try {
      const response = await fetchImpl(url.toString(), {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!response.ok) return undefined
      body = (await response.json()) as SlackMembersPage
    } catch {
      return undefined
    }
    if (!body.ok) return undefined
    for (const id of body.members ?? []) members.add(id)
    cursor = body.response_metadata?.next_cursor || undefined
    if (!cursor) return members
  }
  // The channel is larger than we are willing to page through; do not return a
  // partial membership set that could deny a real member.
  return undefined
}

export type ApprovalVerdict = "allow" | "deny" | "unverifiable" | "wrong_channel"

export interface ApprovalCheck {
  userId?: string
  channelId?: string
  /** Channel embedded in the button when it was posted. */
  buttonChannel?: string
  members?: Set<string>
}

/** Any member of the channel may approve; nobody outside it may. */
export function approvalVerdict(check: ApprovalCheck): ApprovalVerdict {
  if (!check.userId || !check.channelId) return "unverifiable"
  if (check.buttonChannel && check.buttonChannel !== check.channelId) return "wrong_channel"
  if (!check.members) return "unverifiable"
  return check.members.has(check.userId) ? "allow" : "deny"
}

/**
 * Who may start or steer a turn.
 *
 * Approvals already use channel membership as the boundary, but a message that
 * starts work had no check at all: any member of any channel the bot was invited
 * to could spend the deployment's money and act on its repositories. Each list is
 * opt-in — unset keeps today's behaviour — and a malformed list denies rather
 * than allowing everyone.
 */
export interface SlackActorCheck {
  teamId?: string
  userId?: string
  channelId?: string
  allowedTeams?: string
  allowedUsers?: string
  allowedChannels?: string
}

export type SlackActorVerdict = "allow" | "deny_team" | "deny_user" | "deny_channel"

/** An unset list allows; a set list requires an exact, non-empty match. */
function listed(csv: string | undefined, value: string | undefined): boolean {
  if (csv === undefined) return true
  const entries = csv.split(",").map((entry) => entry.trim()).filter(Boolean)
  if (entries.length === 0) return false
  return value !== undefined && entries.includes(value)
}

export function slackActorVerdict(check: SlackActorCheck): SlackActorVerdict {
  if (!listed(check.allowedTeams, check.teamId)) return "deny_team"
  if (!listed(check.allowedUsers, check.userId)) return "deny_user"
  if (!listed(check.allowedChannels, check.channelId)) return "deny_channel"
  return "allow"
}
