import { describe, expect, it } from "vitest"
import { slackActorVerdict } from "../src/slack-auth"

/**
 * Slack proves an event came from Slack; it does not decide whether the person
 * behind it may spend this deployment's money and act on its repositories. Every
 * list is opt-in so existing deployments keep working, and a malformed list denies.
 */

describe("who may start or steer a turn", () => {
  it("allows everything when no list is configured", () => {
    expect(slackActorVerdict({ teamId: "T1", userId: "U1", channelId: "C1" })).toBe("allow")
  })

  it("requires an exact member when a user list is configured", () => {
    expect(slackActorVerdict({ userId: "U2", allowedUsers: "U1, U2" })).toBe("allow")
    expect(slackActorVerdict({ userId: "U3", allowedUsers: "U1,U2" })).toBe("deny_user")
  })

  it("denies a missing or empty list rather than allowing everyone", () => {
    expect(slackActorVerdict({ userId: undefined, allowedUsers: "U1" })).toBe("deny_user")
    expect(slackActorVerdict({ userId: "U1", allowedUsers: " , " })).toBe("deny_user")
  })

  it("scopes by workspace and by channel independently", () => {
    expect(slackActorVerdict({ teamId: "T9", allowedTeams: "T1" })).toBe("deny_team")
    expect(slackActorVerdict({ teamId: "T1", allowedTeams: "T1" })).toBe("allow")
    expect(slackActorVerdict({ channelId: "C9", allowedChannels: "C1,C0CFT4X2NQG" })).toBe("deny_channel")
    expect(slackActorVerdict({ channelId: "C0CFT4X2NQG", allowedChannels: "C0CFT4X2NQG" })).toBe("allow")
  })

  it("reports the first list that refuses", () => {
    expect(slackActorVerdict({
      teamId: "T9", userId: "U9", channelId: "C9",
      allowedTeams: "T1", allowedUsers: "U1", allowedChannels: "C1",
    })).toBe("deny_team")
  })
})
