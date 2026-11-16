#!/usr/bin/env bash
set -euo pipefail

# Model-free image qualification. No build, push, provider key or private clone.
# Each disposable container is removed before the next one is started.
IMAGE="${IMAGE:-aboiteau-repository:20261115}"
SMOKE_RUN="$$-$(date +%s)"
SMOKE_WORK="$(mktemp -d "${TMPDIR:-/tmp}/aboiteau-repository-smoke.XXXXXX")"
SMOKE_TOKEN="repository-smoke-local-synthetic-token"
SMOKE_CONTAINER=""
SMOKE_BASE=""
umask 077
chmod 700 "$SMOKE_WORK"

fail() { echo "FAIL: $*; retained artifacts: $SMOKE_WORK" >&2; exit 1; }
ok() { echo "ok - $*"; }
for tool in docker curl jq python3 tar; do command -v "$tool" >/dev/null || fail "missing required host tool"; done

# Bound Docker client calls and suppress raw daemon/exec diagnostics.
docker_call() {
  python3 - "$@" <<'PY'
import subprocess, sys
try:
    result = subprocess.run(["docker", *sys.argv[1:]], stderr=subprocess.PIPE, timeout=180)
    if result.returncode:
        print("Docker operation failed; raw diagnostics omitted", file=sys.stderr)
    raise SystemExit(result.returncode)
except subprocess.TimeoutExpired:
    print("Docker operation exceeded its deadline", file=sys.stderr)
    raise SystemExit(124)
PY
}

cleanup() {
  if [[ -n "$SMOKE_CONTAINER" ]]; then
    local owner
    owner="$(docker_call inspect --format '{{index .Config.Labels "aboiteau.repository-smoke"}}' "$SMOKE_CONTAINER" 2>/dev/null || true)"
    if [[ "$owner" == "$SMOKE_RUN" ]]; then
      docker_call rm -f "$SMOKE_CONTAINER" >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

stop_container() {
  [[ -n "$SMOKE_CONTAINER" ]] || return 0
  docker_call rm -f "$SMOKE_CONTAINER" >/dev/null || fail "disposable container removal failed"
  if docker_call inspect "$SMOKE_CONTAINER" >/dev/null 2>&1; then fail "container stop was not confirmed"; fi
  SMOKE_CONTAINER=""
  SMOKE_BASE=""
}

start_container() {
  [[ -z "$SMOKE_CONTAINER" ]] || fail "previous container still owned"
  local name="aboiteau-repository-smoke-${SMOKE_RUN}-$1"
  if docker_call inspect "$name" >/dev/null 2>&1; then fail "container name already exists"; fi
  SMOKE_CONTAINER="$name"
  docker_call run --pull=never --platform linux/amd64 -d --name "$name" \
    --label "aboiteau.repository-smoke=$SMOKE_RUN" \
    --env "CONTROL_TOKEN=$SMOKE_TOKEN" -p '127.0.0.1::4001' "$IMAGE" >"$SMOKE_WORK/container-$1.id" \
    || fail "image container failed to start"
  local port
  port="$(docker_call inspect --format '{{(index (index .NetworkSettings.Ports "4001/tcp") 0).HostPort}}' "$name")"
  [[ "$port" =~ ^[0-9]+$ ]] || fail "invalid local port assignment"
  SMOKE_BASE="http://127.0.0.1:$port"
  local ready=0
  for attempt in $(seq 1 100); do
    if curl -fsS --connect-timeout 1 --max-time 2 "$SMOKE_BASE/health" >/dev/null 2>&1; then ready=1; break; fi
    sleep 0.2
  done
  [[ "$ready" == 1 ]] || fail "control health deadline"
}

request() {
  local method="$1" path="$2" output="$3" expected="$4" input="${5:-}" code
  local args=(-sS --connect-timeout 3 --max-time 150 --max-filesize 67108864 \
    -H "Authorization: Bearer $SMOKE_TOKEN" -X "$method" -o "$output" -w '%{http_code}')
  if [[ -n "$input" ]]; then
    local content_type='application/json'
    [[ "$input" != *.tar.gz ]] || content_type='application/gzip'
    args+=(-H "content-type: $content_type" --data-binary "@$input")
  fi
  code="$(curl "${args[@]}" "$SMOKE_BASE$path" 2>/dev/null)" || fail "bounded control request failed"
  [[ "$code" == "$expected" ]] || fail "control request returned unexpected status"
}

agent_git() {
  docker_call exec --user 1001:1001 --workdir /workspace \
    --env GIT_CONFIG_NOSYSTEM=1 --env GIT_CONFIG_GLOBAL=/dev/null --env GIT_TERMINAL_PROMPT=0 \
    "$SMOKE_CONTAINER" git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"
}

verify_checkout() {
  [[ "$(agent_git config --local --get-all remote.origin.url)" == 'https://github.com/octocat/hello-world' ]] || fail "origin changed"
  [[ "$(agent_git symbolic-ref --quiet --short HEAD)" == 'aboiteau/image-binding-smoke' ]] || fail "working branch changed"
  [[ "$(agent_git rev-parse --verify HEAD)" == "$1" ]] || fail "task commit changed"
  agent_git merge-base --is-ancestor "$SMOKE_BASE_COMMIT" HEAD >/dev/null || fail "original base is not an ancestor"
}

verify_receipt() {
  jq -e --slurpfile expected "$SMOKE_WORK/bound.json" \
    '.ok == true and .eventPersistence == true and .workspaceRepository == $expected[0]' "$1" >/dev/null \
    || fail "bound runtime receipt changed"
}

restore_parts() {
  request POST '/restore?part=workspace' "$SMOKE_WORK/restore-workspace-$1.json" 200 "$SMOKE_WORK/workspace.tar.gz"
  request POST '/restore?part=state' "$SMOKE_WORK/restore-state-$1.json" 200 "$SMOKE_WORK/state.tar.gz"
}

docker_call image inspect --format '{{.Id}}' "$IMAGE" >"$SMOKE_WORK/image.id" || fail "required local image is unavailable"
cat >"$SMOKE_WORK/pending.json" <<'JSON'
{"workspaceRepository":{"schemaVersion":1,"bindingID":"11111111-1111-4111-8111-111111111111","status":"pending","baseCommit":null,"repository":"https://github.com/octocat/hello-world","baseBranch":"master","workingBranch":"aboiteau/image-binding-smoke"},"model":"opencode/deepseek-v4.1-flash"}
JSON

start_container source
request POST /configure "$SMOKE_WORK/configure.json" 200 "$SMOKE_WORK/pending.json"
request POST /start "$SMOKE_WORK/start.json" 200
jq -e --slurpfile pending "$SMOKE_WORK/pending.json" \
  '.ok == true and .accountingPolicy == "foreground-usage-v1" and .eventPersistence == true and .workspaceRepository.status == "bound" and (.workspaceRepository.baseCommit | test("^([a-f0-9]{40}|[a-f0-9]{64})$")) and ((.workspaceRepository | del(.baseCommit,.status)) == ($pending[0].workspaceRepository | del(.baseCommit,.status)))' \
  "$SMOKE_WORK/start.json" >/dev/null || fail "missing or mismatched initial bound proof"
jq '.workspaceRepository' "$SMOKE_WORK/start.json" >"$SMOKE_WORK/bound.json"
jq '{workspaceRepository:.}' "$SMOKE_WORK/bound.json" >"$SMOKE_WORK/bound-configure.json"
SMOKE_BASE_COMMIT="$(jq -r .baseCommit "$SMOKE_WORK/bound.json")"
verify_checkout "$SMOKE_BASE_COMMIT"
[[ "$(agent_git rev-parse refs/remotes/origin/master)" == "$SMOKE_BASE_COMMIT" ]] || fail "resolved base branch differs"
docker_call exec "$SMOKE_CONTAINER" cat /var/lib/aboiteau/state/stow/identity.json >"$SMOKE_WORK/identity.json"
SMOKE_WORKSPACE_ID="$(jq -er .workspace_id "$SMOKE_WORK/identity.json")"
ok "public clone, exact base and working branch are bound"

request POST /configure "$SMOKE_WORK/retry-configure.json" 200 "$SMOKE_WORK/pending.json"
request POST /start "$SMOKE_WORK/retry-start.json" 200
verify_receipt "$SMOKE_WORK/retry-start.json"
jq '.workspaceRepository.workingBranch="aboiteau/conflicting-task"' "$SMOKE_WORK/pending.json" >"$SMOKE_WORK/conflict.json"
request POST /configure "$SMOKE_WORK/conflict-result.json" 409 "$SMOKE_WORK/conflict.json"
jq -e '.code == "WORKSPACE_REPOSITORY_CONFLICT"' "$SMOKE_WORK/conflict-result.json" >/dev/null || fail "conflict code missing"
verify_checkout "$SMOKE_BASE_COMMIT"
ok "identical retry is stable and conflicting selection does not mutate checkout"

docker_call exec --user 1001:1001 --workdir /workspace "$SMOKE_CONTAINER" \
  bun -e 'await Bun.write("aboiteau-binding-smoke.txt","public model-free smoke fixture\n")' >/dev/null
agent_git add -- aboiteau-binding-smoke.txt
agent_git -c user.name='Aboiteau Smoke' -c user.email='smoke@example.invalid' commit -q -m 'Model-free binding checkpoint fixture'
SMOKE_TASK_COMMIT="$(agent_git rev-parse --verify HEAD)"
[[ "$SMOKE_TASK_COMMIT" != "$SMOKE_BASE_COMMIT" ]] || fail "synthetic task commit was not created"
request POST /start "$SMOKE_WORK/edited-start.json" 200
verify_receipt "$SMOKE_WORK/edited-start.json"
verify_checkout "$SMOKE_TASK_COMMIT"
ok "working commit advances while original binding base remains immutable"

request GET '/checkpoint?part=workspace' "$SMOKE_WORK/workspace.tar.gz" 200
request GET '/checkpoint?part=state' "$SMOKE_WORK/state.tar.gz" 200
tar -tzf "$SMOKE_WORK/workspace.tar.gz" >"$SMOKE_WORK/workspace-members.txt"
tar -tzf "$SMOKE_WORK/state.tar.gz" >"$SMOKE_WORK/state-members.txt"
grep -q '\.git/' "$SMOKE_WORK/workspace-members.txt" || fail "workspace checkpoint omitted Git"
grep -q '\.stow/' "$SMOKE_WORK/workspace-members.txt" || fail "workspace checkpoint omitted Stow"
grep -q 'workspace-repository.json' "$SMOKE_WORK/state-members.txt" || fail "state checkpoint omitted binding mirror"
request GET /state-checkpoint "$SMOKE_WORK/account.tar.gz" 200
tar -tzf "$SMOKE_WORK/account.tar.gz" >"$SMOKE_WORK/account-members.txt"
if grep -q 'workspace-repository.json' "$SMOKE_WORK/account-members.txt"; then fail "account seed leaked task binding"; fi
ok "full checkpoints retain binding and account export excludes it"
stop_container

start_container restored
request POST /seed-state "$SMOKE_WORK/rejected-full-state-seed.json" 400 "$SMOKE_WORK/state.tar.gz"
restore_parts cold
request POST /configure "$SMOKE_WORK/restored-configure.json" 200 "$SMOKE_WORK/bound-configure.json"
request POST /start "$SMOKE_WORK/restored-start.json" 200
verify_receipt "$SMOKE_WORK/restored-start.json"
verify_checkout "$SMOKE_TASK_COMMIT"
docker_call exec "$SMOKE_CONTAINER" cat /var/lib/aboiteau/state/stow/identity.json >"$SMOKE_WORK/restored-identity.json"
[[ "$(jq -er .workspace_id "$SMOKE_WORK/restored-identity.json")" == "$SMOKE_WORKSPACE_ID" ]] || fail "cold restore changed native workspace identity"
ok "cold split restore preserves task commit, binding and native identity; full state seed is rejected"
stop_container

start_container tampered
restore_parts tampered
docker_call exec --user 1001:1001 "$SMOKE_CONTAINER" bun -e \
  'const p="/var/lib/aboiteau/state/workspace-repository.json";const b=JSON.parse(await Bun.file(p).text());b.baseCommit=(b.baseCommit[0]==="a"?"b":"a")+b.baseCommit.slice(1);await Bun.write(p,JSON.stringify(b))' >/dev/null
request POST /configure "$SMOKE_WORK/tampered-configure.json" 200 "$SMOKE_WORK/bound-configure.json"
request POST /start "$SMOKE_WORK/tampered-start.json" 409
jq -e '.code == "WORKSPACE_REPOSITORY_CONFLICT"' "$SMOKE_WORK/tampered-start.json" >/dev/null || fail "tampered mirror did not produce binding conflict"
request GET /status "$SMOKE_WORK/tampered-status.json" 200
jq -e '.running == false' "$SMOKE_WORK/tampered-status.json" >/dev/null || fail "tampered restore started OpenCode"
verify_checkout "$SMOKE_TASK_COMMIT"
ok "tampered restored binding fails closed before OpenCode starts or checkout changes"
stop_container

jq -n --arg image "$IMAGE" --arg imageID "$(cat "$SMOKE_WORK/image.id")" \
  --arg baseCommit "$SMOKE_BASE_COMMIT" --arg taskCommit "$SMOKE_TASK_COMMIT" --arg workspaceID "$SMOKE_WORKSPACE_ID" \
  '{schemaVersion:1,kind:"model-free-image-workspace-binding",image:$image,imageID:$imageID,repository:"https://github.com/octocat/hello-world",baseBranch:"master",workingBranch:"aboiteau/image-binding-smoke",baseCommit:$baseCommit,taskCommit:$taskCommit,workspaceID:$workspaceID,providerExecutionRequested:false,conflictRefused:true,accountSeedExcludedBinding:true,fullStateSeedRefused:true,coldRestorePassed:true,tamperedMirrorRefused:true,cleanupConfirmed:true}' \
  >"$SMOKE_WORK/summary.json"
echo "PASS - sequential model-free repository binding image smoke"
echo "Artifacts: $SMOKE_WORK"
