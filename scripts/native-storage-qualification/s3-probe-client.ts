import { createHash, createHmac } from "node:crypto"
import { connect } from "node:net"

export type ProbeCredentials = { endpoint: string; region: string; bucket: string; access_key_id: string; secret_access_key: string }
export type ProbeResponse = { status: number; headers: Record<string, string>; body: Buffer }
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)

/** Raw path is intentional: URL/fetch normalization would invalidate traversal probes. */
export function signedRequest(credentials: ProbeCredentials, method: string, key: string,
  options: { query?: Record<string, string>; headers?: Record<string, string>; body?: Uint8Array; now?: Date } = {},
): { path: string; headers: Record<string, string> } {
  const endpoint = new URL(credentials.endpoint)
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\/?$/.test(credentials.endpoint)) throw new Error("loopback S3 endpoint required")
  const path = `/${encode(credentials.bucket)}/${key.split("/").map(encode).join("/")}`
  const query = Object.entries(options.query ?? {}).map(([key, value]) => [encode(key), encode(value)])
    .sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("&")
  const timestamp = (options.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "")
  const day = timestamp.slice(0, 8)
  const payloadHash = digest(options.body ?? new Uint8Array())
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    host: endpoint.host, "x-amz-date": timestamp, "x-amz-content-sha256": payloadHash,
  }
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, " ")}\n`).join("")
  const canonical = [method, path, query, canonicalHeaders, names.join(";"), payloadHash].join("\n")
  const scope = `${day}/${credentials.region}/s3/aws4_request`
  const hmac = (key: string | Buffer, message: string) => createHmac("sha256", key).update(message).digest()
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secret_access_key}`, day), credentials.region), "s3"), "aws4_request")
  const signature = createHmac("sha256", signingKey).update(`AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${digest(canonical)}`).digest("hex")
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.access_key_id}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`
  return { path: path + (query ? `?${query}` : ""), headers }
}

/** Fixed HTTP/1.1 subset for the loopback probe; reject truncated/oversized bodies. */
export function parseProbeResponse(bytes: Buffer, method: string): ProbeResponse {
  const split = bytes.indexOf("\r\n\r\n")
  if (split < 0 || split > 16_384) throw new Error("invalid probe response headers")
  const lines = bytes.subarray(0, split).toString().split("\r\n")
  const status = Number(lines.shift()?.match(/^HTTP\/1\.[01] (\d{3}) /)?.[1])
  if (status < 100 || status > 599 || !Number.isFinite(status)) throw new Error("invalid probe response status")
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const colon = line.indexOf(":")
    if (colon <= 0) throw new Error("invalid probe header")
    const name = line.slice(0, colon).toLowerCase()
    if (headers[name] !== undefined) throw new Error("duplicate probe response header")
    headers[name] = line.slice(colon + 1).trim()
  }
  const raw = bytes.subarray(split + 4)
  let body: Buffer = raw
  if (method === "HEAD") {
    if (raw.length) throw new Error("unexpected HEAD body")
  } else if (headers["transfer-encoding"]?.toLowerCase() === "chunked") {
    const chunks: Buffer[] = []
    let cursor = 0
    for (;;) {
      const end = raw.indexOf("\r\n", cursor)
      if (end < 0) throw new Error("truncated probe chunk")
      const sizeText = raw.subarray(cursor, end).toString().split(";")[0]
      if (!/^[a-fA-F0-9]+$/.test(sizeText)) throw new Error("invalid probe chunk")
      const size = Number.parseInt(sizeText, 16)
      cursor = end + 2
      if (size === 0) { if (raw.indexOf("\r\n", cursor) < 0) throw new Error("truncated probe trailer"); break }
      if (size > 256 * 1024 || cursor + size + 2 > raw.length || raw.subarray(cursor + size, cursor + size + 2).toString() !== "\r\n") throw new Error("invalid probe chunk bound")
      chunks.push(raw.subarray(cursor, cursor + size)); cursor += size + 2
    }
    body = Buffer.concat(chunks)
  } else if (headers["transfer-encoding"]) throw new Error("unsupported probe encoding")
  else if (headers["content-length"] !== undefined && Number(headers["content-length"]) !== raw.length) throw new Error("truncated probe response")
  if (body.length > 256 * 1024) throw new Error("probe response exceeded bound")
  return { status, headers, body }
}

/** Raw TCP avoids Bun's node:http URL normalization. No redirects or retries. */
export async function s3Request(credentials: ProbeCredentials, method: string, key: string,
  options: { query?: Record<string, string>; headers?: Record<string, string>; body?: Uint8Array } = {},
): Promise<ProbeResponse> {
  const signed = signedRequest(credentials, method, key, options)
  const endpoint = new URL(credentials.endpoint)
  return await new Promise((resolve, reject) => {
    const socket = connect({ host: endpoint.hostname.replace(/^\[|\]$/g, ""), port: Number(endpoint.port || 80) })
    const chunks: Buffer[] = []
    let length = 0
    let ended = false
    const timer = setTimeout(() => { reject(new Error("probe request timed out")); socket.destroy() }, 8_000)
    socket.on("connect", () => {
      const headers = { ...signed.headers, "content-length": String(options.body?.byteLength ?? 0), connection: "close" }
      socket.write(`${method} ${signed.path} HTTP/1.1\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`)
      if (options.body) socket.write(options.body)
    })
    socket.on("data", (chunk: Buffer) => {
      length += chunk.length
      if (length > 272 * 1024) { reject(new Error("probe response exceeded bound")); socket.destroy(); return }
      chunks.push(chunk)
    })
    socket.on("error", reject)
    socket.on("end", () => {
      ended = true
      try { resolve(parseProbeResponse(Buffer.concat(chunks), method)) } catch (error) { reject(error) }
    })
    socket.on("close", () => { clearTimeout(timer); if (!ended) reject(new Error("probe connection closed before response end")) })
  })
}
