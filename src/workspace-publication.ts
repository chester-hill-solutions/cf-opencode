/**
 * Draft pull-request publication for a bound workspace repository.
 *
 * The checkout stays in the container; the Durable Object owns the record so a
 * lost response or a restart reconciles instead of opening a second pull
 * request. The GitHub token is read per call and never stored here.
 */

export class WorkspacePublicationError extends Error {
  readonly code: "INVALID_PUBLICATION" | "GITHUB_UNAVAILABLE"
  constructor(code: "INVALID_PUBLICATION" | "GITHUB_UNAVAILABLE", message: string) {
    super(message)
    this.code = code
    this.name = "WorkspacePublicationError"
  }
}

export interface PublicationRequest {
  requestID: string
  title?: string
  body?: string
}

export interface PullRequest {
  number: number
  url: string
  draft: boolean
}

export interface PublicationReceipt {
  schemaVersion: 1
  requestID: string
  repository: string
  branch: string
  baseBranch: string
  commit: string
  pullRequest: PullRequest
  publishedAt: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const PULL_URL = /^https:\/\/github\.com\/\S+$/
const MAX_TITLE = 200
const MAX_BODY = 4000

function invalid(): never {
  throw new WorkspacePublicationError("INVALID_PUBLICATION", "Publication metadata is invalid.")
}

function stringField(value: unknown, pattern?: RegExp): string {
  if (typeof value !== "string" || (pattern !== undefined && !pattern.test(value))) invalid()
  return value
}

function booleanField(value: unknown): boolean {
  if (typeof value !== "boolean") invalid()
  return value
}

function integerField(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid()
  return value
}

function pullRequestReceipt(value: unknown): PullRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  const body = value as Record<string, unknown>
  return { number: integerField(body.number, 1), url: stringField(body.url, PULL_URL), draft: booleanField(body.draft) }
}

/** A publish request. `requestID` makes a retry the same publication. */
export function parsePublicationRequest(value: unknown): PublicationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  const body = value as Record<string, unknown>
  if (Object.keys(body).some((key) => !["requestID", "title", "body"].includes(key))) invalid()
  const request: PublicationRequest = { requestID: stringField(body.requestID, UUID) }
  if (body.title !== undefined) request.title = text(body.title, MAX_TITLE, "title")
  if (body.body !== undefined) request.body = text(body.body, MAX_BODY, "body")
  return request
}

function text(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new WorkspacePublicationError("INVALID_PUBLICATION", `${field} must be 1–${max} characters.`)
  }
  return value
}

export function parsePublicationReceipt(value: unknown): PublicationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  const body = value as Record<string, unknown>
  if (body.schemaVersion !== 1) invalid()
  return {
    schemaVersion: 1,
    requestID: stringField(body.requestID, UUID),
    repository: stringField(body.repository),
    branch: stringField(body.branch),
    baseBranch: stringField(body.baseBranch),
    commit: stringField(body.commit, COMMIT),
    pullRequest: pullRequestReceipt(body.pullRequest),
    publishedAt: integerField(body.publishedAt, 0),
  }
}

/** `owner/repo` from a canonical GitHub URL; the binding already validated it. */
export function repositoryIdentity(repository: string): { owner: string; repo: string } {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(repository)
  const owner = match?.[1]
  const repo = match?.[2]
  if (owner === undefined || repo === undefined) {
    throw new WorkspacePublicationError("INVALID_PUBLICATION", "The bound repository is not a GitHub repository.")
  }
  return { owner, repo }
}

interface PullLookup {
  fetcher: typeof fetch
  token: string
  owner: string
  repo: string
  branch: string
}

function githubPull(value: unknown): PullRequest {
  const raw = value as Record<string, unknown> | null
  if (!raw || typeof raw !== "object") {
    throw new WorkspacePublicationError("GITHUB_UNAVAILABLE", "GitHub returned an unexpected pull request.")
  }
  try {
    return { number: integerField(raw.number, 1), url: stringField(raw.html_url, PULL_URL), draft: booleanField(raw.draft) }
  } catch {
    throw new WorkspacePublicationError("GITHUB_UNAVAILABLE", "GitHub returned an unexpected pull request.")
  }
}

async function github(fetcher: typeof fetch, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetcher(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "aboiteau",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
    redirect: "manual",
  })
}

async function openPullRequest(input: PullLookup): Promise<PullRequest | undefined> {
  const query = new URLSearchParams({ head: `${input.owner}:${input.branch}`, state: "open", per_page: "1" })
  const response = await github(input.fetcher, input.token, `/repos/${input.owner}/${input.repo}/pulls?${query}`)
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new WorkspacePublicationError("GITHUB_UNAVAILABLE", `GitHub pull request lookup failed (${response.status}).`)
  }
  const found: unknown = await response.json().catch(() => undefined)
  if (!Array.isArray(found)) {
    throw new WorkspacePublicationError("GITHUB_UNAVAILABLE", "GitHub returned an unexpected lookup result.")
  }
  return found.length === 0 ? undefined : githubPull(found[0])
}

/**
 * Return the open pull request for `branch`, or open a draft one.
 *
 * GitHub rejects a second pull request for the same head, so a retry after a
 * lost response looks up the existing one instead of failing.
 */
export async function ensureDraftPullRequest(input: {
  repository: string
  branch: string
  baseBranch: string
  title: string
  body: string
  token: string
  fetcher?: typeof fetch
}): Promise<PullRequest> {
  const fetcher = input.fetcher ?? fetch
  const { owner, repo } = repositoryIdentity(input.repository)
  const lookup: PullLookup = { fetcher, token: input.token, owner, repo, branch: input.branch }
  const existing = await openPullRequest(lookup)
  if (existing) return existing
  const response = await github(fetcher, input.token, `/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title: input.title, head: input.branch, base: input.baseBranch, draft: true, body: input.body }),
  })
  if (response.ok) return githubPull(await response.json().catch(() => undefined))
  await response.body?.cancel().catch(() => {})
  // A concurrent attempt may have won between the lookup and the create.
  const raced = await openPullRequest(lookup).catch(() => undefined)
  if (raced) return raced
  throw new WorkspacePublicationError("GITHUB_UNAVAILABLE", `GitHub rejected the pull request (${response.status}).`)
}
