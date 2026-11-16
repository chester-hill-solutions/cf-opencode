import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Plugin, Provider, Model } from "@opencode/plugin"
import { UncertainToolOutcome, type ToolPlane } from "./linux"
import { sha256, type TaskJournal } from "./journal"

export const taskProviderID = "r0-23-task-provider"
function isInput(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
export const taskToolInstructions = "The read/write/edit/shell tools operate in the disposable Linux repository /workspace/r0-23. Paths are relative to that repository. Run checks with shell. Only these four tools are provided; do not use host filesystem or process APIs."

export async function executeTaskTool(plane: ToolPlane, journal: TaskJournal, id: string, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const cached = await journal.beginTool(id, name, await sha256(JSON.stringify(input)))
  if (cached !== null) return cached
  let result: string
  try {
    result = await plane.execute(name, input, signal)
  } catch (error) {
    await journal.finishTool(id, null, error instanceof UncertainToolOutcome)
    throw error
  }
  try { await journal.finishTool(id, result) }
  catch (error) {
    // A lost commit acknowledgement does not mean the already executed tool failed.
    await journal.fail("tool receipt persistence unconfirmed; automatic continuation refused").catch(() => {})
    throw error
  }
  return result
}

export function taskPlugin(plane: ToolPlane, model: LanguageModelV3, journal: TaskJournal, limits: { context: number; output: number }) {
  return Plugin.define({ id: "r0-23.linux-task", async setup(ctx) {
    await ctx.provider.transform(editor => editor.add({ info: { id: Provider.ID.make(taskProviderID), name: "R0-23 configured provider", activation: "enabled", package: "aisdk:r0-23-task" },
      models: [{ ...Model.Info.default(Provider.ID.make(taskProviderID), Model.ID.make(model.modelId)), package: "aisdk:r0-23-task", limit: limits }] }))
    await ctx.aisdk.hook("sdk", event => { event.sdk = { languageModel: () => model } }, { providerID: Provider.ID.make(taskProviderID) })
    // This explicit policy permits the four tools in the owned disposable container.
    // It does not claim repository isolation inside that container.
    await ctx.permission.hook("evaluate", event => {
      if (event.action === "r0_23_tool" && event.resources.every(name => ["read", "write", "edit", "shell"].includes(name))) event.effect = "allow"
    })
    await ctx.tool.transform(tools => {
      for (const tool of tools.list()) tools.remove(tool.id)
      for (const name of ["read", "write", "edit", "shell"] as const) {
        const properties = name === "shell" ? { command: { type: "string" as const } }
          : name === "write" ? { path: { type: "string" as const }, content: { type: "string" as const } }
          : name === "edit" ? { path: { type: "string" as const }, oldText: { type: "string" as const }, newText: { type: "string" as const } }
          : { path: { type: "string" as const } }
        tools.add({ name, description: "Disposable Linux repository tool: " + name, options: { codemode: false },
          input: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
          async execute(input, context) {
            if (!isInput(input)) throw new Error("invalid tool input")
            await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, action: "r0_23_tool", resources: [name], source: { type: "tool", messageID: context.messageID, id: context.id } })
            return { content: await executeTaskTool(plane, journal, String(context.id), name, input, context.signal) }
          },
        })
      }
    })
  } })
}
