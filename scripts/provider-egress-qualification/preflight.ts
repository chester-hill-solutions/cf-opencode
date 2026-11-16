import { resolve } from "node:path"
import { QUALIFICATION_ARTIFACT } from "../native-storage-qualification/artifact"

/** Offline type generation and Wrangler bundle validation; creates no resources. */
const root = resolve(import.meta.dir, "../..")
const output = resolve(root, ".wrangler/provider-egress-preflight")
const accountID = "00000000000000000000000000000000"
const template = await Bun.file(resolve(import.meta.dir, "wrangler.template.jsonc")).text()
const config = JSON.parse(template.replace(/^\s*\/\/.*$/gm, ""))
config.name = `aboiteau-provider-egress-preflight-${crypto.randomUUID().slice(0, 8)}`
config.account_id = accountID
config.main = resolve(import.meta.dir, "worker.ts")
config.$schema = resolve(root, "node_modules/wrangler/config-schema.json")
config.containers[0].images.evented.image = QUALIFICATION_ARTIFACT.image
if (config.account_id !== accountID || config.name.includes("__SET_") ||
  config.containers.length !== 1 || config.containers[0].class_name !== "ProviderEgressQualification" ||
  config.durable_objects.bindings.length !== 1 || config.durable_objects.bindings[0].class_name !== "ProviderEgressQualification" ||
  config.durable_objects.bindings[0].name !== "CONVERSATION" ||
  config.exports.ProviderEgressQualification?.type !== "durable-object" ||
  config.exports.ProviderEgressQualification?.storage !== "sqlite" ||
  config.exports.QualificationProviderEgress?.type !== "worker" ||
  config.exports.QualificationProviderEgressFailure?.type !== "worker" ||
  config.containers[0].images.evented.image !== QUALIFICATION_ARTIFACT.image ||
  JSON.stringify(config.vars).includes("API_TOKEN") || JSON.stringify(config.vars).includes("PROVIDER_PROXY_API_KEY")) {
  throw new Error("provider egress preflight config is not isolated")
}
const configPath = resolve(output, "provider-egress-wrangler.json")
await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n")
for (const args of [
  ["types", resolve(output, "provider-egress-bindings.d.ts"), "--config", configPath,
    "--env-interface", "ProviderEgressQualificationBindings", "--include-runtime=false"],
  ["deploy", "--config", configPath, "--dry-run", "--outdir", resolve(output, "provider-egress-bundle")],
]) {
  const child = Bun.spawn([resolve(root, "node_modules/.bin/wrangler"), ...args], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: resolve(output, "provider-egress-wrangler.log"),
      WRANGLER_SEND_METRICS: "false",
    },
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`Wrangler provider-egress ${args[0]} preflight failed (${code})`)
}
console.log(`Offline provider-egress preflight passed: ${output}; no resources were created.`)
