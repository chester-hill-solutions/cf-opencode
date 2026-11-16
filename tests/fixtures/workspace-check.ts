import { workspaceCheckObjectOID, verifyWorkspaceCheckSnapshot, type WorkspaceCheckGitObject } from "../../src/workspace-check-snapshot"
import { CHECK_ENTRYPOINT, CHECK_PROFILE, type DockerResult, type DockerRunner } from "../../scripts/workspace-check-docker"
import { type WorkspaceCheckRequest } from "../../src/workspace-check"

export const checkBinding = { schemaVersion: 1 as const, bindingID: "11111111-1111-4111-8111-111111111111", status: "bound" as const, baseCommit: "a".repeat(40), repository: "https://github.com/example/fixture", baseBranch: "main", workingBranch: "aboiteau/check" }
export async function checkSnapshot(content = 'console.log("fixture")\n', path = "check.ts") {
  const objects: WorkspaceCheckGitObject[] = []
  const add = async (type: WorkspaceCheckGitObject["type"], bytes: Uint8Array) => {
    const oid = await workspaceCheckObjectOID(type, bytes, "SHA-1")
    objects.push({ oid, type, contentBase64: Buffer.from(bytes).toString("base64") })
    return oid
  }
  const blob = await add("blob", Buffer.from(content))
  const tree = await add("tree", Buffer.concat([Buffer.from("100644 " + path + "\0"), Buffer.from(blob, "hex")]))
  const commit = await add("commit", Buffer.from(`tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nfixture\n`))
  return verifyWorkspaceCheckSnapshot({ schemaVersion: 1, mode: "committed_only", worktreeChanges: "unverified", workspaceRepository: checkBinding, commit, tree, objects })
}
export async function checkRequest(): Promise<WorkspaceCheckRequest> {
  return { requestID: "22222222-2222-4222-8222-222222222222", expectedBindingID: checkBinding.bindingID, commitOID: (await checkSnapshot()).commit, argv: ["bun", "--no-env-file", "--no-install", "check.ts"], imageID: "sha256:" + "b".repeat(64), timeoutMs: 1000 }
}
export const checkerImage = (id: string) => [{ Id: id, Os: "linux", Architecture: "amd64", Config: { Labels: { "org.aboiteau.check.profile": CHECK_PROFILE }, User: "65532:65532", Entrypoint: CHECK_ENTRYPOINT, Cmd: [], Volumes: null, Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "BUN_OPTIONS="] } }]
export const dockerResult = (stdout = "", exitCode = 0): DockerResult => ({ exitCode, timedOut: false, outputExceeded: false, stdout: Buffer.from(stdout), stderr: new Uint8Array(), stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0 })

/** Models Docker authority independently of repository stdout. */
export function fakeCheckDocker(options: { exitCode?: number; oom?: boolean; timeout?: boolean; flood?: boolean; cleanupFails?: boolean; createLost?: boolean; observedOwner?: string; output?: string; onCreate?: () => Promise<void> } = {}) {
  const calls: string[][] = []
  let exists = false, started = false, requestID = "22222222-2222-4222-8222-222222222222", collectorID = "33333333-3333-4333-8333-333333333333"
  const runner: DockerRunner = async (args, input) => {
    calls.push(args)
    if (args[0] === "image") return dockerResult(JSON.stringify(checkerImage(args[2])))
    if (args[0] === "container") return dockerResult(exists ? "123abc\n" : "")
    if (args[0] === "create") {
      requestID = args.find(arg => arg.startsWith("org.aboiteau.check.request="))!.split("=")[1]
      collectorID = args.find(arg => arg.startsWith("org.aboiteau.check.collector="))!.split("=")[1]
      await options.onCreate?.()
      exists = true
      return dockerResult("f".repeat(64), options.createLost ? 1 : 0)
    }
    if (args[0] === "start") {
      started = true
      if (!input.input || JSON.parse(input.input).argv[0] !== "bun") throw new Error("Missing explicit input")
      const output = options.output ?? '{"passed":true,"exitCode":0}'
      return { ...dockerResult(output, options.exitCode ?? 0), timedOut: Boolean(options.timeout), outputExceeded: Boolean(options.flood), ...(options.flood ? { stdout: new Uint8Array(65536), stdoutBytes: 1048577 } : {}) }
    }
    if (args[0] === "inspect") return dockerResult(JSON.stringify([{ Config: { Labels: { "org.aboiteau.check.request": requestID, "org.aboiteau.check.collector": options.observedOwner ?? collectorID } }, State: { Running: Boolean(options.timeout && started), Status: options.timeout && started ? "running" : "exited", ExitCode: options.exitCode ?? 0, OOMKilled: Boolean(options.oom) } }]))
    if (args[0] === "rm") { if (!options.cleanupFails) exists = false; return dockerResult("", options.cleanupFails ? 1 : 0) }
    throw new Error("Unexpected Docker command")
  }
  return { runner, calls }
}
