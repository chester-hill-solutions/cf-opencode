import { describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseWorkspacePreflight } from "../src/workspace-preflight"

const sourceRoot = join(import.meta.dir, "..")
const token = "synthetic-control-preflight-token"

async function controlFixture(inspector?: string) {
  const root = mkdtempSync(join(tmpdir(), "aboiteau-control-preflight-"))
  const app = join(root, "app")
  const workspace = join(root, "workspace")
  const state = join(root, "state")
  mkdirSync(join(app, "src"), { recursive: true })
  mkdirSync(workspace)
  mkdirSync(state)
  for (const file of ["control-server.ts", "control-lifecycle.ts", "stow-workspace.ts", "workspace-repository.ts", "workspace-check-snapshot.ts", "src/workspace-repository.ts", "src/workspace-check-snapshot.ts", "src/permissions.ts", "src/accounting-policy.ts", "src/control-auth.ts", "src/tar.ts", "src/workspace-preflight.ts"]) {
    copyFileSync(join(sourceRoot, file), join(app, file))
  }
  if (inspector === undefined) copyFileSync(join(sourceRoot, "workspace-preflight.ts"), join(app, "workspace-preflight.ts"))
  else writeFileSync(join(app, "workspace-preflight.ts"), `await Bun.write(${JSON.stringify(join(root, "inspector.pid"))}, String(process.pid));\n${inspector}`)
  // Execute the actual main entrypoint and fetch handler over stdio. This
  // substitutes only the listening transport; no TCP permission is required.
  const preload = join(root, "capture-server.ts")
  writeFileSync(preload, `
    Bun.serve = (options) => {
      let pending = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (part) => {
        pending += part;
        let end;
        while ((end = pending.indexOf("\\n")) >= 0) {
          const message = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
          Promise.resolve(options.fetch(new Request("http://control" + message.path, {
            method: message.method, headers: message.authorized ? { authorization: "Bearer " + ${JSON.stringify(token)} } : {},
            body: message.body === undefined ? undefined : JSON.stringify(message.body),
          }))).then(async response => console.log("@@receipt" + JSON.stringify({
            id: message.id, status: response.status, headers: [...response.headers], body: await response.text(),
          })));
        }
      });
      console.log("@@ready");
      return {};
    };
  `)
  const child = Bun.spawn([process.execPath, `--preload=${preload}`, join(app, "control-server.ts")], {
    cwd: app,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      CONTROL_PORT: "4001",
      CONTROL_TOKEN: token,
      WORKSPACE: workspace,
      WORKSPACE_REPO: "https://invalid.example/never-clone",
      ABOITEAU_STATE_DIR: state,
      ABOITEAU_RUN_DIR: join(root, "run"),
      AGENT_UID: String(process.getuid?.() ?? 1001),
      AGENT_GID: String(process.getgid?.() ?? 1001),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  let ready = false
  let sequence = 0
  const replies = new Map<number, (response: Response) => void>()
  const output = (async () => {
    const reader = child.stdout.getReader(), decoder = new TextDecoder()
    let pending = ""
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      pending += decoder.decode(next.value, { stream: true })
      let end: number
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (line === "@@ready") ready = true
        if (line.startsWith("@@receipt")) {
          const result: { id: number; status: number; headers: [string, string][]; body: string } = JSON.parse(line.slice(9))
          replies.get(result.id)?.(new Response(result.body, { status: result.status, headers: result.headers }))
          replies.delete(result.id)
        }
      }
    }
  })()
  const close = async () => {
    if (existsSync(join(root, "inspector.pid"))) {
      const pid = Number(readFileSync(join(root, "inspector.pid"), "utf8"))
      if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(-pid, "SIGKILL") } catch {} }
    }
    if (child.exitCode === null) child.kill("SIGKILL")
    await Promise.race([child.exited, Bun.sleep(2_000)])
    await output
    rmSync(root, { recursive: true, force: true })
  }
  try {
    const deadline = performance.now() + 5_000
    for (;;) {
      if (child.exitCode !== null) throw new Error("control fixture exited")
      if (ready) break
      if (performance.now() > deadline) throw new Error("control fixture readiness timed out")
      await Bun.sleep(20)
    }
  } catch (error) {
    await close()
    throw error
  }
  return {
    root, workspace, state, close,
    request: (path: string, method = "GET", authorized = true, body?: unknown) => new Promise<Response>((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { replies.delete(id); reject(new Error("control response deadline")) }, 15_000)
      replies.set(id, (response) => { clearTimeout(timer); resolve(response) })
      child.stdin.write(JSON.stringify({ id, path, method, authorized, body }) + "\n")
      void child.stdin.flush()
    }),
  }
}

describe("control workspace preflight", () => {
  test("check head/source endpoints authenticate and refuse unprepared workspaces without creating state", async () => {
    const fixture = await controlFixture()
    const workspaceRepository = { schemaVersion: 1, bindingID: "12345678-1234-4123-8123-123456789abc", repository: "https://github.com/example/snapshot", baseBranch: "main", workingBranch: "aboiteau/check", status: "bound", baseCommit: "a".repeat(40) }
    try {
      for (const route of ["/workspace/checks/head", "/workspace/checks/snapshot"]) {
        expect((await fixture.request(route, "POST", false)).status).toBe(401)
        expect((await fixture.request(route)).status).toBe(405)
        const response = await fixture.request(route, "POST", true, route.endsWith("snapshot") ? { workspaceRepository, commit: workspaceRepository.baseCommit } : { workspaceRepository })
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: "WORKSPACE_CHECK_SNAPSHOT_UNAVAILABLE" })
      }
      expect(readdirSync(fixture.workspace)).toEqual([])
      expect(readdirSync(fixture.state)).toEqual([])
      expect(existsSync(join(fixture.root, "run"))).toBe(false)
    } finally { await fixture.close() }
  })

  test("authenticates GET-only inspection without starting or modifying the workspace", async () => {
    const fixture = await controlFixture()
    try {
      const packageText = JSON.stringify({ scripts: { postinstall: "touch MUST-NOT-RUN", test: "touch MUST-NOT-RUN" } })
      writeFileSync(join(fixture.workspace, "package.json"), packageText)
      expect((await fixture.request("/workspace/preflight", "GET", false)).status).toBe(401)
      const rejected = await fixture.request("/workspace/preflight", "POST")
      expect(rejected.status).toBe(405)
      expect(rejected.headers.get("allow")).toBe("GET")
      const result = await fixture.request("/workspace/preflight")
      expect(result.status).toBe(200)
      expect(result.headers.get("cache-control")).toBe("no-store")
      const receipt = parseWorkspacePreflight(await result.json())
      expect(receipt.schemaVersion).toBe(1)
      expect(await (await fixture.request("/status")).json()).toMatchObject({ initialized: false, running: false, s3: false })
      expect(readFileSync(join(fixture.workspace, "package.json"), "utf8")).toBe(packageText)
      expect(readdirSync(fixture.workspace)).toEqual(["package.json"])
      expect(readdirSync(fixture.state)).toEqual([])
      expect(existsSync(join(fixture.workspace, "MUST-NOT-RUN"))).toBe(false)
    } finally { await fixture.close() }
  }, 20_000)

  test("sanitizes malformed inspector output and never forwards controller secrets", async () => {
    const fixture = await controlFixture('if (process.env.CONTROL_TOKEN) await Bun.write(process.argv[2] + "/env-leaked", "bad"); console.error("private diagnostic"); console.log("invalid json")')
    try {
      const response = await fixture.request("/workspace/preflight")
      expect(response.status).toBe(503)
      const body = await response.text()
      expect(body).toBe('{"error":"workspace preflight unavailable"}')
      expect(body).not.toContain(token)
      expect(body).not.toContain("private diagnostic")
      expect(existsSync(join(fixture.workspace, "env-leaked"))).toBe(false)
    } finally { await fixture.close() }
  })

  test("bounds output and stops an inspector process group, then releases the lifecycle gate", async () => {
    const fixture = await controlFixture(`
      const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
      await Bun.write(process.argv[2] + "/child.pid", String(child.pid));
      console.log("x".repeat(70_000));
      setInterval(() => {}, 1000);
    `)
    let pid: number | undefined
    try {
      const started = performance.now()
      const response = await fixture.request("/workspace/preflight")
      expect(response.status).toBe(503)
      expect(performance.now() - started).toBeLessThan(5_000)
      pid = Number(readFileSync(join(fixture.workspace, "child.pid"), "utf8"))
      const deadline = performance.now() + 2_000
      let alive = true
      while (alive && performance.now() < deadline) {
        try { process.kill(pid, 0) } catch { alive = false }
        if (alive) await Bun.sleep(20)
      }
      expect(alive).toBe(false)
      // A subsequent operation must pass the same gate after the failure.
      const next = await fixture.request("/workspace/preflight")
      expect(next.status).toBe(503)
    } finally {
      if (pid) { try { process.kill(pid, "SIGKILL") } catch {} }
      await fixture.close()
    }
  }, 15_000)

  test("times out a stalled inspector while serializing conflicting lifecycle work", async () => {
    const fixture = await controlFixture('await Bun.write(process.argv[2] + "/inspecting", "started"); setInterval(() => {}, 1000)')
    try {
      const started = performance.now()
      const inspection = fixture.request("/workspace/preflight")
      const deadline = performance.now() + 2_000
      while (!existsSync(join(fixture.workspace, "inspecting"))) {
        if (performance.now() > deadline) throw new Error("inspector did not start")
        await Bun.sleep(20)
      }
      let restoreCompleted = false
      const restore = fixture.request("/restore?part=unknown", "POST").then((response) => {
        restoreCompleted = true
        return response
      })
      await Bun.sleep(100)
      expect(restoreCompleted).toBe(false)
      expect((await inspection).status).toBe(503)
      expect((await restore).status).toBe(400)
      expect(performance.now() - started).toBeLessThan(13_000)
    } finally { await fixture.close() }
  }, 20_000)
})
