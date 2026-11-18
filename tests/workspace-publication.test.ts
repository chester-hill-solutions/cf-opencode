import { describe, expect, test } from "bun:test"
import {
  ensureDraftPullRequest,
  parsePublicationRequest,
  parsePublicationReceipt,
  repositoryIdentity,
  WorkspacePublicationError,
} from "../src/workspace-publication"

const repository = "https://github.com/chester-hill-solutions/callcaster"
const token = `gho_${"a".repeat(36)}`

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

describe("publication metadata", () => {
  test("accepts a minimal request and rejects unknown or oversized fields", () => {
    expect(parsePublicationRequest({ requestID: "11111111-1111-4111-8111-111111111111" })).toEqual({
      requestID: "11111111-1111-4111-8111-111111111111",
    })
    for (const bad of [
      {},
      { requestID: "not-a-uuid" },
      { requestID: "11111111-1111-4111-8111-111111111111", extra: true },
      { requestID: "11111111-1111-4111-8111-111111111111", title: "" },
      { requestID: "11111111-1111-4111-8111-111111111111", title: "x".repeat(201) },
    ]) {
      expect(() => parsePublicationRequest(bad)).toThrow(WorkspacePublicationError)
    }
  })

  test("round-trips a receipt and refuses one that names another repository", () => {
    const receipt = {
      schemaVersion: 1 as const,
      requestID: "11111111-1111-4111-8111-111111111111",
      repository,
      branch: "aboiteau/task",
      baseBranch: "master",
      commit: "a".repeat(40),
      pullRequest: { number: 12, url: "https://github.com/o/r/pull/12", draft: true },
      publishedAt: 1,
    }
    expect(parsePublicationReceipt(receipt)).toEqual(receipt)
    expect(() => parsePublicationReceipt({ ...receipt, commit: "short" })).toThrow()
    expect(() => parsePublicationReceipt({ ...receipt, pullRequest: { ...receipt.pullRequest, url: "http://example.com" } })).toThrow()
  })

  test("reads owner and repository from a canonical URL only", () => {
    expect(repositoryIdentity(repository)).toEqual({ owner: "chester-hill-solutions", repo: "callcaster" })
    expect(() => repositoryIdentity("https://github.com/owner")).toThrow(WorkspacePublicationError)
  })
})

describe("draft pull request", () => {
  test("returns the open pull request instead of opening a second one", async () => {
    const calls: string[] = []
    const fetcher = (async (input: Request | string | URL) => {
      calls.push(String(input))
      return json([{ number: 7, html_url: "https://github.com/o/r/pull/7", draft: true }])
    }) as typeof fetch
    const pull = await ensureDraftPullRequest({ repository, branch: "aboiteau/task", baseBranch: "master", title: "t", body: "b", token, fetcher })
    expect(pull).toEqual({ number: 7, url: "https://github.com/o/r/pull/7", draft: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("head=chester-hill-solutions%3Aaboiteau%2Ftask")
  })

  test("opens a draft when none exists, with the bound base", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = (async (input: Request | string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      return requests.length === 1 ? json([]) : json({ number: 9, html_url: "https://github.com/o/r/pull/9", draft: true }, 201)
    }) as typeof fetch
    const pull = await ensureDraftPullRequest({ repository, branch: "aboiteau/task", baseBranch: "master", title: "Title", body: "Body", token, fetcher })
    expect(pull.number).toBe(9)
    expect(requests).toHaveLength(2)
    const create = requests[1]
    expect(JSON.parse(String(create?.init?.body))).toEqual({
      title: "Title", head: "aboiteau/task", base: "master", draft: true, body: "Body",
    })
    expect(new Headers(create?.init?.headers).get("authorization")).toBe(`Bearer ${token}`)
  })

  test("reconciles a create that raced another attempt", async () => {
    let lookups = 0
    const fetcher = (async (input: Request | string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return json({ message: "A pull request already exists" }, 422)
      lookups++
      return lookups === 1 ? json([]) : json([{ number: 3, html_url: "https://github.com/o/r/pull/3", draft: true }])
    }) as typeof fetch
    const pull = await ensureDraftPullRequest({ repository, branch: "b", baseBranch: "main", title: "t", body: "b", token, fetcher })
    expect(pull.number).toBe(3)
    expect(lookups).toBe(2)
  })

  test("refuses a malformed GitHub answer", async () => {
    const fetcher = (async () => json({ message: "nope" }, 403)) as unknown as typeof fetch
    await expect(ensureDraftPullRequest({ repository, branch: "b", baseBranch: "main", title: "t", body: "b", token, fetcher }))
      .rejects.toBeInstanceOf(WorkspacePublicationError)
  })
})
