import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { createServer as rawServer } from "node:net"
import { signedRequest, s3Request, parseProbeResponse } from "./s3-probe-client"

const credentials = { endpoint: "http://127.0.0.1:9000", bucket: "fixture", region: "us-east-1", access_key_id: "synthetic-id", secret_access_key: "synthetic-key" }

describe("bounded raw S3 qualification transport", () => {
  test("preserves dot segments and percent literals instead of normalizing the request target", () => {
    const target = signedRequest(credentials, "PUT", "matrix/../space %2F#?.txt", {
      query: { uploadId: "id/with+punctuation", partNumber: "1" }, now: new Date("2026-11-14T12:34:56Z"),
    })
    expect(target.path).toBe("/fixture/matrix/../space%20%252F%23%3F.txt?partNumber=1&uploadId=id%2Fwith%2Bpunctuation")
    expect(target.headers["x-amz-date"]).toBe("20261114T123456Z")
    expect(target.headers.authorization).toContain("Credential=synthetic-id/20261114/us-east-1/s3/aws4_request")
    expect(target.headers.authorization).not.toContain("synthetic-key")
    expect(() => signedRequest({ ...credentials, endpoint: "https://example.com" }, "GET", "file")).toThrow("loopback")
    expect(() => signedRequest({ ...credentials, endpoint: "http://127.0.0.1:9000/other" }, "GET", "file")).toThrow("loopback")
  })

  test("sends the exact raw path and returns redirects without following them", async () => {
    const requests: string[] = []
    const server = rawServer((socket) => {
      socket.once("data", (bytes) => {
        requests.push(bytes.toString().split("\r\n")[0].split(" ")[1])
        socket.end("HTTP/1.1 302 Found\r\nLocation: http://example.invalid/must-not-follow\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("listener unavailable")
    try {
      const result = await s3Request({ ...credentials, endpoint: `http://127.0.0.1:${address.port}` }, "GET", "a/../b")
      expect(result.status).toBe(302)
      expect(requests).toEqual(["/fixture/a/../b"])
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  test("rejects an oversized response rather than capturing arbitrary server output", async () => {
    const server = createServer((_request, response) => response.end(Buffer.alloc(300 * 1024, 120)))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("listener unavailable")
    try {
      await expect(s3Request({ ...credentials, endpoint: `http://127.0.0.1:${address.port}` }, "GET", "file")).rejects.toThrow("bound")
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  test("decodes bounded chunks and rejects truncated HTTP bodies", () => {
    expect(parseProbeResponse(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n"), "GET").body.toString()).toBe("abc")
    expect(() => parseProbeResponse(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc"), "GET")).toThrow("truncated")
    expect(() => parseProbeResponse(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabc"), "GET")).toThrow()
  })
})
