import type { ModelInfo, SessionPromptInput } from "@opencode/client"

export const SLACK_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const SLACK_IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000
const SLACK_FILES_HOST = "files.slack.com"
type SlackImageFetch = (url: string, init: { headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => Promise<Response>

export type SlackFile = {
  id?: string
  name?: string
  mimetype?: string
  size?: number
  url_private?: string
  url_private_download?: string
}

export type SlackImageErrorCode =
  | "count"
  | "unsupported"
  | "oversize"
  | "url"
  | "download"
  | "redirect"
  | "mime"

export class SlackImageError extends Error {
  constructor(readonly code: SlackImageErrorCode, message: string) {
    super(message)
    this.name = "SlackImageError"
  }
}

export type SlackImageAttachment = NonNullable<SessionPromptInput["files"]>[number]

/** Validate and fetch the single current-message image into OpenCode's inline URI format. */
export async function downloadSlackImage(
  files: readonly SlackFile[],
  botToken: string,
  fetcher: SlackImageFetch = fetch as SlackImageFetch,
  timeoutMs = SLACK_IMAGE_DOWNLOAD_TIMEOUT_MS,
): Promise<SlackImageAttachment> {
  if (files.length !== 1) {
    throw new SlackImageError("count", "Please attach exactly one PNG or JPEG image.")
  }
  if (!botToken) throw new SlackImageError("download", "Slack file access is not configured.")
  const file = files[0]
  const mime = normalizeSupportedMime(file.mimetype)
  if (!mime) throw new SlackImageError("unsupported", "Please attach a PNG or JPEG image.")
  if (file.size !== undefined && (!Number.isFinite(file.size) || file.size < 0 || file.size > SLACK_IMAGE_MAX_BYTES)) {
    throw new SlackImageError("oversize", "Images must be 5 MiB or smaller.")
  }

  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await downloadSlackImageBytes(file, mime, botToken, fetcher, controller.signal)
  } catch (error) {
    if (timedOut) throw new SlackImageError("download", "Slack image download timed out. Please try again.")
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function downloadSlackImageBytes(
  file: SlackFile,
  mime: "image/png" | "image/jpeg",
  botToken: string,
  fetcher: SlackImageFetch,
  signal: AbortSignal,
): Promise<SlackImageAttachment> {
  let url = validateSlackFileUrl(file.url_private_download ?? file.url_private)
  let response: Response | undefined
  for (let redirects = 0; redirects <= 3; redirects++) {
    try {
      response = await withAbort(fetcher(url, {
        headers: { Authorization: `Bearer ${botToken}` },
        redirect: "manual",
        signal,
      }), signal)
    } catch {
      throw new SlackImageError("download", "Slack image download failed. Please try attaching it again.")
    }
    if (response.status < 300 || response.status >= 400) break
    if (redirects === 3) throw new SlackImageError("redirect", "Slack file download redirected too many times.")
    const location = response.headers.get("location")
    if (!location) throw new SlackImageError("redirect", "Slack file download returned an invalid redirect.")
    let redirectUrl: string
    try {
      redirectUrl = new URL(location, url).toString()
    } catch {
      throw new SlackImageError("redirect", "Slack file download returned an invalid redirect.")
    }
    const next = validateSlackFileUrl(redirectUrl)
    if (new URL(next).host !== SLACK_FILES_HOST) {
      throw new SlackImageError("redirect", "Slack file download redirected outside Slack.")
    }
    // A hostile/interrupted body can leave cancellation pending. The timeout
    // bounds the download itself; never let best-effort cleanup hold admission.
    void response.body?.cancel().catch(() => {})
    url = next
  }
  if (!response?.ok) {
    throw new SlackImageError("download", "Slack could not provide that image. Please try attaching it again.")
  }

  const declaredResponseMime = normalizeContentType(response.headers.get("content-type"))
  if (declaredResponseMime && declaredResponseMime !== "application/octet-stream" && declaredResponseMime !== mime) {
    throw new SlackImageError("mime", "The image type did not match Slack's file information.")
  }
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > SLACK_IMAGE_MAX_BYTES) {
    throw new SlackImageError("oversize", "Images must be 5 MiB or smaller.")
  }
  if (!response.body) throw new SlackImageError("download", "Slack returned an empty image download.")

  let bytes: Uint8Array
  try {
    bytes = await readLimited(response.body, SLACK_IMAGE_MAX_BYTES, signal)
  } catch (error) {
    if (error instanceof SlackImageError) throw error
    throw new SlackImageError("download", "Slack image download was interrupted. Please try again.")
  }
  const actualMime = sniffImageMime(bytes)
  if (actualMime !== mime) throw new SlackImageError("mime", "The image contents did not match its PNG/JPEG type.")
  const base64 = bytesToBase64(bytes)
  return {
    uri: `data:${mime};base64,${base64}`,
    ...(file.name ? { name: file.name } : {}),
  }
}

export type SelectedModel = { providerID: string; id: string }
export type ImageModelCheck =
  | { status: "compatible"; model: ModelInfo }
  | { status: "unknown"; suggestions: ModelInfo[] }
  | { status: "unsupported"; suggestions: ModelInfo[] }

/** Pure metadata check. It does not switch models, make provider calls, or send a prompt. */
export function checkSlackImageModel(
  selected: SelectedModel | undefined,
  models: readonly ModelInfo[] | undefined,
): ImageModelCheck {
  const suggestions = (models ?? []).filter(isEnabledChatVisionModel).slice(0, 5)
  if (!selected || !models) return { status: "unknown", suggestions }
  const model = models.find((item) => item.providerID === selected.providerID && item.id === selected.id)
  if (!model || !model.enabled || (model.type !== undefined && model.type !== "chat")) {
    return { status: "unknown", suggestions }
  }
  if (!validImageCapabilities(model)) return { status: "unknown", suggestions }
  if (!hasImageInput(model)) return { status: "unsupported", suggestions }
  return { status: "compatible", model }
}

export function formatSlackImageModelSuggestions(models: readonly ModelInfo[]): string {
  return models.map((model) => `${model.providerID}/${model.id}`).join(", ")
}

function isEnabledChatVisionModel(model: ModelInfo): boolean {
  return model.enabled && (model.type === undefined || model.type === "chat") && validImageCapabilities(model) && hasImageInput(model)
}

function hasImageInput(model: ModelInfo): boolean {
  return model.capabilities.input.some((input) => input.startsWith("image"))
}

function validImageCapabilities(model: ModelInfo): boolean {
  const input: unknown = model.capabilities?.input
  return Array.isArray(input) && input.every((item) => typeof item === "string")
}

function normalizeSupportedMime(value: string | undefined): "image/png" | "image/jpeg" | undefined {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase()
  return mime === "image/png" || mime === "image/jpeg" ? mime : undefined
}

function normalizeContentType(value: string | null): string | undefined {
  if (!value) return undefined
  return value.split(";", 1)[0]?.trim().toLowerCase()
}

function validateSlackFileUrl(value: string | undefined): string {
  if (!value) throw new SlackImageError("url", "Slack did not provide a downloadable image URL.")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SlackImageError("url", "Slack provided an invalid image URL.")
  }
  if (url.protocol !== "https:" || url.hostname !== SLACK_FILES_HOST || url.port || url.username || url.password) {
    throw new SlackImageError("url", "Image downloads are restricted to Slack's secure file host.")
  }
  return url.toString()
}

async function readLimited(stream: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const cancelOnAbort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancelOnAbort, { once: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (signal.aborted) throw new SlackImageError("download", "Slack image download timed out. Please try again.")
      if (done) break
      size += value.byteLength
      if (size > limit) {
        // Cancellation is cleanup only. Some streams never settle this promise.
        void reader.cancel().catch(() => {})
        throw new SlackImageError("oversize", "Images must be 5 MiB or smaller.")
      }
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort)
    reader.releaseLock()
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("Slack image download aborted")
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Slack image download aborted"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

function sniffImageMime(bytes: Uint8Array): "image/png" | "image/jpeg" | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  return undefined
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}
