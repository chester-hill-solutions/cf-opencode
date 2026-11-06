/**
 * Curated model catalogue for the settings selector.
 *
 * The harness cannot enumerate provider models without starting a container, so
 * this is a known-good list with cost/speed tags. `model` stays free-form in
 * settings: the selector offers these, and "Custom…" accepts anything the
 * deployment's providers expose.
 */

export interface ModelOption {
  providerID: string
  id: string
  name: string
  /** provider/id */
  ref: string
  cost: "free" | "low" | "medium" | "high"
  tags: string[]
  recommended?: boolean
}

export const MODEL_CATALOG: ModelOption[] = [
  {
    providerID: "opencode",
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    ref: "opencode/deepseek-v4.1-flash",
    cost: "low",
    tags: ["fast", "tools"],
    recommended: true,
  },
  {
    providerID: "opencode",
    id: "deepseek-v4.1-flash-free",
    name: "DeepSeek V4.1 Flash Free",
    ref: "opencode/deepseek-v4.1-flash-free",
    cost: "free",
    tags: ["fast", "tools"],
  },
  {
    providerID: "opencode",
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    ref: "opencode/deepseek-v4-pro",
    cost: "medium",
    tags: ["reasoning", "tools"],
  },
  {
    providerID: "opencode-go",
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash (Go)",
    ref: "opencode-go/deepseek-v4.1-flash",
    cost: "low",
    tags: ["fast", "tools"],
  },
  {
    providerID: "opencode-go",
    id: "kimi-k3.1-pro",
    name: "Kimi K3.1 Pro",
    ref: "opencode-go/kimi-k3.1-pro",
    cost: "medium",
    tags: ["long-context", "tools"],
  },
  {
    providerID: "opencode-go",
    id: "hy4",
    name: "Hy4",
    ref: "opencode-go/hy4",
    cost: "medium",
    tags: ["tools"],
  },
  {
    providerID: "openai",
    id: "gpt-6.1-terra-fast",
    name: "GPT-6.1 Terra Fast",
    ref: "openai/gpt-6.1-terra-fast",
    cost: "medium",
    tags: ["fast", "tools"],
  },
  {
    providerID: "openai",
    id: "gpt-6.1-terra",
    name: "GPT-6.1 Terra",
    ref: "openai/gpt-6.1-terra",
    cost: "high",
    tags: ["reasoning", "tools"],
  },
]

/** Pick the catalogue entry the harness recommends. */
export function recommendModel(models: ModelOption[] = MODEL_CATALOG): ModelOption {
  return models.find((model) => model.recommended) ?? models[0]!
}

export function groupByProvider(models: ModelOption[] = MODEL_CATALOG): Record<string, ModelOption[]> {
  const groups: Record<string, ModelOption[]> = {}
  for (const model of models) {
    ;(groups[model.providerID] ??= []).push(model)
  }
  return groups
}

export function findModel(ref: string, models: ModelOption[] = MODEL_CATALOG): ModelOption | undefined {
  return models.find((model) => model.ref === ref)
}
