import assert from "node:assert/strict"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { OpenCode } from "@opencode/client"

const action = process.argv[2]
const root = process.env.PROBE_ROOT
const baseURL = process.env.CONTROL_BASE_URL
const controlToken = process.env.CONTROL_TOKEN
if (!action || !root || !baseURL || !controlToken) throw new Error("probe requires action and private endpoint settings")
await mkdir(root, { recursive: true, mode: 0o700 })
const client = OpenCode.make({
  baseUrl: `${baseURL}/opencode`,
  headers: { authorization: `Bearer ${controlToken}` },
})
const location = { directory: "/workspace" }
const fixturePath = `${root}/fixture.json`

if (action === "create") {
  const session = await client.session.create({ location, title: "Event runtime archive fixture" })
  const credential = await client.credential.create({
    integrationID: "openai",
    label: "synthetic archive fixture",
    value: { type: "key", key: "synthetic-event-runtime-test-key" },
  })
  await writeFile(fixturePath, JSON.stringify({ sessionID: session.id, credentialID: credential.id }), { mode: 0o600 })
  console.log("legacy session and synthetic credential created")
  process.exit(0)
}

const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { sessionID: string; credentialID: string }
if (action === "verify-fixture") {
  const session = await client.session.get({ sessionID: fixture.sessionID })
  assert.equal(session.id, fixture.sessionID)
  const credentials = await client.credential.list()
  assert.ok(credentials.some((entry) => entry.id === fixture.credentialID && entry.value.type === "key"))
  console.log("restored default database, session and synthetic credential verified")
  process.exit(0)
}

if (action === "create-events") {
  await client.session.switchModel({
    sessionID: fixture.sessionID,
    model: { providerID: "unroutable-local-probe", id: "unroutable-local-probe" },
  })
  try {
    await client.session.prompt({ sessionID: fixture.sessionID, text: "Local archive smoke check; do not use tools." })
  } catch {
    // The intentionally unroutable model may fail before enqueue; logs below
    // still must show that the selected-model mutation is event-persisted.
  }
  await client.session.wait({ sessionID: fixture.sessionID })
  const rows = await readDurableRows(client, fixture.sessionID)
  assert.ok(rows.some((row) => row.type === "session.model.selected"))
  assert.ok(rows.some((row) => row.type === "session.execution.failed"))
  await writeFile(`${root}/event-ids.json`, JSON.stringify(rows.map(({ id, type }) => ({ id, type })), null, 2), { mode: 0o600 })
  console.log("deliberately unroutable local execution produced persisted events")
  process.exit(0)
}

if (action === "verify-events") {
  const expected = JSON.parse(await readFile(`${root}/event-ids.json`, "utf8")) as Array<{ id: string; type: string }>
  const rows = await readDurableRows(client, fixture.sessionID)
  const actual = new Set(rows.map((row) => row.id))
  for (const row of expected) assert.ok(actual.has(row.id), `persisted event missing: ${row.type}`)
  console.log(`restored archive replayed ${expected.length} durable event rows`)
  process.exit(0)
}

throw new Error("unknown archive probe action")

async function readDurableRows(api: typeof client, sessionID: string): Promise<Array<{ id: string; type: string }>> {
  const rows: Array<{ id: string; type: string }> = []
  for await (const item of await api.experimental.session.log({ sessionID, after: 0, follow: false })) {
    const event = item as { type?: string; id?: string }
    if (event.type === "log.synced") break
    if (event.type && event.id) rows.push({ id: event.id, type: event.type })
    assert.ok(rows.length <= 128, "event probe exceeded row bound")
  }
  return rows
}
