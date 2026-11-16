/**
 * R1-4c reference client. It uses only the public HTTP surface — no Slack
 * credentials, no Durable Object bindings, no internal routes — so it is the
 * evidence that the caller contract works for a non-Slack integration.
 */

export interface CliConfig {
  baseUrl: string
  token: string
}

export class CliError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${status} ${code}`)
  }
}

export type Delivery = "queue" | "steer" | "interrupt"

export interface SubmitBody {
  text: string
  user?: string
  idempotencyKey?: string
  delivery?: Delivery
  replaceQueue?: boolean
}

export interface AnswerBody {
  decision?: "once" | "always" | "reject"
  answer?: Record<string, string | number | boolean | string[]>
}

export function client(config: CliConfig) {
  const base = config.baseUrl.replace(/\/+$/, "")
  const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const payload = await response.json().catch(() => undefined) as { error?: string } | undefined
    if (!response.ok) throw new CliError(response.status, payload?.error ?? "request_failed")
    return payload
  }
  const conversation = (key: string, suffix = "") =>
    `/api/conversations/${encodeURIComponent(key)}${suffix}`
  const turn = (id: string) => `/turns/${encodeURIComponent(id)}`

  return {
    submit: (key: string, body: SubmitBody) => call("POST", conversation(key, "/messages"), body),
    status: (key: string, turnID: string) => call("GET", conversation(key, turn(turnID))),
    reply: (key: string, turnID: string) => call("GET", conversation(key, `${turn(turnID)}/reply`)),
    cancel: (key: string, turnID: string) => call("POST", conversation(key, `${turn(turnID)}/cancel`), {}),
    questions: (key: string) => call("GET", conversation(key, "/questions")),
    answer: (key: string, questionID: string, body: AnswerBody) =>
      call("POST", conversation(key, `/questions/${encodeURIComponent(questionID)}`), body),
  }
}

export type CliClient = ReturnType<typeof client>
