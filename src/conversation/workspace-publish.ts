/**
 * Publish a bound workspace: push the working branch, then open a draft pull
 * request. The record lives in Durable Object storage so a retry with the same
 * request ID returns the first result instead of pushing or opening again.
 */
import type { ConversationState } from "../state"
import { parseWorkspaceRepositoryReceipt, type WorkspaceRepositoryReceipt } from "../workspace-repository"
import {
  ensureDraftPullRequest,
  parsePublicationReceipt,
  parsePublicationRequest,
  WorkspacePublicationError,
  type PublicationReceipt,
  type PublicationRequest,
  type PullRequest,
} from "../workspace-publication"

export const PUBLICATION_KEY = "workspacePublication"

/** The slice of Durable Object storage this route uses. */
export interface PublicationStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
}

export interface WorkspacePublishDeps {
  state: () => Promise<ConversationState>
  storage: PublicationStorage
  withLock: <T>(task: () => Promise<T>) => Promise<T>
  /** True when the agent is not executing and a runtime is warm. */
  idle: () => Promise<boolean>
  warm: () => boolean
  useWarm: <T>(task: () => Promise<T>) => Promise<T>
  control: () => { fetch: (input: string, init?: RequestInit) => Promise<Response> }
  token: () => Promise<string | undefined>
  now: () => number
}

const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } })

export async function workspacePublishRoute(request: Request, deps: WorkspacePublishDeps): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST" } })
  }
  const input: unknown = await request.json().catch(() => undefined)
  let publication: PublicationRequest
  try {
    publication = parsePublicationRequest(input)
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "invalid publication request", code: "INVALID_PUBLICATION" }, 400)
  }
  return deps.withLock(() => publish(deps, publication))
}

async function publish(deps: WorkspacePublishDeps, publication: PublicationRequest): Promise<Response> {
  const binding = await boundBinding(deps)
  if (binding instanceof Response) return binding
  const replay = await replayReceipt(deps, publication.requestID)
  if (replay) return reply({ publication: replay })
  const refusal = await readiness(deps)
  if (refusal) return refusal
  const pushed = await pushBranch(deps)
  if (pushed instanceof Response) return pushed
  if (!pushed.pushed && pushed.commit === binding.baseCommit) {
    return reply({ error: "There is nothing to publish: the working branch has no commits beyond the base.", code: "WORKSPACE_NOTHING_TO_PUBLISH" }, 409)
  }
  const receipt = await createReceipt(deps, binding, publication, pushed)
  if (receipt instanceof Response) return receipt
  await deps.storage.put(PUBLICATION_KEY, receipt)
  return reply({ publication: receipt })
}

/** The bound receipt, or the refusal that explains why there is none. */
async function boundBinding(deps: WorkspacePublishDeps): Promise<WorkspaceRepositoryReceipt | Response> {
  const stored = (await deps.state()).workspaceRepository
  if (stored === undefined) {
    return reply({ error: "Publishing requires a bound repository. Select one with !repo first.", code: "WORKSPACE_NOT_BOUND" }, 409)
  }
  try { return parseWorkspaceRepositoryReceipt(stored) } catch { /* reported below */ }
  return reply({ error: "The bound repository has not been materialized yet; send a message first.", code: "WORKSPACE_NOT_BOUND" }, 409)
}

async function replayReceipt(deps: WorkspacePublishDeps, requestID: string): Promise<PublicationReceipt | null> {
  const stored = await deps.storage.get<unknown>(PUBLICATION_KEY)
  if (stored === undefined) return null
  try {
    const receipt = parsePublicationReceipt(stored)
    return receipt.requestID === requestID ? receipt : null
  } catch { return null }
}

async function readiness(deps: WorkspacePublishDeps): Promise<Response | null> {
  if (!await deps.idle()) {
    return reply({ error: "The agent is still working. Wait for the turn to settle, then publish.", code: "WORKSPACE_BUSY" }, 409)
  }
  if (!deps.warm()) {
    return reply({ error: "Publishing requires a warm workspace. Send a message first, then retry.", code: "WORKSPACE_NOT_RUNNING" }, 409)
  }
  return null
}

async function pushBranch(deps: WorkspacePublishDeps): Promise<{ commit: string; pushed: boolean } | Response> {
  try {
    const response = await deps.useWarm(() => deps.control().fetch("http://container/workspace/publish", {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      redirect: "manual",
    }))
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return reply({ error: "The bound checkout could not be pushed. It may have changed since it was bound.", code: "WORKSPACE_PUBLISH_REFUSED" }, 409)
    }
    return await response.json() as { commit: string; pushed: boolean }
  } catch {
    return reply({ error: "The workspace did not answer the publish request.", code: "WORKSPACE_PUBLISH_UNAVAILABLE" }, 503)
  }
}

async function createReceipt(
  deps: WorkspacePublishDeps,
  binding: WorkspaceRepositoryReceipt,
  publication: PublicationRequest,
  pushed: { commit: string; pushed: boolean },
): Promise<PublicationReceipt | Response> {
  const token = await deps.token()
  if (!token) {
    return reply({
      error: "The GitHub credential is unavailable or cannot be read. Reconnect GitHub in onboarding, then retry.",
      code: "GITHUB_CREDENTIAL_UNAVAILABLE",
    }, 409)
  }
  let pull: PullRequest
  try {
    pull = await ensureDraftPullRequest({
      repository: binding.repository,
      branch: binding.workingBranch,
      baseBranch: binding.baseBranch,
      title: publication.title ?? `Aboiteau: ${binding.workingBranch}`,
      body: publication.body ?? `Opened by Aboiteau from a bound workspace.\n\nBase: ${binding.baseCommit}\nHead: ${pushed.commit}`,
      token,
    })
  } catch (error) {
    const known = error instanceof WorkspacePublicationError
    return reply({
      error: known ? error.message : "GitHub did not accept the publication.",
      code: known ? error.code : "GITHUB_UNAVAILABLE",
    }, 502)
  }
  return {
    schemaVersion: 1,
    requestID: publication.requestID,
    repository: binding.repository,
    branch: binding.workingBranch,
    baseBranch: binding.baseBranch,
    commit: pushed.commit,
    pullRequest: pull,
    publishedAt: deps.now(),
  }
}

/** The last publication for this workspace, for status commands. */
export async function readPublication(storage: PublicationStorage): Promise<PublicationReceipt | null> {
  const stored = await storage.get<unknown>(PUBLICATION_KEY)
  if (stored === undefined) return null
  try { return parsePublicationReceipt(stored) } catch { return null }
}
