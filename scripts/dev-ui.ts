import { staticAsset } from "./ui-server"

const build = Bun.spawnSync([process.execPath, "run", "build:ui"], {
  stdout: "inherit",
  stderr: "inherit",
})
if (build.exitCode !== 0) process.exit(build.exitCode)
const upstream = process.env.ABOITEAU_API_ORIGIN
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT || 4173),
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/api/")) {
      if (!upstream)
        return Response.json(
          {
            error:
              "No API is connected to this local UI preview. Run the Worker, or set ABOITEAU_API_ORIGIN when starting dev:ui.",
          },
          { status: 503 }
        )
      const target = new URL(url.pathname + url.search, upstream)
      try {
        return await fetch(new Request(target, request))
      } catch {
        return Response.json({ error: "The configured API could not be reached." }, { status: 502 })
      }
    }
    return staticAsset(request)
  },
})
console.log("Aboiteau settings: " + server.url)
console.log("UI kit: " + new URL("ui-kit/", server.url))
console.log(upstream ? "API proxy: " + upstream : "Local UI preview; API not connected.")
