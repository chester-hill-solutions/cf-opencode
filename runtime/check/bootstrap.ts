import { mkdir, writeFile } from "node:fs/promises"
import { verifyWorkspaceCheckSnapshot } from "../../src/workspace-check-snapshot"

// No service/collector code executes here. This root-read-only bootstrap stages
// authenticated bytes and directly launches the operator's explicit argv.
if (import.meta.main) {
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of Bun.stdin.stream()) {
      size += chunk.byteLength
      if (size > 32 * 1024 * 1024) throw new Error("input bound")
      chunks.push(chunk)
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("input")
    const record = input as Record<string, unknown>
    if (Object.keys(record).sort().join(",") !== "argv,snapshot" || !Array.isArray(record.argv) || record.argv.length < 1 || record.argv.length > 64) throw new Error("input")
    let argvBytes = 0
    const argv = record.argv.map(arg => {
      if (typeof arg !== "string" || arg.length > 2048 || /[\u0000-\u001f\u007f]/.test(arg)) throw new Error("argv")
      argvBytes += Buffer.byteLength(arg)
      return arg
    })
    if (!argv[0] || argv[0].startsWith("-") || argvBytes > 8192) throw new Error("argv")
    const snapshot = await verifyWorkspaceCheckSnapshot(record.snapshot)
    for (const file of snapshot.files) {
      const target = "/workspace/" + file.path
      await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true, mode: 0o700 })
      await writeFile(target, Buffer.from(file.contentBase64, "base64"), { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 })
    }
    const child = Bun.spawn(argv, { cwd: "/workspace", stdin: "ignore", stdout: "inherit", stderr: "inherit", env: {
      PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: "/tmp", BUN_OPTIONS: "", BUN_INSTALL_AUTO: "disable",
    } })
    process.exitCode = await child.exited
  } catch {
    console.error("Checker preparation or command launch failed.")
    process.exitCode = 125
  }
}
