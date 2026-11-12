import { describe, expect, test } from "bun:test"
import type { ModelInfo } from "@opencode/client"
import {
  checkSlackImageModel,
  downloadSlackImage,
  formatSlackImageModelSuggestions,
  SLACK_IMAGE_MAX_BYTES,
  type SlackFile,
} from "../src/slack-images"

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])
const slackFile = (overrides: Partial<SlackFile> = {}): SlackFile => ({
  id: "F123",
  name: "photo.png",
  mimetype: "image/png",
  size: png.length,
  url_private_download: "https://files.slack.com/files-pri/F123/download/photo.png",
  ...overrides,
})

function imageResponse(bytes: Uint8Array, mime = "image/png", headers: Record<string, string> = {}): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": mime, ...headers } })
}

describe("downloadSlackImage", () => {
  test("downloads a valid PNG with bearer auth and returns SDK inline URI", async () => {
    let requested: Request | undefined
    const attachment = await downloadSlackImage([slackFile()], "xoxb-test-token", async (input, init) => {
      requested = new Request(input, init)
      return imageResponse(png)
    })
    expect(requested?.headers.get("authorization")).toBe("Bearer xoxb-test-token")
    expect(requested?.redirect).toBe("manual")
    expect(attachment).toEqual({ uri: `data:image/png;base64,${btoa(String.fromCharCode(...png))}`, name: "photo.png" })
  })

  test("accepts JPEG and a same-host redirect", async () => {
    const urls: string[] = []
    const attachment = await downloadSlackImage([slackFile({
      mimetype: "image/jpeg", size: jpeg.length, url_private_download: "https://files.slack.com/a",
    })], "token", async (input) => {
      const url = String(input)
      urls.push(url)
      if (urls.length === 1) return new Response(null, { status: 302, headers: { location: "/b" } })
      return imageResponse(jpeg, "image/jpeg")
    })
    expect(urls).toEqual(["https://files.slack.com/a", "https://files.slack.com/b"])
    expect(attachment.uri.startsWith("data:image/jpeg;base64,")).toBe(true)
  })

  test("rejects multiple, unsupported, metadata-oversized, and malformed URLs before fetching", async () => {
    let fetches = 0
    const fetcher = async () => { fetches++; return imageResponse(png) }
    const cases: Array<[SlackFile[], string]> = [
      [[slackFile(), slackFile()], "count"],
      [[slackFile({ mimetype: "image/gif" })], "unsupported"],
      [[slackFile({ size: SLACK_IMAGE_MAX_BYTES + 1 })], "oversize"],
      [[slackFile({ url_private_download: "https://evil.example/a" })], "url"],
      [[slackFile({ url_private_download: "http://files.slack.com/a" })], "url"],
      [[slackFile({ url_private_download: "https://files.slack.com:444/a" })], "url"],
    ]
    for (const [files, code] of cases) {
      await expect(downloadSlackImage(files, "token", fetcher)).rejects.toMatchObject({ code })
    }
    expect(fetches).toBe(0)
  })

  test("never forwards the token to an external redirect", async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    await expect(downloadSlackImage([slackFile()], "sensitive-token", async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") })
      return new Response(null, { status: 302, headers: { location: "https://evil.example/collect" } })
    })).rejects.toMatchObject({ code: "url" })
    expect(seen).toEqual([{ url: "https://files.slack.com/files-pri/F123/download/photo.png", auth: "Bearer sensitive-token" }])
  })

  test("rejects streamed oversize content, MIME spoofing, and auth/error responses", async () => {
    const first = new Uint8Array(4 * 1024 * 1024)
    first.set(png)
    const second = new Uint8Array(SLACK_IMAGE_MAX_BYTES - first.length + 1)
    const streamedOversize = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(first); controller.enqueue(second); controller.close() },
    }), { headers: { "content-type": "image/png" } })
    await expect(downloadSlackImage([slackFile({ size: 1 })], "token", async () => streamedOversize))
      .rejects.toMatchObject({ code: "oversize" })
    await expect(downloadSlackImage([slackFile()], "token", async () => imageResponse(jpeg, "image/png")))
      .rejects.toMatchObject({ code: "mime" })
    await expect(downloadSlackImage([slackFile()], "token", async () => new Response("login", { status: 401 })))
      .rejects.toMatchObject({ code: "download" })
    await expect(downloadSlackImage([slackFile()], "token", async () => imageResponse(jpeg)))
      .rejects.toMatchObject({ code: "mime" })
  })

  test("rejects excessive redirects and missing auth configuration", async () => {
    await expect(downloadSlackImage([slackFile()], "token", async () => new Response(null, {
      status: 302, headers: { location: "/again" },
    }))).rejects.toMatchObject({ code: "redirect" })
    await expect(downloadSlackImage([slackFile()], "")).rejects.toMatchObject({ code: "download" })
  })

  test("times out while streaming a response body", async () => {
    const stalled = new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}) },
    }), { headers: { "content-type": "image/png" } })
    await expect(downloadSlackImage([slackFile()], "token", async () => stalled, 5))
      .rejects.toThrow("timed out")
  })

  test("does not wait for a redirect body whose cancellation never settles", async () => {
    let requests = 0
    const redirectBody = new ReadableStream<Uint8Array>({
      cancel() { return new Promise<void>(() => {}) },
    })
    const result = await downloadSlackImage([slackFile()], "token", async () => {
      requests++
      return requests === 1
        ? new Response(redirectBody, { status: 302, headers: { location: "/next" } })
        : imageResponse(png)
    }, 5)
    expect(result.uri.startsWith("data:image/png;base64,")).toBe(true)
    expect(requests).toBe(2)
  })

  test("does not wait for an oversized stream's cancellation promise", async () => {
    const first = new Uint8Array(4 * 1024 * 1024)
    first.set(png)
    const second = new Uint8Array(SLACK_IMAGE_MAX_BYTES - first.length + 1)
    const oversized = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(first); controller.enqueue(second); controller.close() },
      cancel() { return new Promise<void>(() => {}) },
    }), { headers: { "content-type": "image/png" } })
    await expect(downloadSlackImage([slackFile()], "token", async () => oversized, 5))
      .rejects.toMatchObject({ code: "oversize" })
  })
})

const model = (overrides: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "vision", modelID: "vision", providerID: "provider", name: "Vision",
  type: "chat", enabled: true, variants: [], capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  time: { released: 0 }, cost: [], status: "active", limit: { context: 1000, output: 1000 },
  ...overrides,
})

describe("Slack image model compatibility", () => {
  test("allows the exact enabled selected image-capable chat model", () => {
    const selected = model()
    expect(checkSlackImageModel({ providerID: "provider", id: "vision" }, [selected]))
      .toEqual({ status: "compatible", model: selected })
  })

  test("does not accept missing, disabled, non-chat, or non-image models", () => {
    const selected = { providerID: "provider", id: "vision" }
    expect(checkSlackImageModel(selected, undefined).status).toBe("unknown")
    expect(checkSlackImageModel(selected, [model({ enabled: false })]).status).toBe("unknown")
    expect(checkSlackImageModel(selected, [model({ type: "decision" })]).status).toBe("unknown")
    expect(checkSlackImageModel(selected, [model({ capabilities: { tools: true, input: ["text"], output: ["text"] } })]).status)
      .toBe("unsupported")
    const malformed = model({ capabilities: { tools: true, input: undefined as unknown as string[], output: ["text"] } })
    expect(checkSlackImageModel(selected, [malformed]).status).toBe("unknown")
  })

  test("suggestions include only enabled image-capable chat models and never mutate selection", () => {
    const candidates = [
      model(),
      model({ id: "disabled", enabled: false }),
      model({ id: "text", capabilities: { tools: true, input: ["text"], output: ["text"] } }),
      model({ id: "image-task", type: "image" }),
    ]
    const result = checkSlackImageModel({ providerID: "provider", id: "text" }, candidates)
    expect(result.status).toBe("unsupported")
    if (result.status !== "unsupported") throw new Error("expected unsupported result")
    expect(result.suggestions.map((item) => item.id)).toEqual(["vision"])
    expect(formatSlackImageModelSuggestions(result.suggestions)).toBe("provider/vision")
    const many = Array.from({ length: 8 }, (_, index) => model({ id: `vision-${index}` }))
    const limited = checkSlackImageModel({ providerID: "provider", id: "text" }, [...many, model({ id: "text", capabilities: { tools: true, input: ["text"], output: ["text"] } })])
    expect(limited.status).toBe("unsupported")
    if (limited.status !== "unsupported") throw new Error("expected unsupported result")
    expect(limited.suggestions).toHaveLength(5)
  })
})
