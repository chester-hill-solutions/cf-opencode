import { expect, test } from "bun:test"
import { ConversationStore, hasBenignSlackControlHistory, isBenignSlackControlTombstones, type ConversationState, type KeyValueStorage } from "../src/state"
import {
  parseWorkspaceRepositoryBinding,
  parseWorkspaceRepositoryReceipt,
  parseWorkspaceRepositorySelection,
  sameWorkspaceRepositorySelection,
  WorkspaceRepositoryConflictError,
  WorkspaceRepositoryValidationError,
  type WorkspaceRepositoryBinding,
  type WorkspaceRepositoryReceipt,
} from "../src/workspace-repository"

const selection = { repository: "https://github.com/owner/repo", baseBranch: "main", workingBranch: "aboiteau/task-123" }
const firstID = "11111111-1111-4111-8111-111111111111"
const secondID = "22222222-2222-4222-8222-222222222222"
const pending = { ...selection, schemaVersion: 1, bindingID: firstID, status: "pending", baseCommit: null } satisfies WorkspaceRepositoryBinding
const receipt = { ...pending, status: "bound", baseCommit: "a".repeat(40) } satisfies WorkspaceRepositoryReceipt

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, unknown>()
  writes = 0
  loseAcknowledgement = false
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined }
  async put(key: string, value: unknown): Promise<void> {
    this.writes++
    this.values.set(key, structuredClone(value))
    if (this.loseAcknowledgement) { this.loseAcknowledgement = false; throw new Error("synthetic lost storage acknowledgement") }
  }
}

test("selection canonicalizes credential-free GitHub identity and preserves branch case", () => {
  expect(parseWorkspaceRepositorySelection({ ...selection, repository: "HTTPS://GITHUB.COM/Owner/Repo.GIT/", baseBranch: "Release/V1", workingBranch: "aboiteau/Task_123" })).toEqual({ ...selection, baseBranch: "Release/V1", workingBranch: "aboiteau/Task_123" })
  expect(parseWorkspaceRepositorySelection({ ...selection, repository: "https://github.com/a/.github.git" }).repository).toBe("https://github.com/a/.github")
  expect(sameWorkspaceRepositorySelection(selection, { ...selection })).toBe(true)
  expect(sameWorkspaceRepositorySelection(selection, { ...selection, baseBranch: "next" })).toBe(false)
  expect(new WorkspaceRepositoryConflictError().code).toBe("WORKSPACE_REPOSITORY_CONFLICT")
})

test("accepted repository canonicalization is idempotent and repeated git suffixes are rejected", () => {
  for (const repository of ["https://github.com/owner/repo", "HTTPS://GITHUB.COM/Owner/Repo.GIT/", "https://github.com/a/.github.git", "https://github.com/o/project.git-tools.git", "https://github.com/o/project-git"]) {
    const canonical = parseWorkspaceRepositorySelection({ ...selection, repository })
    expect(parseWorkspaceRepositorySelection(canonical)).toEqual(canonical)
    expect(parseWorkspaceRepositoryBinding({ ...canonical, schemaVersion: 1, bindingID: firstID, status: "pending", baseCommit: null }).repository).toBe(canonical.repository)
  }
  for (const repository of ["https://github.com/o/foo.git.git", "https://github.com/o/foo.git.git.git", "https://github.com/o/foo.GIT.git/", "https://github.com/o/.git.git"]) {
    expect(() => parseWorkspaceRepositorySelection({ ...selection, repository })).toThrow(WorkspaceRepositoryValidationError)
  }
})

test("selection rejects alternate transports, credentials, URL ambiguity and unknown fields", () => {
  const repositories = [
    "http://github.com/owner/repo", "ssh://git@github.com/owner/repo", "git@github.com:owner/repo", "/tmp/repo", "-upload-pack=evil",
    "https://user:secret@github.com/owner/repo", "https://github.com:443/owner/repo", "https://github.com.evil/owner/repo",
    "https://github.com/owner/repo?token=secret", "https://github.com/owner/repo#main", "https://github.com/owner/repo/extra",
    "https://github.com/owner/%72epo", "https://github.com/owner/..", "https://github.com/owner/.", "https://github.com/-owner/repo",
    "https://github.com/owner-/repo", "https://github.com/own--er/repo", " https://github.com/owner/repo", "https://github.com/owner/repo\n",
  ]
  for (const repository of repositories) expect(() => parseWorkspaceRepositorySelection({ ...selection, repository })).toThrow(WorkspaceRepositoryValidationError)
  for (const value of [null, [], { ...selection, token: "secret" }, { repository: selection.repository }, { ...selection, workingBranch: selection.baseBranch }]) expect(() => parseWorkspaceRepositorySelection(value)).toThrow()
})

test("branch validation rejects options, ref expressions, traversal and lockfile names", () => {
  for (const branch of ["-main", "HEAD", "head", "refs/heads/main", "main~1", "main^", "main@{1}", "a:b", "a?b", "a*b", "a[b", "a\\b", "a b", "a\nb", ".main", "a/.hidden", "a..b", "a//b", "a/", "a.", "a.lock", "a.LOCK/next", "x".repeat(201)]) {
    expect(() => parseWorkspaceRepositorySelection({ ...selection, baseBranch: branch })).toThrow()
    expect(() => parseWorkspaceRepositorySelection({ ...selection, workingBranch: branch })).toThrow()
  }
  expect(() => parseWorkspaceRepositorySelection({ ...selection, workingBranch: "MAIN" })).toThrow()
})

test("binding and receipt parsers enforce canonical versioned identity and exact resolution states", () => {
  expect(parseWorkspaceRepositoryBinding(pending)).toEqual(pending)
  expect(parseWorkspaceRepositoryReceipt(receipt)).toEqual(receipt)
  expect(parseWorkspaceRepositoryReceipt({ ...receipt, baseCommit: "b".repeat(64) }).baseCommit).toHaveLength(64)
  for (const value of [
    { ...pending, schemaVersion: 2 }, { ...pending, repository: "https://github.com/OWNER/REPO.git" },
    { ...pending, bindingID: "not-a-uuid" }, { ...pending, bindingID: firstID.toUpperCase().replace("1111", "AAAA") },
    { ...pending, status: "selected" }, { ...pending, baseCommit: "a".repeat(40) }, { ...receipt, baseCommit: null },
    { ...receipt, baseCommit: "A".repeat(40) }, { ...receipt, baseCommit: "a".repeat(39) }, { ...receipt, extra: true },
  ]) expect(() => parseWorkspaceRepositoryBinding(value)).toThrow()
  expect(() => parseWorkspaceRepositoryReceipt(pending)).toThrow()
})

test("concurrent selections use the existing serialized store path and never retarget", async () => {
  const storage = new MemoryStorage(), store = new ConversationStore(storage)
  const results = await Promise.all([
    store.selectWorkspaceRepository(selection, firstID),
    store.selectWorkspaceRepository({ ...selection, repository: "https://github.com/owner/other" }, secondID),
  ])
  expect(results.map(result => result.kind)).toEqual(["selected", "conflict"])
  expect((await store.get()).workspaceRepository).toEqual(pending)
  expect(storage.writes).toBe(1)
  await store.patch({ phase: "running", sessionID: "session-existing", budgetReservation: { reservationID: "hold", dispatched: true } })
  const writes = storage.writes
  const retry = await store.selectWorkspaceRepository({ ...selection, repository: "https://github.com/OWNER/REPO.git" }, secondID)
  expect(retry).toEqual({ kind: "existing", binding: pending })
  expect(storage.writes).toBe(writes)
})

test("a lost selection acknowledgement survives store reconstruction without replacing its ID", async () => {
  const storage = new MemoryStorage(), store = new ConversationStore(storage)
  storage.loseAcknowledgement = true
  await expect(store.selectWorkspaceRepository(selection, firstID)).rejects.toThrow("lost storage acknowledgement")
  const restarted = new ConversationStore(storage)
  expect(await restarted.selectWorkspaceRepository(selection, secondID)).toEqual({ kind: "existing", binding: pending })
  expect(storage.writes).toBe(1)
})

test("existing execution, queue, usage, checkpoint and permission history block first selection", async () => {
  const blockers: Array<Partial<ConversationState>> = [
    { phase: "admitting" }, { phase: "running" }, { phase: "settling" }, { phase: "queued" },
    { sessionID: "session" }, { seen: ["evt"] }, { pending: { per_1: "session" } },
    { permissionNotifications: { per_1: { sessionID: "session", delivered: true, attempts: 1, nextAttemptAt: 0 } } },
    { queue: [{ id: "queued", enqueuedAt: 1, source: "http", text: "accepted", attempts: 0 }] },
    { budgetReservation: { reservationID: "hold", dispatched: false } }, { containerStarts: 1 }, { runStartedAt: 1 },
    { settingsVersion: 1 }, { turnBaseline: "message" }, { lastReply: "prior reply" }, { slackEngaged: true },
    { checkpointKey: "archive" }, { checkpointFingerprint: "digest" }, { checkpointPending: true },
    { checkpointManifest: { workspace: { key: "archive", size: 12, encrypted: true }, createdAt: 1 } },
    { usage: { date: "2026-11-15", costUSD: 0, input: 0, output: 0 } }, { usageError: "unknown" },
    { lifecycleJobsSealed: true }, { admissionID: "admission" }, { announcedForms: ["question"] },
  ]
  for (const history of blockers) {
    const storage = new MemoryStorage(), store = new ConversationStore(storage)
    await store.patch(history)
    const before = structuredClone(storage.values.get("state")), writes = storage.writes
    expect(await store.selectWorkspaceRepository(selection, firstID)).toEqual({ kind: "busy" })
    expect(storage.values.get("state")).toEqual(before)
    expect(storage.writes).toBe(writes)
  }
})

test("pre-start preferences are preserved and malformed retained bindings fail closed", async () => {
  const storage = new MemoryStorage(), store = new ConversationStore(storage)
  await store.patch({ phase: "idle", modelOverride: "opencode/model", containerStarts: 0 })
  expect((await store.selectWorkspaceRepository(selection, firstID)).kind).toBe("selected")
  expect((await store.get()).modelOverride).toBe("opencode/model")
  storage.values.set("state", { workspaceRepository: { ...pending, bindingID: "invalid" } })
  const writes = storage.writes
  expect(await store.selectWorkspaceRepository(selection, firstID)).toEqual({ kind: "conflict" })
  expect(await store.acknowledgeWorkspaceRepository(receipt)).toBe(false)
  expect(storage.writes).toBe(writes)
})

test("materialization acknowledgement is idempotent and the first base commit is immutable", async () => {
  const storage = new MemoryStorage(), store = new ConversationStore(storage)
  await store.selectWorkspaceRepository(selection, firstID)
  for (const invalid of [pending, { ...receipt, bindingID: secondID }, { ...receipt, workingBranch: "aboiteau/other" }, { ...receipt, repository: "https://github.com/owner/other" }]) expect(await store.acknowledgeWorkspaceRepository(invalid)).toBe(false)
  expect((await store.get()).workspaceRepository).toEqual(pending)
  await store.patch({ phase: "admitting" })
  storage.loseAcknowledgement = true
  await expect(store.acknowledgeWorkspaceRepository(receipt)).rejects.toThrow("lost storage acknowledgement")
  const restarted = new ConversationStore(storage), writes = storage.writes
  expect(await restarted.acknowledgeWorkspaceRepository(receipt)).toBe(true)
  expect(await restarted.acknowledgeWorkspaceRepository({ ...receipt, baseCommit: "b".repeat(40) })).toBe(false)
  expect((await restarted.get()).workspaceRepository).toEqual(receipt)
  expect(storage.writes).toBe(writes)
})

test("generic state patches cannot bypass the binding mutation path", async () => {
  const storage = new MemoryStorage(), store = new ConversationStore(storage)
  await store.selectWorkspaceRepository(selection, firstID)
  const writes = storage.writes
  await expect(store.patch({ workspaceRepository: undefined })).rejects.toThrow(WorkspaceRepositoryConflictError)
  await expect(store.patch({ workspaceRepository: parseWorkspaceRepositoryReceipt(receipt) })).rejects.toThrow(WorkspaceRepositoryConflictError)
  expect((await store.get()).workspaceRepository).toEqual(pending)
  expect(storage.writes).toBe(writes)
})

test("only newly proven benign Slack controls permit help then repository selection", async () => {
  const storage = new MemoryStorage(), store = new ConversationStore(storage)
  expect(await store.claimEvent("help-1", "help")).toBe(true)
  await store.patch({ slackEngaged: true })
  await store.markTombstone("help-1", "help")
  expect(await store.claimEvent("malformed-repo", "repo")).toBe(true)
  await store.markTombstone("malformed-repo", "repo")
  expect(hasBenignSlackControlHistory(await store.get())).toBe(true)
  const key = "tombstones:" + new Date().toISOString().slice(0, 10)
  expect(isBenignSlackControlTombstones(storage.values.get(key), await store.get())).toBe(true)
  expect((await store.selectWorkspaceRepository(selection, firstID)).kind).toBe("selected")
  expect(await store.claimEvent("help-1", "help")).toBe(false)
  expect((await store.selectWorkspaceRepository(selection, secondID)).binding?.bindingID).toBe(firstID)
})

test("legacy, unknown and non-control history cannot be laundered by later harmless commands", async () => {
  for (const initial of [{ seen: ["legacy"] }, { slackEngaged: true }, { sessionID: "old-session" }, { containerStarts: 1 }]) {
    const storage = new MemoryStorage(), store = new ConversationStore(storage)
    storage.values.set("state", { pending: {}, seen: [], ...initial })
    await store.claimEvent("help", "help")
    await store.patch({ slackEngaged: true })
    expect((await store.selectWorkspaceRepository(selection, firstID)).kind).toBe("busy")
  }
  const storage = new MemoryStorage(), store = new ConversationStore(storage)
  await Promise.all([store.claimEvent("help", "help"), store.claimEvent("ordinary-prompt")])
  await store.claimEvent("repo", "repo")
  expect(hasBenignSlackControlHistory(await store.get())).toBe(false)
  expect((await store.selectWorkspaceRepository(selection, firstID)).kind).toBe("busy")
})

test("benign tombstone allowlist refuses mixed legacy rows and malformed provenance", async () => {
  const storage = new MemoryStorage(), store = new ConversationStore(storage)
  await store.claimEvent("help", "help")
  await store.markTombstone("help", "help")
  const state = await store.get(), key = "tombstones:" + new Date().toISOString().slice(0, 10)
  const row = await storage.get<Record<string, unknown>>(key)
  expect(isBenignSlackControlTombstones({ ...row, legacy: Date.now() }, state)).toBe(false)
  expect(isBenignSlackControlTombstones({ ...row, evil: { schemaVersion: 1, kind: "benign_slack_control", at: Date.now(), command: "new" } }, state)).toBe(false)
  expect(hasBenignSlackControlHistory({ ...state, seen: ["different"] })).toBe(false)
  await expect(store.patch({ slackControlHistory: state.slackControlHistory })).rejects.toThrow("provenance")
  storage.values.set(key, { oldUnproven: Date.now() - 48 * 60 * 60 * 1000, malformedLegacy: null })
  await store.markTombstone("help", "help")
  const retained = await storage.get<Record<string, unknown>>(key)
  expect(retained).toHaveProperty("oldUnproven")
  expect(retained).toHaveProperty("malformedLegacy", null)
  expect(isBenignSlackControlTombstones(retained, await store.get())).toBe(false)
  const unknownTimestamp = Date.now() - 48 * 60 * 60 * 1000
  storage.values.set(key, { help: unknownTimestamp })
  await store.markTombstone("help", "help")
  expect((await storage.get<Record<string, unknown>>(key))?.help).toBe(unknownTimestamp)
})
