import { resolve } from "node:path"
import { QUALIFICATION_ARTIFACT } from "./artifact"

/** Offline build validation only: no resources, secrets, image pushes or deploys. */
const root = resolve(import.meta.dir, "../..")
const output = resolve(root, ".wrangler/native-storage-preflight")
const template = await Bun.file(resolve(import.meta.dir, "wrangler.template.jsonc")).text()
// This controlled template has whole-line comments and otherwise valid JSON.
const config = JSON.parse(template.replace(/^\s*\/\/.*$/gm, ""))
config.name = `aboiteau-storage-preflight-${crypto.randomUUID().slice(0, 8)}`
// Deliberately non-deployable account. A later live run needs its own config.
config.account_id = "00000000000000000000000000000000"
config.main = resolve(import.meta.dir, "worker.ts")
config.$schema = resolve(root, "node_modules/wrangler/config-schema.json")
config.containers[0].images.evented.image = QUALIFICATION_ARTIFACT.image
config.r2_buckets[0].bucket_name = config.name
const configPath = resolve(output, "wrangler.json")
await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n")

for (const args of [
  ["types", resolve(output, "bindings.d.ts"), "--config", configPath,
    "--env-interface", "QualificationBindings", "--include-runtime=false"],
  ["deploy", "--config", configPath, "--dry-run", "--outdir", resolve(output, "bundle")],
]) {
  const child = Bun.spawn([resolve(root, "node_modules/.bin/wrangler"), ...args], {
    cwd: root, stdout: "inherit", stderr: "inherit",
    env: { ...process.env, WRANGLER_LOG_PATH: resolve(output, "wrangler.log"), WRANGLER_SEND_METRICS: "false" },
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`Wrangler ${args[0]} preflight failed (${code})`)
}
console.log(`Offline preflight passed. Generated files: ${output}; no resources were created.`)
