import { makeClient, portFetch } from "../opencode"
import { ConversationStore } from "../state"
import type { ConversationRuntime } from "./runtime"
import type { ConversationRuntimeAccess } from "./runtime-access"

type OpenCodeClient = ReturnType<typeof makeClient>

export interface ConversationProviderOnboardingOptions {
  identity: { key(): string | undefined }
  runtime: Pick<ConversationRuntime, "port" | "pauseServer">
  access: Pick<ConversationRuntimeAccess, "useReady" | "useWarm">
  withClient<T>(operation: (client: OpenCodeClient) => Promise<T>, recoverOnRejection?: boolean): Promise<T>
  store: ConversationStore
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return JSON.stringify(error) } catch { return String(error) }
}

/** Owns provider diagnostics, credentials exposure, and onboarding proxy requests. */
export class ConversationProviderOnboarding {
  private operations = 0

  constructor(private readonly options: ConversationProviderOnboardingOptions) {}

  get activeOperations(): number { return this.operations }

  /** Internal-only source for a new legacy conversation's provider credentials. */
  async providerCredentials(request: Request): Promise<Response> {
    if (this.options.identity.key() !== "onboarding") return Response.json({ error: "forbidden" }, { status: 403 })
    if (request.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405 })
    try {
      const credentials = await this.options.withClient((client) => client.credential.list(), false)
      return Response.json(credentials.filter((credential) => credential.active && credential.value.type === "key"))
    } catch {
      return Response.json({ error: "provider credentials unavailable" }, { status: 503 })
    }
  }

  /** Read-only, secret-free provider diagnostics from the already warm runtime. */
  async debugProviders(): Promise<Response> {
    const state = await this.options.store.get()
    if (!state.sessionID) {
      return Response.json({ session: null, integrations: [], providers: [], models: [] })
    }
    const sessionID = state.sessionID
    try {
      return await this.options.access.useWarm(async (port) => {
        const client = makeClient(portFetch(port))
        const session = await client.session.get({ sessionID })
        const location = { directory: session.location.directory }
        const [integrations, providers, models] = await Promise.all([
          client.integration.list({ location }),
          client.provider.list({ location }),
          client.model.list({ location }),
        ])
        const result = {
          session: {
            id: session.id,
            location,
            ...(session.model
              ? {
                  model: {
                    providerID: session.model.providerID,
                    id: session.model.id,
                    ...(session.model.variant === undefined ? {} : { variant: session.model.variant }),
                  },
                }
              : {}),
          },
          integrations: integrations.data.map((integration) => ({
            id: integration.id,
            connections: integration.connections.map((connection, index) => ({
              type: connection.type,
              ...(connection.type === "credential" ? { id: connection.id, method: connection.method } : {}),
              ...(index === 0 ? { selected: true } : {}),
            })),
          })),
          providers: providers.data.map((provider) => ({
            id: provider.id,
            activation: provider.activation,
            ...(provider.integrationID ? { integrationID: provider.integrationID } : {}),
          })),
          models: models.data.map((model) => ({
            providerID: model.providerID,
            id: model.id,
            enabled: model.enabled,
            type: model.type ?? "chat",
          })),
        }
        return Response.json(result)
      })
    } catch {
      return Response.json({ error: "provider diagnostics unavailable" }, { status: 503 })
    }
  }

  /** Onboarding traffic: catalogues use the SDK; approved control paths are proxied. */
  async onboarding(pathname: string, request: Request): Promise<Response> {
    const blocksSettingsRestart = this.options.identity.key() === "onboarding"
    if (blocksSettingsRestart) this.operations++
    try {
      const path = pathname.slice("/onboarding".length) || "/"
      try {
        if (request.method === "GET" && path === "/integrations") {
          const integrations = await this.options.withClient((client) => client.integration.list(), false)
          return Response.json(integrations)
        }
        if (request.method === "GET" && path === "/models") {
          const models = await this.options.withClient(
            (client) => client.model.list({ location: { directory: "/workspace" } }),
            false,
          )
          return Response.json(models)
        }
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
        return await this.options.access.useReady(async () => {
          const control = await this.options.runtime.port(4001)
          const res = await control.fetch(`http://container${path}`, {
            method: request.method,
            ...(body === undefined ? {} : { body }),
            signal: AbortSignal.timeout(120_000),
          })
          // Consume the complete control response while this runtime generation is borrowed.
          const bytes = await res.arrayBuffer()
          if (path === "/state-checkpoint" && res.ok) this.options.runtime.pauseServer()
          const headers = new Headers(res.headers)
          headers.delete("content-encoding")
          headers.delete("content-length")
          return new Response(bytes.byteLength ? bytes : null, { status: res.status, headers })
        })
      } catch (error) {
        return Response.json(
          { error: errorMessage(error), retryable: true },
          { status: 503 },
        )
      }
    } finally {
      if (blocksSettingsRestart) this.operations--
    }
  }
}
