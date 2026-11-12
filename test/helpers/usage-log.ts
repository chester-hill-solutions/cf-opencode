/** Build a finite OpenCode session.log response from an explicit context fixture. */
export interface UsageLogMessage {
  id?: string
  type?: string
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  error?: unknown
  finish?: string
  time?: { created?: number; completed?: number }
}

export interface UsageLogOptions {
  /** Include a durable execution start and optionally its terminal fence. */
  execution?: "succeeded" | "failed" | "interrupted" | "running"
  auxiliary?: ReadonlyArray<{
    id: string
    created?: number
    cost: number
    tokens: { input: number; output: number; reasoning?: number; cache?: { read?: number; write?: number } }
    afterAssistantMessageID?: string
    source?: string
  }>
}

interface UsageLogItem {
  id: string
  created: number
  type: string
  durable: { aggregateID: string; seq: number; version: 1 }
  data: Record<string, unknown>
}

export function usageLogResponse(
  request: Request | string | URL,
  sessionID: string,
  messages: readonly UsageLogMessage[],
  options: UsageLogOptions = {},
): Response {
  const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url)
  const after = Number(url.searchParams.get("after") ?? 0)
  let terminalAssistant: UsageLogMessage | undefined
  for (const message of messages) {
    if (message.type === "assistant" &&
      (message.finish !== undefined || message.error !== undefined || message.time?.completed !== undefined)) {
      terminalAssistant = message
    }
  }
  const execution = options.execution ??
    (terminalAssistant ? (terminalAssistant.error ? "failed" : "succeeded") : undefined)
  let seq = 0
  const items: UsageLogItem[] = []
  const firstTime = messages
    .map((message) => message.time?.created ?? message.time?.completed)
    .filter((time): time is number => time !== undefined)
    .reduce((earliest, time) => Math.min(earliest, time), Date.now())
  if (execution) {
    seq++
    items.push({
      id: `evt_execution_started_${sessionID}`,
      created: firstTime,
      type: "session.execution.started",
      durable: { aggregateID: sessionID, seq, version: 1 },
      data: { sessionID },
    })
  }
  const auxiliary = [...(options.auxiliary ?? [])]
  const appendAuxiliary = (afterAssistantMessageID?: string) => {
    for (let index = auxiliary.length - 1; index >= 0; index--) {
      const item = auxiliary[index]
      if (item?.afterAssistantMessageID !== afterAssistantMessageID) continue
      seq++
      items.push({
        id: item.id,
        created: item.created ?? Date.now(),
        type: "session.usage.recorded",
        durable: { aggregateID: sessionID, seq, version: 1 },
        data: {
          sessionID,
          source: item.source ?? "compaction",
          cost: item.cost,
          tokens: {
            input: item.tokens.input,
            output: item.tokens.output,
            reasoning: item.tokens.reasoning ?? 0,
            cache: { read: item.tokens.cache?.read ?? 0, write: item.tokens.cache?.write ?? 0 },
          },
        },
      })
      auxiliary.splice(index, 1)
    }
  }
  for (const message of messages) {
    if (message.type !== "assistant" || message.cost === undefined) continue
    if (!message.id) throw new Error("usage log fixture assistant is missing a stable id")
    seq++
    const created = message.time?.completed ?? message.time?.created ?? Date.now()
    const tokens = {
      input: message.tokens?.input ?? 0,
      output: message.tokens?.output ?? 0,
      reasoning: message.tokens?.reasoning ?? 0,
      cache: { read: message.tokens?.cache?.read ?? 0, write: message.tokens?.cache?.write ?? 0 },
    }
    items.push({
      id: `evt_${message.id}`,
      created,
      type: message.error ? "session.step.failed" : "session.step.ended",
      durable: { aggregateID: sessionID, seq, version: 1 },
      data: {
        sessionID,
        assistantMessageID: message.id,
        cost: message.cost,
        tokens,
        ...(message.error
          ? { error: message.error }
          : { finish: message.finish ?? "stop" }),
      },
    })
    appendAuxiliary(message.id)
  }
  appendAuxiliary()
  if (execution && execution !== "running") {
    seq++
    const lastTime = items.at(-1)?.created ?? firstTime
    items.push({
      id: `evt_execution_${execution}_${sessionID}`,
      created: lastTime + 1,
      type: `session.execution.${execution}`,
      durable: { aggregateID: sessionID, seq, version: 1 },
      data: { sessionID },
    })
  }
  const replay = items.filter((item) => item.durable.seq > after)
  const watermark = items.at(-1)?.durable.seq
  const output = [
    ...replay,
    { type: "log.synced", aggregateID: sessionID, ...(watermark === undefined ? {} : { seq: watermark }) },
  ]
  const body = output.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}
