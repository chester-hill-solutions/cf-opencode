import { createHash } from "node:crypto"
import { readFileSync, existsSync } from "node:fs"

const marker = "/var/lib/aboiteau/state/account-seed-marker"
const identityPath = "/var/lib/aboiteau/state/stow/identity.json"
const identity = JSON.parse(readFileSync(identityPath, "utf8"))
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
const controllerSHA256 = digest("/app/control-server.ts")
const binarySHA256 = digest("/usr/local/bin/stow-s3")
const markerPresent = existsSync(marker) && readFileSync(marker, "utf8") === "synthetic-account-seed-marker-v1\n"
const sourceWorkspaceSentinelAbsent = !existsSync("/workspace/account-seed-source-sentinel")
console.log(JSON.stringify({ markerPresent, sourceWorkspaceSentinelAbsent, workspaceID: identity.workspace_id, controllerSHA256, binarySHA256 }))
