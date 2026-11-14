import { resolve } from "node:path"
import { QUALIFICATION_ARTIFACT } from "./artifact"

/** Offline build validation only: no resources, secrets, image pushes or deploys. */
const root = resolve(import.meta.dir, "../..")
const output = resolve(root, ".wrangler/native-storage-preflight")
const accountID = "00000000000000000000000000000000"
for (const [fixture, templateName, main, doClass, envInterface] of [
  ["native-storage", "wrangler.template.jsonc", "worker.ts", "QualificationConversation", "QualificationBindings"],
  ["account-seed", "account-seed-wrangler.template.jsonc", "account-seed.ts", "AccountSeedConversation", "AccountSeedBindings"],
] as const) {
  // These controlled templates have whole-line comments and otherwise valid JSON.
  const template = await Bun.file(resolve(import.meta.dir, templateName)).text()
  const config = JSON.parse(template.replace(/^\s*\/\/.*$/gm, ""))
  config.name = `aboiteau-${fixture}-preflight-${crypto.randomUUID().slice(0, 8)}`
  config.account_id = accountID
  config.main = resolve(import.meta.dir, main)
  config.$schema = resolve(root, "node_modules/wrangler/config-schema.json")
  config.containers[0].images.evented.image = QUALIFICATION_ARTIFACT.image
  config.containers[0].class_name = doClass
  config.durable_objects.bindings[0].class_name = doClass
  config.r2_buckets[0].bucket_name = config.name
  if (config.account_id !== accountID || config.name.includes("__SET_") || config.r2_buckets[0].bucket_name.includes("__SET_")) {
    throw new Error(`${fixture} preflight config is not isolated and non-deployable`)
  }
  const configPath = resolve(output, `${fixture}-wrangler.json`)
  await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n")

  for (const args of [
    ["types", resolve(output, `${fixture}-bindings.d.ts`), "--config", configPath,
      "--env-interface", envInterface, "--include-runtime=false"],
    ["deploy", "--config", configPath, "--dry-run", "--outdir", resolve(output, `${fixture}-bundle`)],
  ]) {
    const child = Bun.spawn([resolve(root, "node_modules/.bin/wrangler"), ...args], {
      cwd: root, stdout: "inherit", stderr: "inherit",
      env: { ...process.env, WRANGLER_LOG_PATH: resolve(output, `${fixture}-wrangler.log`), WRANGLER_SEND_METRICS: "false" },
    })
    const code = await child.exited
    if (code !== 0) throw new Error(`Wrangler ${fixture} ${args[0]} preflight failed (${code})`)
  }
}
console.log(`Offline preflight passed. Generated files: ${output}; no resources were created.`)
