import { api } from "../shared/api"

export type Usage = {
  date: string
  costUSD: number
  reservedUSD: number
  admittedUSD: number
  budgetUSD: number
  historicalUsageUnreconciled?: boolean
  unknownReconciliationCount?: number
}
export type Conversation = { key: string; lastSeenAt: number }
export type Resource<T> = { kind: "ready"; data: T } | { kind: "error"; message: string }
export type Overview = {
  usage: Resource<Usage>
  conversations: Resource<Conversation[]>
}

export function parseUsage(value: unknown): Usage {
  const data = value as Usage | null
  if (
    !data ||
    typeof data.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(data.date) ||
    ![data.costUSD, data.reservedUSD, data.admittedUSD, data.budgetUSD].every(
      (item) => typeof item === "number" && Number.isFinite(item) && item >= 0
    )
  ) {
    throw new Error("Usage totals could not be read. Refresh to try again.")
  }
  return data
}

export function parseConversations(value: unknown): Conversation[] {
  const data = value as { conversations?: Conversation[] } | null
  if (
    !data ||
    !Array.isArray(data.conversations) ||
    !data.conversations.every(
      (item) =>
        item &&
        typeof item.key === "string" &&
        item.key.length > 0 &&
        Number.isFinite(item.lastSeenAt)
    )
  ) {
    throw new Error("The conversation list could not be read. Refresh to try again.")
  }
  return [...data.conversations].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}

function resource<T>(result: PromiseSettledResult<T>): Resource<T> {
  return result.status === "fulfilled"
    ? { kind: "ready", data: result.value }
    : {
        kind: "error",
        message:
          result.reason instanceof Error
            ? result.reason.message
            : "Unavailable. Refresh to try again.",
      }
}

export async function loadOverview(token: string, signal: AbortSignal): Promise<Overview> {
  const [usage, conversations] = await Promise.allSettled([
    api<unknown>(token, "/api/usage", { signal }).then(parseUsage),
    api<unknown>(token, "/api/conversations", { signal }).then(parseConversations),
  ])
  return { usage: resource(usage), conversations: resource(conversations) }
}
