#!/usr/bin/env bash
set -euo pipefail

# Container smoke test.
#
# Builds the image, starts the control server with a local token, and proves the
# paths the Durable Object depends on: readiness, configuration, local S3,
# OpenCode proxy, workspace/state checkpoint round-trips, and the credential
# denial rules. No model provider is called, so this is safe for CI.
#
#   scripts/smoke-container.sh
#   RUNTIME=container scripts/smoke-container.sh   # Apple container
#
# A real provider turn is measured separately by bench/measure.ts against a
# deployed harness (HARNESS_URL + API_TOKEN).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${RUNTIME:-docker}"
IMAGE="${IMAGE:-cf-opencode:smoke}"
RUN_ID="${$}-$(date +%s)"
NAME="${NAME:-cf-opencode-smoke-${RUN_ID}}"
CONTROL_PORT="${CONTROL_PORT:-4011}"
CONTROL_TOKEN="${CONTROL_TOKEN:-smoke-control-token}"
BASE="http://127.0.0.1:${CONTROL_PORT}"
SECOND_NAME="${SECOND_NAME:-${NAME}-account-seed}"
SECOND_CONTROL_PORT="${SECOND_CONTROL_PORT:-$((CONTROL_PORT + 10))}"
SECOND_BASE="http://127.0.0.1:${SECOND_CONTROL_PORT}"
EXPECTED_STOW_SHA256="780c3ccf89abdb4355e1b943ab686693d7436bd08cefdffd0f315226815f27da"
EXPECTED_KERNEL_EXECUTABLE="/usr/local/bin/stow-s3"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-opencode-smoke.XXXXXX")"
WS_ARCHIVE="${WORK}/workspace.tar.gz"
STATE_ARCHIVE="${WORK}/state.tar.gz"
ACCOUNT_ARCHIVE="${WORK}/account.tar.gz"
HEADERS="${WORK}/checkpoint.headers"
MISSING_REGISTRY_ARCHIVE="${WORK}/state-without-registry.tar.gz"
READINESS_FILES=()
CREATED_MAIN=0
CREATED_SECOND=0
umask 077
chmod 700 "$WORK"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

ok() {
  echo "ok - $*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing host command: $1"
}

need curl
need tar
need jq
need node

# Finish before Bun's 120-second idle disconnect so failure diagnostics observe
# the blocked request while the container and its children are still present.
curl() { command curl --connect-timeout 5 --max-time 110 "$@"; }

case "$RUNTIME" in
  docker)
    need docker
    daemon_arch="$(docker info --format '{{.Architecture}}')"
    case "$daemon_arch" in
      arm64|aarch64) EXPECTED_KERNEL_EXECUTABLE="/usr/bin/qemu-x86_64" ;;
      amd64|x86_64) EXPECTED_KERNEL_EXECUTABLE="/usr/local/bin/stow-s3" ;;
      *) fail "unsupported Docker daemon architecture for pinned linux/amd64 image: ${daemon_arch}" ;;
    esac
    build_image() { docker build --platform linux/amd64 -t "$IMAGE" "$ROOT"; }
    run_container() {
      docker run --platform linux/amd64 -d --name "$NAME" --env "CONTROL_TOKEN=${CONTROL_TOKEN}" \
        -p "127.0.0.1:${CONTROL_PORT}:4001" \
        "$IMAGE" >/dev/null
    }
    copy_to_main() { docker cp "$1" "$NAME:$2"; }
    copy_from_main() { docker cp "$NAME:$1" "$2"; }
    run_second_container() {
      docker run --platform linux/amd64 -d --name "$SECOND_NAME" --env "CONTROL_TOKEN=${CONTROL_TOKEN}" \
        -p "127.0.0.1:${SECOND_CONTROL_PORT}:4001" "$IMAGE" >/dev/null
    }
    exec_in() { docker exec "$NAME" "$@"; }
    exec_second() { docker exec "$SECOND_NAME" "$@"; }
    exec_agent() { docker exec --user 1001 "$NAME" "$@"; }
    exec_second_agent() { docker exec --user 1001 "$SECOND_NAME" "$@"; }
    copy_to_second() { docker cp "$1" "$SECOND_NAME:$2"; }
    remove_named() { docker rm -f "$1" >/dev/null 2>&1; }
    cleanup() {
      [[ "$CREATED_SECOND" == 1 ]] && remove_named "$SECOND_NAME" || true
      [[ "$CREATED_MAIN" == 1 ]] && remove_named "$NAME" || true
    }
    ;;
  container)
    need container
    build_image() { container build -t "$IMAGE" "$ROOT"; }
    run_container() {
      container run -d --name "$NAME" --env "CONTROL_TOKEN=${CONTROL_TOKEN}" \
        -p "${CONTROL_PORT}:4001" \
        "$IMAGE" >/dev/null
    }
    copy_to_main() { container cp "$1" "$NAME:$2"; }
    copy_from_main() { container cp "$NAME:$1" "$2"; }
    run_second_container() {
      container run -d --name "$SECOND_NAME" --env "CONTROL_TOKEN=${CONTROL_TOKEN}" \
        -p "${SECOND_CONTROL_PORT}:4001" "$IMAGE" >/dev/null
    }
    exec_in() { container exec "$NAME" "$@"; }
    exec_second() { container exec "$SECOND_NAME" "$@"; }
    exec_agent() { container exec --user 1001 "$NAME" "$@"; }
    exec_second_agent() { container exec --user 1001 "$SECOND_NAME" "$@"; }
    copy_to_second() { container cp "$1" "$SECOND_NAME:$2"; }
    remove_named() {
      container stop "$1" >/dev/null 2>&1 || true
      container delete "$1" >/dev/null 2>&1
    }
    cleanup() {
      [[ "$CREATED_SECOND" == 1 ]] && remove_named "$SECOND_NAME" || true
      [[ "$CREATED_MAIN" == 1 ]] && remove_named "$NAME" || true
    }
    ;;
  *)
    fail "RUNTIME must be docker or container"
    ;;
esac

capture_readiness() {
  local label="$1"
  local path="${WORK}/stow-ready-${label}.json"
  copy_from_main /var/lib/aboiteau/run/stow-ready.json "$path"
  chmod 600 "$path"
  READINESS_FILES+=("$path")
}

run_agent_probe() {
  local mode="$1"
  local output="${WORK}/probe-main-${mode}.json"
  exec_in install -d -o 1001 -g 1001 -m 0700 /tmp/stow-probe-private
  exec_in install -o 1001 -g 1001 -m 0600 /var/lib/aboiteau/run/stow-ready.json \
    /tmp/stow-probe-private/stow-ready.json
  if ! exec_agent env -u CONTROL_TOKEN STOW_PROBE_READINESS_PATH=/tmp/stow-probe-private/stow-ready.json \
    STOW_EXPECTED_KERNEL_EXECUTABLE="$EXPECTED_KERNEL_EXECUTABLE" \
    bun /tmp/stow-s3-probe.ts "$mode" >"$output"; then
    cat "$output" >&2
    return 1
  fi
  cat "$output"
}

run_second_agent_probe() {
  local mode="$1"
  local output="${WORK}/probe-second-${mode}.json"
  exec_second install -d -o 1001 -g 1001 -m 0700 /tmp/stow-probe-private
  exec_second install -o 1001 -g 1001 -m 0600 /var/lib/aboiteau/run/stow-ready.json \
    /tmp/stow-probe-private/stow-ready.json
  if ! exec_second_agent env -u CONTROL_TOKEN STOW_PROBE_READINESS_PATH=/tmp/stow-probe-private/stow-ready.json \
    STOW_EXPECTED_KERNEL_EXECUTABLE="$EXPECTED_KERNEL_EXECUTABLE" \
    bun /tmp/stow-s3-probe.ts "$mode" >"$output"; then
    cat "$output" >&2
    return 1
  fi
  cat "$output"
}

run_root_probe() {
  local mode="$1"
  shift
  local output="${WORK}/probe-root-main-${mode}.json"
  if ! exec_in bun /tmp/stow-s3-probe.ts "$mode" "$@" >"$output"; then
    cat "$output" >&2
    return 1
  fi
  if ! jq -e '.ok == true' "$output" >/dev/null; then cat "$output" >&2; fi
  cat "$output"
}

run_second_root_probe() {
  local mode="$1"
  shift
  local output="${WORK}/probe-root-second-${mode}.json"
  if ! exec_second bun /tmp/stow-s3-probe.ts "$mode" "$@" >"$output"; then
    cat "$output" >&2
    return 1
  fi
  if ! jq -e '.ok == true' "$output" >/dev/null; then cat "$output" >&2; fi
  cat "$output"
}

run_host_lifecycle_race() {
  local kind="$1"
  local archive="$2"
  local output="${WORK}/lifecycle-${kind}-race.json"
  if ! RUNTIME="$RUNTIME" CONTROL_TOKEN="$CONTROL_TOKEN" node "$ROOT/scripts/control-lifecycle-race.mjs" \
    "$SECOND_BASE" "$SECOND_NAME" "$kind" "$archive" >"$output"; then
    cat "$output" >&2
    return 1
  fi
  if ! jq -e '.ok == true' "$output" >/dev/null; then cat "$output" >&2; fi
  cat "$output"
}

finish() {
  local status=$?
  if [[ "$status" != 0 && "$RUNTIME" == "docker" ]]; then
    echo "container smoke failed; collecting process diagnostics" >&2
    if [[ "$CREATED_MAIN" == 1 ]]; then
      docker top "$NAME" -eo pid,ppid,stat,comm >&2 || true
      docker exec "$NAME" sh -c 'for p in /proc/[0-9]*; do test -r "$p/status" || continue; sed -n -e "/^Name:/p" -e "/^State:/p" -e "/^Pid:/p" -e "/^PPid:/p" "$p/status"; printf "wait: "; cat "$p/wchan" 2>/dev/null; printf "\n"; done' >&2 || true
      docker logs --tail 200 "$NAME" >&2 || true
    fi
    if [[ "$CREATED_SECOND" == 1 ]]; then docker logs --tail 200 "$SECOND_NAME" >&2 || true; fi
  fi
  cleanup
  rm -rf "$WORK"
  exit "$status"
}

trap finish EXIT

echo "building ${IMAGE}…"
build_image

echo "starting ${NAME}…"
run_container
CREATED_MAIN=1
copy_to_main "$ROOT/scripts/stow-s3-probe.ts" /tmp/stow-s3-probe.ts

for _ in $(seq 1 300); do
  if curl -fsS "${BASE}/health" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
curl -fsS "${BASE}/health" >/dev/null || fail "control server did not become healthy"
ok "control server healthy"

AUTH=(-H "authorization: Bearer ${CONTROL_TOKEN}")

# Every operation except /health must require the per-container token.
code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/status")"
[[ "$code" == "401" ]] || fail "unauthenticated /status returned ${code}, expected 401"
ok "control token required"

curl -fsS "${AUTH[@]}" -X POST "${BASE}/configure" \
  -H 'content-type: application/json' \
  -d '{"model":"opencode/deepseek-v4.1-flash","permissions":{"allow":["cat *"],"ask":[],"deny":[]}}' \
  >/dev/null
ok "configured"

config="$(exec_in sh -c 'cat /var/lib/aboiteau/state/config/opencode/opencode.json')"
grep -q '/var/lib/aboiteau/state/\*\*' <<<"$config" || fail "state-root read/edit deny missing from OpenCode config"
grep -q '\$HOME' <<<"$config" || fail "HOME shell deny missing from OpenCode config"
ok "credential denials written to OpenCode config"

echo "starting runtime"
curl -sS -o "$WORK/start-one.json" -w '%{http_code}' "${AUTH[@]}" -X POST "${BASE}/start" >"$WORK/start-one.status" &
start_one_pid=$!
curl -sS -o "$WORK/start-two.json" -w '%{http_code}' "${AUTH[@]}" -X POST "${BASE}/start" >"$WORK/start-two.status" &
start_two_pid=$!
wait "$start_one_pid" || fail "first concurrent start request failed"
wait "$start_two_pid" || fail "second concurrent start request failed"
[[ "$(cat "$WORK/start-one.status")" == "200" && "$(cat "$WORK/start-two.status")" == "200" ]] \
  || fail "overlapping /start requests did not both return 200"
jq -e '.ok == true and .accountingPolicy == "foreground-usage-v1" and .eventPersistence == true and (.opencodeGeneration | type == "string" and length > 0)' \
  "$WORK/start-one.json" >/dev/null || fail "first /start response omitted readiness proof"
jq -e '.ok == true and .accountingPolicy == "foreground-usage-v1" and .eventPersistence == true and (.opencodeGeneration | type == "string" and length > 0)' \
  "$WORK/start-two.json" >/dev/null || fail "second /start response omitted readiness proof"
start_generation_one="$(jq -r .opencodeGeneration "$WORK/start-one.json")"
start_generation_two="$(jq -r .opencodeGeneration "$WORK/start-two.json")"
[[ "$start_generation_one" == "$start_generation_two" ]] || fail "overlapping starts reported different runtime generations"
echo "completed runtime start"
status="$(curl -fsS "${AUTH[@]}" "${BASE}/status")"
echo "$status" | jq -e '.initialized and .running and .s3' >/dev/null || fail "status not ready: ${status}"
ok "OpenCode and native Stow running"

stow_sha="$(exec_in sha256sum /usr/local/bin/stow-s3 | awk '{print $1}')"
[[ "$stow_sha" == "$EXPECTED_STOW_SHA256" ]] || fail "unexpected native Stow binary digest: ${stow_sha}"
ok "pinned native Stow binary verified"

if ! run_agent_probe native-process-check | tee "$WORK/native-process-check.json" | jq -e \
  '.ok and .opencodeAgentUID and .stowAgentUID and .opencodeS3EnvironmentMatchesReadiness and .stowProcessUsesPinnedBinary and .kernelExecutableMatchesExpected and .opencodeProcessCount == 1 and .stowProcessCount == 1' \
  >/dev/null; then
  cat "$WORK/native-process-check.json" >&2
  fail "native Stow/OpenCode runtime identity or readiness environment did not match"
fi
ok "native Stow readiness credentials are ephemeral and OpenCode uses them"

run_agent_probe workspace-root-native-first | jq -e \
  '.ok and .directFileToS3GetMatches and .s3PutToWorkspaceFileMatches and .metadataTypeMatches' \
  >/dev/null || fail "native workspace S3/file/content-type round trip failed"
ok "native workspace S3 and file APIs round-trip"
source_workspace_id="$(exec_in sh -c 'jq -r .workspace_id /var/lib/aboiteau/state/stow/identity.json')"
[[ -n "$source_workspace_id" ]] || fail "native workspace identity is missing"
capture_readiness initial

curl -fsS "${AUTH[@]}" "${BASE}/opencode/api/info" | jq -e . >/dev/null
ok "OpenCode proxy reachable"

# Workspace marker + checkpoint.
exec_in sh -c 'printf "smoke\n" > /workspace/smoke.txt && chmod 0644 /workspace/smoke.txt'
curl -fsS "${AUTH[@]}" -D "$HEADERS" "${BASE}/checkpoint?part=workspace" -o "$WS_ARCHIVE"
[[ -s "$WS_ARCHIVE" ]] || fail "workspace checkpoint empty"
tar tzf "$WS_ARCHIVE" | grep -q 'smoke.txt' || fail "workspace archive does not contain smoke.txt"
tar tzf "$WS_ARCHIVE" | grep -q '\.stow/index.json' || fail "workspace archive omitted native Stow index"
tar tzf "$WS_ARCHIVE" | grep -q '\.stow/manifest.json' || fail "workspace archive omitted native Stow manifest"
ok "workspace checkpoint contains the marker"

fingerprint="$(awk 'tolower($1)=="x-workspace-fingerprint:"{print $2}' "$HEADERS" | tr -d '\r')"
[[ -n "$fingerprint" ]] || fail "workspace checkpoint did not return a fingerprint"
code="$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${BASE}/checkpoint?part=workspace&since=${fingerprint}")"
[[ "$code" == "204" ]] || fail "unchanged workspace checkpoint returned ${code}, expected 204"
ok "unchanged workspace checkpoint is skipped"

# State marker + checkpoint.
exec_in sh -c 'printf "state\n" > /var/lib/aboiteau/state/smoke-state.txt && chown 1001:1001 /var/lib/aboiteau/state/smoke-state.txt && chmod 0660 /var/lib/aboiteau/state/smoke-state.txt'
curl -fsS "${AUTH[@]}" "${BASE}/checkpoint?part=state" -o "$STATE_ARCHIVE"
[[ -s "$STATE_ARCHIVE" ]] || fail "state checkpoint empty"
tar tzf "$STATE_ARCHIVE" | grep -q 'smoke-state.txt' || fail "state archive does not contain the marker"
tar tzf "$STATE_ARCHIVE" | grep -q 'stow/identity.json' || fail "conversation state archive omitted Stow identity"
tar tzf "$STATE_ARCHIVE" | grep -q 'stow/registry/' || fail "conversation state archive omitted Stow registry"
copy_to_main "$STATE_ARCHIVE" /tmp/conversation-state.tar.gz
ok "state checkpoint contains the marker"

# Workspace restore round-trip.
exec_in rm -f /workspace/smoke.txt
echo "starting workspace restore"
curl -fsS "${AUTH[@]}" -X POST --data-binary "@${WS_ARCHIVE}" "${BASE}/restore?part=workspace&final=1" >/dev/null
echo "completed workspace restore"
exec_in test -f /workspace/smoke.txt || fail "workspace restore lost the marker"
echo "starting runtime"
curl -fsS "${AUTH[@]}" -X POST "${BASE}/start" >/dev/null
echo "completed runtime start"
capture_readiness workspace-restore
curl -fsS "${AUTH[@]}" "${BASE}/status" | jq -e '.initialized and .running and .s3' >/dev/null \
  || fail "container did not restart after workspace restore"
restored_workspace_id="$(exec_in sh -c 'jq -r .workspace_id /var/lib/aboiteau/state/stow/identity.json')"
[[ "$source_workspace_id" == "$restored_workspace_id" ]] || fail "workspace restore changed native identity"
run_agent_probe native-process-check | jq -e '.ok' >/dev/null \
  || fail "workspace restore lost native readiness or process ownership"
run_agent_probe workspace-root-native-restarted | jq -e \
  '.ok and .directFileToS3GetMatches and .s3PutToWorkspaceFileMatches and .metadataTypeMatches' \
  >/dev/null || fail "workspace restore lost native files or object metadata"
ok "workspace restore round-trip"

# An archive with a symlink into harness state must be refused. GNU tar extracts
# the link itself successfully, so the workspace scan is the check that stops it.
exec_in sh -c 'rm -rf /tmp/evil-workspace && mkdir -p /tmp/evil-workspace && ln -s /var/lib/aboiteau/state /tmp/evil-workspace/escape && tar czf /tmp/evil-workspace.tar.gz -C /tmp/evil-workspace .'
code="$(exec_in sh -c "curl -s -o /dev/null -w '%{http_code}' -H 'authorization: Bearer ${CONTROL_TOKEN}' -X POST --data-binary @/tmp/evil-workspace.tar.gz 'http://127.0.0.1:4001/restore?part=workspace&final=1'")"
[[ "$code" == "500" ]] || fail "escaping workspace symlink returned ${code}, expected 500"
ok "escaping workspace symlink refused"

echo "starting workspace restore"
curl -fsS "${AUTH[@]}" -X POST --data-binary "@${WS_ARCHIVE}" "${BASE}/restore?part=workspace&final=1" >/dev/null
echo "completed workspace restore"
echo "starting runtime"
curl -fsS "${AUTH[@]}" -X POST "${BASE}/start" >/dev/null
echo "completed runtime start"
capture_readiness workspace-recovery
curl -fsS "${AUTH[@]}" "${BASE}/status" | jq -e '.initialized and .running and .s3' >/dev/null \
  || fail "container did not recover after refusing the malicious archive"
ok "workspace recovered after refusal"

# State restore round-trip.
exec_in rm -f /var/lib/aboiteau/state/smoke-state.txt
echo "starting state restore"
curl -fsS "${AUTH[@]}" -X POST --data-binary "@${STATE_ARCHIVE}" "${BASE}/restore?part=state" >/dev/null
echo "completed state restore"
exec_in test -f /var/lib/aboiteau/state/smoke-state.txt || fail "state restore lost the marker"
echo "starting runtime"
curl -fsS "${AUTH[@]}" -X POST "${BASE}/start" >/dev/null
echo "completed runtime start"
capture_readiness state-restore
curl -fsS "${AUTH[@]}" "${BASE}/status" | jq -e '.initialized and .running and .s3' >/dev/null \
  || fail "container did not restart after state restore"
restored_workspace_id="$(exec_in sh -c 'jq -r .workspace_id /var/lib/aboiteau/state/stow/identity.json')"
[[ "$source_workspace_id" == "$restored_workspace_id" ]] || fail "state restore changed native identity"
run_agent_probe native-process-check | jq -e '.ok' >/dev/null \
  || fail "state restore lost native readiness or process ownership"
run_agent_probe workspace-root-native-restarted | jq -e \
  '.ok and .directFileToS3GetMatches and .s3PutToWorkspaceFileMatches and .metadataTypeMatches' \
  >/dev/null || fail "state restore lost native files or object metadata"
ok "state restore round-trip"

# A same-conversation restore with its registry removed must fail closed and
# recover only after the original state archive is restored.
exec_in sh -c 'rm -rf /tmp/state-without-registry && mkdir -p /tmp/state-without-registry && tar xzf /tmp/conversation-state.tar.gz -C /tmp/state-without-registry && rm -rf /tmp/state-without-registry/stow/registry && tar czf /tmp/state-without-registry.tar.gz -C /tmp/state-without-registry .'
copy_from_main /tmp/state-without-registry.tar.gz "$MISSING_REGISTRY_ARCHIVE"
curl -fsS "${AUTH[@]}" -X POST --data-binary "@${MISSING_REGISTRY_ARCHIVE}" \
  "${BASE}/restore?part=state" >/dev/null || fail "registry-missing state fixture restore failed"
code="$(curl -sS -o "$WORK/missing-registry-start.json" -w '%{http_code}' "${AUTH[@]}" \
  -X POST "${BASE}/start")"
[[ "$code" == "409" ]] || fail "startup with missing Stow registry returned ${code}, expected 409"
run_root_probe native-process-count-check | jq -e \
  '.ok and .opencodeProcessCount == 0 and .stowProcessCount == 0 and .identityExists' >/dev/null \
  || fail "missing Stow registry started a child or changed identity"
missing_registry_id="$(exec_in sh -c 'jq -r .workspace_id /var/lib/aboiteau/state/stow/identity.json')"
[[ "$missing_registry_id" == "$source_workspace_id" ]] || fail "missing registry startup changed Stow identity"
curl -fsS "${AUTH[@]}" -X POST --data-binary "@${STATE_ARCHIVE}" \
  "${BASE}/restore?part=state" >/dev/null || fail "valid state archive recovery failed"
curl -fsS "${AUTH[@]}" -X POST "${BASE}/start" >/dev/null || fail "runtime did not recover after valid registry restore"
capture_readiness registry-recovery
run_agent_probe native-process-check | jq -e '.ok' >/dev/null \
  || fail "valid registry recovery failed the native process proof"
run_agent_probe workspace-root-native-restarted | jq -e \
  '.ok and .directFileToS3GetMatches and .s3PutToWorkspaceFileMatches and .metadataTypeMatches' \
  >/dev/null || fail "valid registry recovery lost native workspace content"
ok "missing registry fails closed and valid state restores the original identity"
capture_readiness current

# Account-state snapshot used by onboarding.
curl -fsS "${AUTH[@]}" "${BASE}/state-checkpoint" -o "$ACCOUNT_ARCHIVE"
[[ -s "$ACCOUNT_ARCHIVE" ]] || fail "account state checkpoint empty"
copy_to_main "$WS_ARCHIVE" /tmp/workspace-checkpoint.tar.gz
copy_to_main "$STATE_ARCHIVE" /tmp/conversation-state.tar.gz
copy_to_main "$ACCOUNT_ARCHIVE" /tmp/account-seed.tar.gz
ready_container_paths=()
for index in "${!READINESS_FILES[@]}"; do
  container_path="/tmp/stow-ready-generation-${index}.json"
  copy_to_main "${READINESS_FILES[$index]}" "$container_path"
  ready_container_paths+=("$container_path")
done
run_root_probe archive-boundary-check \
  /tmp/workspace-checkpoint.tar.gz /tmp/conversation-state.tar.gz /tmp/account-seed.tar.gz \
  "${ready_container_paths[@]}" | jq -e \
  '.ok and .readyFileAbsentFromArchives and .generatedCredentialsAbsentFromArchives and .workspaceMetadataPresent and .stateIdentityAndRegistryPresent and .accountSeedExcludesStowAndInitialized and .accountDatabaseBackupIsConsistent' \
  >/dev/null || fail "archive/seed identity or generated credential boundary failed"
ok "conversation checkpoints preserve identity; account seed excludes it and ephemeral credentials"

echo "starting runtime"
curl -fsS "${AUTH[@]}" -X POST "${BASE}/start" >/dev/null
echo "completed runtime start"
capture_readiness account-checkpoint
ok "account state checkpoint"

# A second fresh workspace proves account seeding copies only account state.
echo "starting fresh account-seed recipient ${SECOND_NAME}…"
run_second_container
CREATED_SECOND=1
for _ in $(seq 1 300); do
  if curl -fsS "${SECOND_BASE}/health" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
curl -fsS "${SECOND_BASE}/health" >/dev/null || fail "account-seed recipient control server did not become healthy"
AUTH_SECOND=(-H "authorization: Bearer ${CONTROL_TOKEN}")
copy_to_second "$ROOT/scripts/stow-s3-probe.ts" /tmp/stow-s3-probe.ts

code="$(curl -s -o /dev/null -w '%{http_code}' "${AUTH_SECOND[@]}" -X POST \
  --data-binary "@${STATE_ARCHIVE}" "${SECOND_BASE}/seed-state")"
[[ "$code" == "400" ]] || fail "conversation state seed returned ${code}, expected 400"
exec_second test ! -e /var/lib/aboiteau/state/stow/identity.json \
  || fail "rejected conversation state seed mutated recipient identity"
curl -fsS "${AUTH_SECOND[@]}" "${SECOND_BASE}/status" | jq -e '.initialized == false' >/dev/null \
  || fail "rejected conversation state seed initialized recipient"
ok "conversation state archive rejected before recipient mutation"

exec_second sh -c 'printf "preexisting\n" > /workspace/legacy.txt'
code="$(curl -s -o "$WORK/preexisting-start.json" -w '%{http_code}' "${AUTH_SECOND[@]}" \
  -X POST "${SECOND_BASE}/start")"
[[ "$code" == "409" ]] || fail "startup with preexisting workspace returned ${code}, expected 409"
[[ "$(exec_second cat /workspace/legacy.txt)" == "preexisting" ]] || fail "rejected startup changed workspace fixture"
exec_second test ! -e /var/lib/aboiteau/state/stow/identity.json \
  || fail "rejected startup created Stow identity"
run_second_root_probe native-process-count-check | jq -e \
  '.ok and .opencodeProcessCount == 0 and .stowProcessCount == 0 and (.identityExists | not)' >/dev/null \
  || fail "rejected startup left native child processes or identity"
exec_second rm /workspace/legacy.txt
ok "preexisting workspace refuses startup without identity or child processes"

run_host_lifecycle_race seed "$ACCOUNT_ARCHIVE" | jq -e \
  '.ok and .kind == "seed" and .operationStatus == 200 and .startStatus == 200 and .startBlockedUntilBodyComplete and .noNewStateOrChildrenWhileHeld and .workspaceIdentityMatchesOperation and .runtimeProofReturned' \
  >/dev/null || fail "account seed/start lifecycle gate race failed"
curl -fsS "${AUTH_SECOND[@]}" "${SECOND_BASE}/status" | jq -e '.initialized and .running and .s3' >/dev/null \
  || fail "account seeding start did not initialize recipient"
exec_second test -s /var/lib/aboiteau/state/stow/identity.json \
  || fail "recipient native Stow identity was not created"
curl -fsS "${AUTH_SECOND[@]}" "${SECOND_BASE}/status" | jq -e '.initialized and .running and .s3' >/dev/null \
  || fail "seeded recipient runtime did not become ready"
run_second_agent_probe native-process-check | jq -e \
  '.ok and .opencodeS3EnvironmentMatchesReadiness and .stowAgentUID and .stowProcessUsesPinnedBinary and .kernelExecutableMatchesExpected' >/dev/null \
  || fail "seeded recipient native readiness failed"
recipient_workspace_id="$(exec_second sh -c 'jq -r .workspace_id /var/lib/aboiteau/state/stow/identity.json')"
[[ -n "$source_workspace_id" && -n "$recipient_workspace_id" && "$source_workspace_id" != "$recipient_workspace_id" ]] \
  || fail "account seed reused the source Stow workspace identity"
exec_second test ! -e /workspace/b1-direct.txt || fail "account seed copied source workspace files"
ok "account seed creates a distinct Stow identity and empty workspace"

recipient_state_archive="${WORK}/recipient-state.tar.gz"
curl -fsS "${AUTH_SECOND[@]}" "${SECOND_BASE}/checkpoint?part=state" -o "$recipient_state_archive"
[[ -s "$recipient_state_archive" ]] || fail "recipient state checkpoint empty"
run_host_lifecycle_race restore "$recipient_state_archive" | jq -e \
  '.ok and .kind == "restore" and .operationStatus == 200 and .startStatus == 200 and .startBlockedUntilBodyComplete and .noNewStateOrChildrenWhileHeld and .workspaceIdentityMatchesOperation and .runtimeProofReturned' \
  >/dev/null || fail "state restore/start lifecycle gate race failed"
run_second_agent_probe native-process-check | jq -e '.ok' >/dev/null \
  || fail "recipient did not recover after gated state restore"
ok "streamed account seed and state restore serialize with /start"

identity_hash_before="$(exec_second sha256sum /var/lib/aboiteau/state/stow/identity.json | awk '{print $1}')"
code="$(curl -s -o /dev/null -w '%{http_code}' "${AUTH_SECOND[@]}" -X POST \
  --data-binary "@${ACCOUNT_ARCHIVE}" "${SECOND_BASE}/seed-state")"
[[ "$code" == "409" ]] || fail "account reseed of initialized runtime returned ${code}, expected 409"
identity_hash_after="$(exec_second sha256sum /var/lib/aboiteau/state/stow/identity.json | awk '{print $1}')"
[[ "$identity_hash_before" == "$identity_hash_after" ]] || fail "rejected reseed changed recipient identity"
ok "reseed of initialized runtime refused without changing identity"

# Remove the original container before creating a clean recipient for the same
# two saved checkpoint parts. This is a local fresh-container restore, not R2.
old_name="$NAME"
echo "removing original container ${old_name} before local cold restore"
remove_named "$old_name" || fail "could not remove the owned original container"
CREATED_MAIN=0
NAME="${old_name}-cold"
CONTROL_PORT="$((CONTROL_PORT + 20))"
BASE="http://127.0.0.1:${CONTROL_PORT}"
run_container
CREATED_MAIN=1
copy_to_main "$ROOT/scripts/stow-s3-probe.ts" /tmp/stow-s3-probe.ts
for _ in $(seq 1 300); do
  if curl -fsS "${BASE}/health" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
curl -fsS "${BASE}/health" >/dev/null || fail "local cold-restore container did not become healthy"
curl -fsS "${AUTH[@]}" "${BASE}/status" | jq -e '.initialized == false' >/dev/null \
  || fail "fresh local cold-restore container was unexpectedly initialized"
curl -fsS "${AUTH[@]}" -X POST --data-binary "@${WS_ARCHIVE}" \
  "${BASE}/restore?part=workspace" >/dev/null || fail "cold workspace archive restore failed"
curl -fsS "${AUTH[@]}" -X POST --data-binary "@${STATE_ARCHIVE}" \
  "${BASE}/restore?part=state" >/dev/null || fail "cold state archive restore failed"
curl -fsS "${AUTH[@]}" -X POST "${BASE}/start" -o "$WORK/cold-start.json" \
  || fail "fresh container did not start from restored identity"
jq -e '.ok == true and .accountingPolicy == "foreground-usage-v1" and .eventPersistence == true and (.opencodeGeneration | type == "string" and length > 0)' \
  "$WORK/cold-start.json" >/dev/null || fail "cold restore start omitted runtime proof"
curl -fsS "${AUTH[@]}" "${BASE}/status" | jq -e '.initialized and .running and .s3' >/dev/null \
  || fail "fresh container did not serve the restored workspace"
cold_workspace_id="$(exec_in sh -c 'jq -r .workspace_id /var/lib/aboiteau/state/stow/identity.json')"
[[ "$cold_workspace_id" == "$source_workspace_id" ]] || fail "fresh container prepared a replacement workspace identity"
run_agent_probe native-process-check | jq -e '.ok' >/dev/null \
  || fail "cold restore process ownership/readiness proof failed"
run_agent_probe workspace-root-native-restarted | jq -e \
  '.ok and .directFileToS3GetMatches and .s3PutToWorkspaceFileMatches and .metadataTypeMatches' \
  >/dev/null || fail "fresh container did not recover saved file/object/content-type data"
ok "fresh local container restores workspace identity and S3 data from both archives"

echo "container smoke test passed"
