import type { makeClient } from "../../src/opencode"

type Client = ReturnType<typeof makeClient>
export type SessionFixture = { id: string; contextSHA256: string }
const TITLE = "Synthetic recovery history"
const MARKER = "synthetic-no-inference-history-v1"

async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Import a fixed user-history record; no prompt, inbox delivery or model execution. */
export async function seedSession(client: Client): Promise<SessionFixture> {
  const source = await client.session.create({ id: "ses_matrix_source", location: { directory: "/workspace" },
    title: TITLE, metadata: { qualification: "r0-15-synthetic" } })
  const transfer = await client.experimental.session.export({ sessionID: source.id })
  const imported = await client.experimental.session.import({ info: { ...transfer.info, id: "ses_matrix_history" },
    messages: [{ id: "msg_matrix_history", type: "user", text: MARKER, time: { created: Date.now() } }] })
  const context = await client.session.context({ sessionID: imported.id })
  if (!JSON.stringify(context).includes(MARKER)) throw new Error("synthetic history unavailable")
  return { id: imported.id, contextSHA256: await hash(JSON.stringify(context)) }
}

export async function verifySession(client: Client, fixture: SessionFixture): Promise<boolean> {
  const info = await client.session.get({ sessionID: fixture.id })
  const context = await client.session.context({ sessionID: fixture.id })
  return info.title === TITLE && info.metadata?.qualification === "r0-15-synthetic" &&
    fixture.contextSHA256 === await hash(JSON.stringify(context))
}
