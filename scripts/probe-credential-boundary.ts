/**
 * R0-19 evidence only. Runs a disposable, network-disabled image with synthetic
 * state; exit 2 means KNOWN_OPEN_G1, not a passing security test. No provider call.
 * Usage: IMAGE=cf-opencode:smoke bun scripts/probe-credential-boundary.ts
 */
import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(import.meta.url)
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

function run(cmd: string[], cwd?: string) {
  const result = Bun.spawnSync(cmd, {
    stdin: "ignore", cwd,
    stdout: "pipe", stderr: "pipe", timeout: 120_000,
  })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

function requireSuccess(cmd: string[]): string {
  const result = run(cmd)
  if (result.code !== 0) throw new Error(`${cmd[0]} ${cmd[1]} failed (${result.code}): ${result.stderr.slice(0, 1000)}`)
  return result.stdout.trim()
}

async function inside() {
  // The host creates a fresh container, passes no secrets, mounts no volumes,
  // and disables networking. Refuse accidental invocation in another context.
  if (process.env.ABOITEAU_SYNTHETIC_PROBE !== "R0-19") throw new Error("disposable probe container required")
  const credential = "/var/lib/aboiteau/state/config/opencode/opencode.json"
  const marker = "R0-19-SYNTHETIC-CREDENTIAL-ONLY"
  await Bun.write(credential, JSON.stringify({ provider: { synthetic: { apiKey: marker } } }))
  const repoTest = "/workspace/credential-probe.test.ts"
  await Bun.write(repoTest, `import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
test("synthetic credential observation", () => {
  const bytes = readFileSync(process.env.HOME + "/config/opencode/opencode.json", "utf8")
  expect(bytes).toContain(${JSON.stringify(marker)})
  console.log("R0-19:repo-read-observed")
})
`)
  requireSuccess(["chown", "1001:1001", credential, repoTest])
  requireSuccess(["chmod", "0660", credential])
  const asAgent = ["setpriv", "--reuid=1001", "--regid=1001", "--init-groups", "env",
    "-u", "CONTROL_TOKEN", "HOME=/var/lib/aboiteau/state", "XDG_CONFIG_HOME=/var/lib/aboiteau/state/config"]
  const find = run([...asAgent, "find", "/var/lib/aboiteau", "-name", "opencode.json", "-exec", "cat", "{}", ";"])
  const repo = run([...asAgent, "bun", "test", "credential-probe.test.ts"], "/workspace")
  const reads = {
    find: { exitCode: find.code, recoveredSyntheticCredential: find.stdout.includes(marker) },
    repositoryCode: { exitCode: repo.code, recoveredSyntheticCredential: repo.stdout.includes("R0-19:repo-read-observed") },
  }
  const artifactFiles = Object.fromEntries(await Promise.all([
    "/app/entrypoint.sh", "/app/src/permissions.ts", "/app/runtime/opencode/bun.lock",
  ].map(async (path) => [path, sha256(await Bun.file(path).text())])))
  return { reads, artifactFiles,
    finding: reads.find.recoveredSyntheticCredential || reads.repositoryCode.recoveredSyntheticCredential
      ? "KNOWN_OPEN_G1" : "REQUIRES_G1_REQUALIFICATION" }
}

if (process.argv.includes("--inside")) {
  console.log(JSON.stringify(await inside()))
} else {
  const root = resolve(dirname(script), "..")
  // Evaluate with the pinned OpenCode matcher on the host; importing its large
  // dependency graph under QEMU is unnecessary for the OS read observation.
  const { buildPermissionRules } = await import("../src/permissions.ts")
  const { DEFAULT_ALLOW, DEFAULT_DENY } = await import("../src/settings.ts")
  const { match } = await import("../runtime/opencode/node_modules/@opencode/core/dist/util/wildcard.js")
  const rules = buildPermissionRules({ allow: DEFAULT_ALLOW, deny: DEFAULT_DENY })
  const commands = {
    literal: "cat /var/lib/aboiteau/state/config/opencode/opencode.json",
    find: "find /var/lib/aboiteau -name opencode.json -exec cat {} \\;",
    repo: "bun test credential-probe.test.ts",
  }
  const effect = (command: string) => rules.filter((rule) => rule.action === "shell" && match(command, rule.resource)).at(-1)?.effect
  const policy = { literal: effect(commands.literal), find: effect(commands.find), repo: effect(commands.repo) }
  if (policy.literal !== "deny" || policy.find !== "allow" || policy.repo !== "allow") {
    throw new Error("policy changed; review the probe before executing it")
  }
  const image = process.env.IMAGE ?? "cf-opencode:smoke"
  const artifact = JSON.parse(requireSuccess(["docker", "image", "inspect", image]))[0]
  const name = `aboiteau-r0-19-${crypto.randomUUID()}`
  let created = false
  try {
    requireSuccess(["docker", "run", "--pull=never", "--network=none", "--platform", `${artifact.Os}/${artifact.Architecture}`,
      "--detach", "--name", name, "--env", "ABOITEAU_SYNTHETIC_PROBE=R0-19",
      "--env", "CONTROL_TOKEN=R0-19-SYNTHETIC-CONTROL-TOKEN", artifact.Id])
    created = true
    requireSuccess(["docker", "exec", name, "bash", "-c",
      "for i in {1..100}; do if test -d /var/lib/aboiteau/state/config/opencode; then exit 0; fi; sleep 0.1; done; exit 1"])
    requireSuccess(["docker", "cp", script, `${name}:/tmp/probe-credential-boundary.ts`])
    const observation = JSON.parse(requireSuccess(["docker", "exec", name, "bun", "/tmp/probe-credential-boundary.ts", "--inside"]))
    for (const [artifactPath, sourcePath] of [
      ["/app/src/permissions.ts", "src/permissions.ts"],
      ["/app/entrypoint.sh", "entrypoint.sh"],
      ["/app/runtime/opencode/bun.lock", "runtime/opencode/bun.lock"],
    ]) {
      if (observation.artifactFiles[artifactPath] !== sha256(await Bun.file(resolve(root, sourcePath)).text())) {
        throw new Error(`image/source mismatch: ${sourcePath}; re-qualify the artifact before using host policy results`)
      }
    }
    const output = {
      observedAt: new Date().toISOString(), sourceRevision: requireSuccess(["git", "-C", root, "rev-parse", "HEAD"]),
      probeSHA256: sha256(await Bun.file(script).text()),
      image: { requested: image, id: artifact.Id, platform: `${artifact.Os}/${artifact.Architecture}` },
      conditions: { network: "none", volumes: [], credentials: "synthetic only", identity: "1001:1001", providerCalls: 0 },
      commands, policy, policyEvaluation: "host, pinned OpenCode matcher; image policy/entrypoint/runtime lock SHA256 verified",
      ...observation,
    }
    console.log(JSON.stringify(output, null, 2))
    process.exitCode = observation.finding === "KNOWN_OPEN_G1" ? 2 : 0
  } finally {
    if (created) requireSuccess(["docker", "rm", "--force", name])
  }
}
