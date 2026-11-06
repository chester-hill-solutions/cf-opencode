import { DurableObject } from "cloudflare:workers"
import { defaultSettings, validateSettings, type HarnessSettings } from "./settings"
import type { Env } from "./env"

/** Singleton Durable Object holding the harness-wide settings. */
export class Settings extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/get") return Response.json(await this.current())

    if (url.pathname === "/put" && request.method === "POST") {
      const current = await this.current()
      const result = validateSettings(await request.json(), current)
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 })

      const next: HarnessSettings = {
        ...result.value,
        version: current.version + 1,
        updatedAt: Date.now(),
      }
      await this.ctx.storage.put("settings", next)
      return Response.json(next)
    }

    return new Response("not found", { status: 404 })
  }

  async current(): Promise<HarnessSettings> {
    const stored = await this.ctx.storage.get<HarnessSettings>("settings")
    return stored ?? defaultSettings(this.env)
  }
}
