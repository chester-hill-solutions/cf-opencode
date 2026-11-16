/**
 * Reference CLI for the public caller contract (R1-4c).
 *
 * Usage:
 *   cf-opencode submit --conversation <key> --text <text> [--key <idempotency>] [--delivery queue|steer|interrupt]
 *   cf-opencode status  --conversation <key> --turn <id>
 *   cf-opencode wait    --conversation <key> --turn <id> [--timeout 45]
 *   cf-opencode read    --conversation <key> --turn <id>
 *   cf-opencode cancel  --conversation <key> --turn <id>
 *   cf-opencode questions --conversation <key>
 *   cf-opencode answer  --conversation <key> --question <id> [--decision once|always|reject] [--answer JSON]
 *
 * Environment: CF_OPENCODE_URL and API_TOKEN. Output is JSON on stdout.
 */
import { client, CliError, type AnswerBody, type CliClient, type Delivery } from "./client"

type Options = Record<string, string | true>

const TERMINAL = ["completed", "failed", "cancelled", "unknown"]

function parse(argv: string[]): { command: string; options: Options } {
  const [command, ...rest] = argv
  if (!command) throw new Error("a command is required")
  const options: Options = {}
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index] ?? ""
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`)
    const name = argument.slice(2)
    const next = rest[index + 1]
    if (next === undefined || next.startsWith("--")) options[name] = true
    else {
      options[name] = next
      index++
    }
  }
  return { command, options }
}

function required(options: Options, name: string): string {
  const value = options[name]
  if (typeof value !== "string" || !value) throw new Error(`--${name} is required`)
  return value
}

function optional(options: Options, name: string): string | undefined {
  const value = options[name]
  return typeof value === "string" ? value : undefined
}

export interface RunOptions {
  env: { url?: string; token?: string }
}

/** Runs one command and returns the response payload; throws on failure. */
export async function run(argv: string[], options: RunOptions = { env: {} }): Promise<unknown> {
  const url = options.env.url
  const token = options.env.token
  if (!url || !token) throw new Error("CF_OPENCODE_URL and API_TOKEN are required")
  const { command, options: flags } = parse(argv)
  return dispatch(client({ baseUrl: url, token }), command, required(flags, "conversation"), flags)
}

function submitCommand(api: CliClient, conversation: string, flags: Options): Promise<unknown> {
  const key = optional(flags, "key")
  const delivery = optional(flags, "delivery") as Delivery | undefined
  return api.submit(conversation, {
    text: required(flags, "text"),
    ...(key ? { idempotencyKey: key } : {}),
    ...(delivery ? { delivery } : {}),
  })
}

function answerCommand(api: CliClient, conversation: string, flags: Options): Promise<unknown> {
  const decision = optional(flags, "decision")
  const answer = optional(flags, "answer")
  if (!decision && !answer) throw new Error("--decision or --answer is required")
  const body: AnswerBody = decision
    ? { decision: decision as AnswerBody["decision"] }
    : { answer: JSON.parse(answer ?? "{}") as AnswerBody["answer"] }
  return api.answer(conversation, required(flags, "question"), body)
}

async function waitCommand(api: CliClient, conversation: string, flags: Options): Promise<unknown> {
  const turnID = required(flags, "turn")
  const timeout = Number(optional(flags, "timeout") ?? "45")
  const deadline = Date.now() + Math.min(Math.max(timeout, 1), 45) * 1000
  for (;;) {
    const status = await api.status(conversation, turnID) as { turn?: { state?: string } }
    const state = status.turn?.state
    if (state && TERMINAL.includes(state)) return { ...status, timedOut: false }
    if (Date.now() >= deadline) return { ...status, timedOut: true }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

function dispatch(api: CliClient, command: string, conversation: string, flags: Options): Promise<unknown> {
  switch (command) {
    case "submit": return submitCommand(api, conversation, flags)
    case "status": return api.status(conversation, required(flags, "turn"))
    case "read": return api.reply(conversation, required(flags, "turn"))
    case "cancel": return api.cancel(conversation, required(flags, "turn"))
    case "questions": return api.questions(conversation)
    case "answer": return answerCommand(api, conversation, flags)
    case "wait": return waitCommand(api, conversation, flags)
    default: throw new Error(`unknown command: ${command}`)
  }
}

if (import.meta.main) {
  try {
    const payload = await run(process.argv.slice(2), {
      env: { url: process.env.CF_OPENCODE_URL, token: process.env.API_TOKEN },
    })
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  } catch (error) {
    const message = error instanceof CliError ? `${error.status} ${error.code}` : error instanceof Error ? error.message : String(error)
    process.stderr.write(`cf-opencode: ${message}\n`)
    process.exitCode = 1
  }
}
