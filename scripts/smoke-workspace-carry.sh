#!/usr/bin/env bash
set -euo pipefail

# Primitive capability proof only: authored operations, no model, registered child
# binding or trusted child-check qualification. No build/pull/network/host mount.
IMAGE="${IMAGE:-aboiteau-checks-agent:20261115}"
CARRY_RUN="$$-$(date +%s)"
CARRY_WORK="$(mktemp -d "${TMPDIR:-/tmp}/aboiteau-workspace-carry.XXXXXX")"
CARRY_TOKEN="synthetic-carry-control-token"
CARRY_CONTAINER=""
umask 077
chmod 700 "$CARRY_WORK"
fail() { echo "FAIL: $*; evidence: $CARRY_WORK" >&2; exit 1; }
ok() { echo "ok - $*"; }
for tool in docker jq python3; do command -v "$tool" >/dev/null || fail "missing host tool"; done

docker_call() {
  python3 - "$@" <<'PY'
import subprocess, sys
try:
    result = subprocess.run(["docker", *sys.argv[1:]], stderr=subprocess.PIPE, timeout=180)
    if result.returncode: print("Docker " + sys.argv[1] + " failed (exit " + str(result.returncode) + "); raw diagnostics omitted", file=sys.stderr)
    raise SystemExit(result.returncode)
except subprocess.TimeoutExpired:
    print("Docker operation deadline", file=sys.stderr)
    raise SystemExit(124)
PY
}
absent() {
  local rows
  rows="$(docker_call container ls --all --filter "name=^/$1$" --format '{{.ID}}')" || return 1
  [[ -z "$rows" ]]
}
stop_container() {
  [[ -n "$CARRY_CONTAINER" ]] || return 0
  local owner
  owner="$(docker_call inspect --format '{{index .Config.Labels "aboiteau.workspace-carry"}}' "$CARRY_CONTAINER")" || return 1
  [[ "$owner" == "$CARRY_RUN" ]] || return 1
  docker_call rm -f "$CARRY_CONTAINER" >/dev/null || return 1
  absent "$CARRY_CONTAINER" || return 1
  CARRY_CONTAINER=""
}
cleanup() { if [[ -n "$CARRY_CONTAINER" ]]; then stop_container || true; fi; }
trap cleanup EXIT
start_container() {
  [[ -z "$CARRY_CONTAINER" ]] || fail "previous container still owned"
  CARRY_CONTAINER="aboiteau-carry-${CARRY_RUN}-$1"
  absent "$CARRY_CONTAINER" || fail "container name already exists or daemon unavailable"
  docker_call run --pull=never --network none -d --name "$CARRY_CONTAINER" \
    --label "aboiteau.workspace-carry=$CARRY_RUN" --env "CONTROL_TOKEN=$CARRY_TOKEN" --env 'WORKSPACE_REPO=' "$IMAGE" \
    >"$CARRY_WORK/container-$1.id" || fail "container start failed"
  local ready=0
  for attempt in $(seq 1 100); do
    if docker_call exec "$CARRY_CONTAINER" curl -fsS --connect-timeout 1 --max-time 1 http://127.0.0.1:4001/health >/dev/null 2>&1; then ready=1; break; fi
    sleep 0.2
  done
  [[ "$ready" == 1 ]] || fail "control health deadline"
  [[ "$(docker_call inspect --format '{{.HostConfig.NetworkMode}}' "$CARRY_CONTAINER")" == 'none' ]] || fail "source network must be disabled"
}
request() {
  local method="$1" path="$2" output="$3" expected="$4" input="${5:-}" code
  local args=(-sS --connect-timeout 2 --max-time 150 --max-filesize 67108864 -H "Authorization: Bearer $CARRY_TOKEN" -X "$method" -o /tmp/carry-response -w '%{http_code}')
  if [[ -n "$input" ]]; then
    docker_call cp "$input" "$CARRY_CONTAINER:/tmp/carry-request" >/dev/null
    local kind='application/json'
    [[ "$input" != *.tar.gz ]] || kind='application/gzip'
    args+=(-H "content-type: $kind" --data-binary @/tmp/carry-request)
  fi
  code="$(docker_call exec "$CARRY_CONTAINER" curl "${args[@]}" "http://127.0.0.1:4001$path")" || fail "bounded control request failed"
  docker_call cp "$CARRY_CONTAINER:/tmp/carry-response" "$output" >/dev/null
  [[ "$code" == "$expected" ]] || fail "unexpected control HTTP status $code"
}
agent() { docker_call exec --user 1001:1001 --workdir /workspace "$CARRY_CONTAINER" "$@"; }

cat >"$CARRY_WORK/setup.ts" <<'TS'
import assert from "node:assert/strict"
import { mkdir, writeFile, copyFile, readFile } from "node:fs/promises"
import { constants } from "node:fs"
const files = { "/workspace/draft.ts": "export const draft = 42\n", "/workspace/notes/plan.md": "Carry these public notes.\n", "/workspace/README.md": "General workspace notes; preserve this original.\n" }
for (const [name, content] of Object.entries(files)) { await mkdir(name.slice(0,name.lastIndexOf("/")),{recursive:true}); await writeFile(name,content) }
await mkdir("/tmp/carry-origin/src",{recursive:true})
await writeFile("/tmp/carry-origin/README.md","Repository README; do not overwrite.\n")
await writeFile("/tmp/carry-origin/src/existing.ts","export const existing = 1\n")
async function git(args:string[],cwd:string) { const child=Bun.spawn(["git","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false",...args],{cwd,env:{PATH:"/usr/local/bin:/usr/bin:/bin",GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1",GIT_TERMINAL_PROMPT:"0",GIT_NO_LAZY_FETCH:"1"},stdout:"pipe",stderr:"pipe"});const code=await child.exited;if(code!==0)throw Error("Synthetic Git operation failed");return new Response(child.stdout).text() }
await git(["init","--template=","-b","main"],"/tmp/carry-origin")
await git(["add","."],"/tmp/carry-origin")
await git(["-c","user.name=Carry Fixture","-c","user.email=carry@example.invalid","commit","-m","public local base"],"/tmp/carry-origin")
await git(["clone","--no-hardlinks","--no-recurse-submodules","--template=","/tmp/carry-origin","/workspace/project"],"/workspace")
await git(["switch","-c","task/carry-proof"],"/workspace/project")
await mkdir("/workspace/project/docs",{recursive:true})
await copyFile("/workspace/draft.ts","/workspace/project/src/draft.ts",constants.COPYFILE_EXCL)
await copyFile("/workspace/notes/plan.md","/workspace/project/docs/plan.md",constants.COPYFILE_EXCL)
let collisionRefused=false
try { await copyFile("/workspace/README.md","/workspace/project/README.md",constants.COPYFILE_EXCL) } catch(e:any) { if(e.code!=="EEXIST")throw e;collisionRefused=true }
assert(collisionRefused)
assert.equal(await readFile("/workspace/project/README.md","utf8"),"Repository README; do not overwrite.\n")
await copyFile("/workspace/README.md","/workspace/project/docs/workspace-README.md",constants.COPYFILE_EXCL)
await writeFile("/workspace/project/src/existing.ts","export const existing = 2 // uncommitted\n")
console.log(JSON.stringify({collisionRefused,selectedFileCount:3,originalsPreserved:true,conflictResolution:"explicit alternate destination; neither original overwritten"}))
TS
cat >"$CARRY_WORK/verify.ts" <<'TS'
import assert from "node:assert/strict"
import { existsSync,readFileSync } from "node:fs"
import { createHash } from "node:crypto"
assert.equal(existsSync("/workspace/.git"),false)
assert.equal(existsSync("/workspace/project/.stow"),false)
const paths=["draft.ts","notes/plan.md","README.md","project/src/draft.ts","project/docs/plan.md","project/docs/workspace-README.md","project/README.md","project/src/existing.ts"]
const hashes=Object.fromEntries(paths.map(name=>[name,createHash("sha256").update(readFileSync("/workspace/"+name)).digest("hex")]))
for(const[a,b]of[["draft.ts","project/src/draft.ts"],["notes/plan.md","project/docs/plan.md"],["README.md","project/docs/workspace-README.md"]])assert.equal(hashes[a],hashes[b])
assert.equal(readFileSync("/workspace/project/README.md","utf8"),"Repository README; do not overwrite.\n")
async function git(args:string[]) { const p=Bun.spawn(["git","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-C","/workspace/project",...args],{env:{PATH:"/usr/local/bin:/usr/bin:/bin",GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1",GIT_NO_LAZY_FETCH:"1",GIT_ALLOW_PROTOCOL:""},stdout:"pipe",stderr:"pipe"});assert.equal(await p.exited,0);return(await new Response(p.stdout).text()).trim() }
const status=await git(["status","--porcelain"])
assert(status.includes(" M src/existing.ts".trimStart())||status.includes("M src/existing.ts"))
assert(status.includes("?? docs/")&&status.includes("?? src/draft.ts"))
const branch=await git(["symbolic-ref","--short","HEAD"]);assert.equal(branch,"task/carry-proof")
console.log(JSON.stringify({hashes,head:await git(["rev-parse","HEAD"]),branch,status,generalRootNoGit:true}))
TS

docker_call image inspect --format '{{.Id}}' "$IMAGE" >"$CARRY_WORK/image.id" || fail "required image unavailable"
docker_call image inspect --format '{{.Os}}/{{.Architecture}}' "$IMAGE" >"$CARRY_WORK/image.platform"
printf '%s\n' '{"workspaceRepo":"","model":"opencode/deepseek-v4.1-flash"}' >"$CARRY_WORK/configure.json"
printf '%s\n' '{"location":{"directory":"/workspace"},"title":"Model-free carry primitive"}' >"$CARRY_WORK/session-create.json"
start_container source
request POST /configure "$CARRY_WORK/configured.json" 200 "$CARRY_WORK/configure.json"
request POST /start "$CARRY_WORK/start-source.json" 200
jq -e '.ok == true and .eventPersistence == true and (has("workspaceRepository")|not)' "$CARRY_WORK/start-source.json" >/dev/null || fail "generic runtime proof invalid"
agent bun -e 'const fs=require("node:fs");if(fs.readdirSync("/workspace").some(n=>n!==".stow"))throw Error("general workspace unexpectedly populated")'
request POST /opencode/api/session "$CARRY_WORK/session-source.json" 200 "$CARRY_WORK/session-create.json"
CARRY_SESSION="$(jq -er '.data.id // .id' "$CARRY_WORK/session-source.json")"
[[ "$CARRY_SESSION" == ses_* ]] || fail "session not created"
docker_call cp "$CARRY_WORK/setup.ts" "$CARRY_CONTAINER:/tmp/carry-setup.ts" >/dev/null
docker_call cp "$CARRY_WORK/verify.ts" "$CARRY_CONTAINER:/tmp/carry-verify.ts" >/dev/null
docker_call exec "$CARRY_CONTAINER" chown 1001:1001 /tmp/carry-setup.ts /tmp/carry-verify.ts
docker_call exec "$CARRY_CONTAINER" chmod 0644 /tmp/carry-setup.ts /tmp/carry-verify.ts
agent bun /tmp/carry-setup.ts >"$CARRY_WORK/transfer.json"
agent bun /tmp/carry-verify.ts >"$CARRY_WORK/source-files.json"
docker_call exec "$CARRY_CONTAINER" cat /var/lib/aboiteau/state/stow/identity.json >"$CARRY_WORK/identity-source.json"
request GET /status "$CARRY_WORK/status-source.json" 200
jq -e '.s3 == true' "$CARRY_WORK/status-source.json" >/dev/null || fail "native Stow not ready"
ok "general native workspace, child Git checkout, selected copy and explicit conflict preservation"
request GET '/checkpoint?part=workspace' "$CARRY_WORK/workspace.tar.gz" 200
request GET '/checkpoint?part=state' "$CARRY_WORK/state.tar.gz" 200
stop_container || fail "source cleanup not confirmed"
ok "split workspace/state checkpoint and source removal confirmed"
start_container restored
request POST '/restore?part=workspace' "$CARRY_WORK/restore-workspace.json" 200 "$CARRY_WORK/workspace.tar.gz"
request POST '/restore?part=state' "$CARRY_WORK/restore-state.json" 200 "$CARRY_WORK/state.tar.gz"
request POST /configure "$CARRY_WORK/configure-restored.json" 200 "$CARRY_WORK/configure.json"
request POST /start "$CARRY_WORK/start-restored.json" 200
docker_call cp "$CARRY_WORK/verify.ts" "$CARRY_CONTAINER:/tmp/carry-verify.ts" >/dev/null
docker_call exec "$CARRY_CONTAINER" chown 1001:1001 /tmp/carry-verify.ts
docker_call exec "$CARRY_CONTAINER" chmod 0644 /tmp/carry-verify.ts
agent bun /tmp/carry-verify.ts >"$CARRY_WORK/restored-files.json"
docker_call exec "$CARRY_CONTAINER" cat /var/lib/aboiteau/state/stow/identity.json >"$CARRY_WORK/identity-restored.json"
cmp "$CARRY_WORK/source-files.json" "$CARRY_WORK/restored-files.json" || fail "file hashes or Git state changed"
cmp "$CARRY_WORK/identity-source.json" "$CARRY_WORK/identity-restored.json" || fail "native workspace identity changed"
request GET "/opencode/api/session/$CARRY_SESSION" "$CARRY_WORK/session-restored.json" 200
jq -e --arg id "$CARRY_SESSION" '(.data // .) | .id == $id and .location.directory == "/workspace"' "$CARRY_WORK/session-restored.json" >/dev/null || fail "session identity/location changed"
request GET /status "$CARRY_WORK/status-restored.json" 200
jq -e '.s3 == true' "$CARRY_WORK/status-restored.json" >/dev/null || fail "restored native Stow not ready"
stop_container || fail "restored cleanup not confirmed"
jq -n --arg image "$(cat "$CARRY_WORK/image.id")" --arg platform "$(cat "$CARRY_WORK/image.platform")" --arg session "$CARRY_SESSION" \
  --slurpfile identity "$CARRY_WORK/identity-source.json" --slurpfile files "$CARRY_WORK/restored-files.json" \
  '{schemaVersion:1,proofKind:"primitive_capability",passed:true,imageID:$image,platform:$platform,workspaceID:$identity[0].workspace_id,sessionID:$session,sourceNetwork:"none",originalsPreserved:true,conflictPreserved:true,selectedFileCount:3,childGit:$files[0],coldRestorePassed:true,sessionPreserved:true,cleanupConfirmed:true,modelExecutionRequested:false,autonomousTransferQualified:false,registeredChildBindingQualified:false,trustedChildChecksQualified:false,nodeModules:"excluded by existing checkpoints"}' >"$CARRY_WORK/summary.json"
ok "cold restore preserved workspace identity, session, bytes, nested Git and uncommitted changes"
echo "summary: $CARRY_WORK/summary.json"
