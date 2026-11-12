#!/usr/bin/env bash
set -euo pipefail
umask 077

# Disposable R0-15A characterization of the currently pinned generic Stow
# filesystem backend. It never builds an image, mounts host data, or calls a
# model/provider. All S3 traffic stays inside the throwaway container.
#
#   bash scripts/characterize-stow-workspace.sh          # R0-15A regression
#   bash scripts/characterize-stow-workspace.sh workspace # native Stow B1
#   bash scripts/characterize-stow-workspace.sh recovery-baseline # C1 archive gap
#   bash scripts/characterize-stow-workspace.sh recovery # C1 split archive recovery

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-generic}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ "$MODE" == "workspace" ]]; then
  LOG_DIR="$(mktemp -d "/tmp/stow-workspace-b1-${STAMP}.XXXXXX")"
  NAME="stow-b1-${STAMP}-$$"
elif [[ "$MODE" == "recovery-baseline" || "$MODE" == "recovery" ]]; then
  LOG_DIR="$(mktemp -d "/tmp/stow-workspace-c1-${STAMP}.XXXXXX")"
  NAME="stow-c1-${STAMP}-$$"
else
  LOG_DIR="$(mktemp -d "/tmp/stow-workspace-characterization-${STAMP}.XXXXXX")"
  NAME="stow-char-${STAMP}-$$"
fi
chmod 700 "$LOG_DIR"
CONTROL_TOKEN="$(openssl rand -hex 24)"
CONTAINER_ID=""
CREATED=0
PHASE="preflight"

capture_failure_logs() {
  if [[ "$CREATED" == 1 && -n "$CONTAINER_ID" ]]; then
    BOUNDED_TIMEOUT_MS=15000 bounded docker logs --tail 300 "$CONTAINER_ID" 2>&1 \
      | sed -e "s/${CONTROL_TOKEN}/[REDACTED]/g" -e 's/stow-secret/[REDACTED]/g' \
      >"$LOG_DIR/container-failure.log" || true
  fi
}

fail() {
  echo "blocked: $*" >&2
  capture_failure_logs
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg reason "$*" --arg phase "$PHASE" '{status:"blocked",phase:$phase,reason:$reason}' >"$LOG_DIR/result.json"
  else
    printf '{"status":"blocked","reason":"jq unavailable; see stderr"}\n' >"$LOG_DIR/result.json"
  fi
  exit 2
}

bounded() {
  local timeout_ms="${BOUNDED_TIMEOUT_MS:-15000}"
  BOUNDED_TIMEOUT_MS="$timeout_ms" node -e '
    const { spawnSync } = require("node:child_process");
    const [command, ...args] = process.argv.slice(1);
    const timeout = Number(process.env.BOUNDED_TIMEOUT_MS);
    const result = spawnSync(command, args, { encoding: "utf8", timeout, killSignal: "SIGKILL" });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) {
      process.stderr.write(result.error.code === "ETIMEDOUT" ? "bounded command timed out\n" : "bounded command failed to spawn\n");
      process.exit(result.error.code === "ETIMEDOUT" ? 124 : 126);
    }
    process.exit(result.status ?? 1);
  ' "$@"
}

cleanup() {
  if [[ "$CREATED" == 1 && -n "$CONTAINER_ID" ]]; then
    local actual_name
    actual_name="$(BOUNDED_TIMEOUT_MS=15000 bounded docker inspect "$CONTAINER_ID" --format '{{.Name}}' 2>/dev/null || true)"
    if [[ "$actual_name" == "/$NAME" ]]; then
      BOUNDED_TIMEOUT_MS=15000 bounded docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || \
        echo "warning: failed to remove owned disposable container $CONTAINER_ID" >&2
    else
      echo "warning: container identity did not match; left it untouched" >&2
    fi
  fi
}

stop_workspace_serve() {
  local label="$1"
  local pids_file="$LOG_DIR/serve-${label}-pids.txt"
  local supervisor_pid
  local serve_pid
  supervisor_pid="$(awk 'NR==1 {print; exit}' "$pids_file")"
  serve_pid="$(awk 'NR==2 {print; exit}' "$pids_file")"
  [[ "$supervisor_pid" =~ ^[0-9]+$ && "$serve_pid" =~ ^[0-9]+$ ]] \
    || fail "native Workspace process identifiers were invalid"
  bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
    "test -r '/proc/$supervisor_pid/cmdline' && tr '\\000' ' ' <'/proc/$supervisor_pid/cmdline' | grep -F 'serve-supervisor.sh' >/dev/null && test -r '/proc/$serve_pid/cmdline' && tr '\\000' ' ' <'/proc/$serve_pid/cmdline' | grep -F 'stow-s3 workspace serve' >/dev/null && kill -TERM '$serve_pid'" \
    || fail "refused to stop an unverified Workspace serve process"
  local stopped=0
  for _ in $(seq 1 80); do
    if bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
      "test -s /tmp/stow-b1/serve-${label}.exit" >/dev/null 2>&1; then
      stopped=1
      break
    fi
    sleep 0.25
  done
  [[ "$stopped" == 1 ]] || fail "native Workspace serve did not stop within its bounded wait"
  bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
    "test \"\$(cat /tmp/stow-b1/serve-${label}.exit)\" = 0" \
    || fail "native Workspace serve did not exit cleanly after SIGTERM"
}

overlay_control_server() {
  local expected_hash actual_hash
  if [[ ! -f "$LOG_DIR/control-server-overlay.ts" ]]; then
    cp "$ROOT/control-server.ts" "$LOG_DIR/control-server-overlay.ts"
    chmod 600 "$LOG_DIR/control-server-overlay.ts"
  fi
  expected_hash="$(shasum -a 256 "$LOG_DIR/control-server-overlay.ts" | awk '{print $1}')"
  bounded docker cp "$LOG_DIR/control-server-overlay.ts" "$CONTAINER_ID:/app/control-server.ts" \
    || fail "could not apply the candidate control-server overlay to the stopped test container"
  bounded docker cp "$CONTAINER_ID:/app/control-server.ts" "$LOG_DIR/control-server-overlay-copied.ts" \
    || fail "could not read back the candidate controller from the stopped test container"
  chmod 600 "$LOG_DIR/control-server-overlay-copied.ts"
  actual_hash="$(shasum -a 256 "$LOG_DIR/control-server-overlay-copied.ts" | awk '{print $1}')"
  [[ "$actual_hash" == "$expected_hash" ]] || fail "control-server overlay hash did not match source"
  printf '%s\n' "$expected_hash" >"$LOG_DIR/control-server-overlay-sha256.txt"
}

run_workspace_b1() {
  local manifest_host="$LOG_DIR/workspace-manifest.json"
  local serve_pid=""

  PHASE="workspace-preflight"
  bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
    'test -d /workspace && test ! -e /workspace/stow-workspace && test -d /var/lib/aboiteau/state' \
    || fail "workspace root is not absent or expected parent paths are unavailable"
  jq -n '{version:1,root:"/workspace/stow-workspace",working_directory:".",registry_dir:"/var/lib/aboiteau/state/stow/registry",bucket:"aboiteau-workspace",inputs:[{source:"/tmp/stow-b1/seed.txt",destination:"seed.txt"}]}' \
    >"$manifest_host"
  chmod 600 "$manifest_host"
  printf '%s\n' 'synthetic-b1-prepare-seed-v1' >"$LOG_DIR/seed.txt"
  chmod 600 "$LOG_DIR/seed.txt"
  bounded docker exec "$CONTAINER_ID" sh -lc \
    'mkdir -p /tmp/stow-b1 && chown 1001:1001 /tmp/stow-b1 && chmod 700 /tmp/stow-b1' \
    || fail "could not create private in-container B1 directory"
  bounded docker cp "$manifest_host" "$CONTAINER_ID:/tmp/stow-b1/manifest.json" \
    || fail "could not copy private synthetic manifest"
  bounded docker cp "$LOG_DIR/seed.txt" "$CONTAINER_ID:/tmp/stow-b1/seed.txt" \
    || fail "could not copy synthetic local seed input"
  bounded docker cp "$ROOT/scripts/stow-s3-probe.ts" "$CONTAINER_ID:/tmp/stow-b1/stow-s3-probe.ts" \
    || fail "could not copy S3 probe into disposable container"
  bounded docker exec "$CONTAINER_ID" sh -lc \
    'chown 1001:1001 /tmp/stow-b1/manifest.json /tmp/stow-b1/seed.txt /tmp/stow-b1/stow-s3-probe.ts && chmod 600 /tmp/stow-b1/manifest.json /tmp/stow-b1/seed.txt /tmp/stow-b1/stow-s3-probe.ts' \
    || fail "could not set private B1 file permissions"

  PHASE="workspace-prepare"
  if ! BOUNDED_TIMEOUT_MS=30000 bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
    'stow-s3 workspace prepare --manifest /tmp/stow-b1/manifest.json > /tmp/stow-b1/prepared.json 2> /tmp/stow-b1/prepare.stderr'; then
    bounded docker cp "$CONTAINER_ID:/tmp/stow-b1/prepare.stderr" "$LOG_DIR/prepare.stderr" >/dev/null 2>&1 || true
    fail "native Workspace prepare failed; see private prepare.stderr"
  fi
  bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
    'chmod 600 /tmp/stow-b1/prepared.json /tmp/stow-b1/prepare.stderr' \
    || fail "could not protect prepared descriptor"
  if ! BOUNDED_TIMEOUT_MS=15000 bounded docker exec --user 1001:1001 "$CONTAINER_ID" \
    bun /tmp/stow-b1/stow-s3-probe.ts workspace-prepare-check \
    /tmp/stow-b1/manifest.json /tmp/stow-b1/prepared.json >"$LOG_DIR/prepare-check.json"; then
    fail "prepared descriptor did not match the locked B1 identity; see prepare-check.json"
  fi
  jq -e '.ok == true and .versionMatches and .workspaceIDValid and .rootMatches and .workingDirectoryWithinRoot and .workingDirectoryMatchesManifest and .registryMatches and .bucketMatches' \
    "$LOG_DIR/prepare-check.json" >/dev/null || fail "prepared descriptor validation failed"
  if ! bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
    'cmp -s /tmp/stow-b1/seed.txt /workspace/stow-workspace/seed.txt'; then
    fail "native Workspace prepare did not copy the synthetic seed bytes exactly"
  fi
  printf '%s\n' '{"seedCopiedExactly":true}' >"$LOG_DIR/prepared-seed-check.json"
  bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
    "jq -er '.workspace_id | select(type == \"string\" and test(\"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$\"))' /tmp/stow-b1/prepared.json > /tmp/stow-b1/workspace-id && chmod 600 /tmp/stow-b1/workspace-id" \
    || fail "prepared workspace identity was invalid"
  cat >"$LOG_DIR/serve-supervisor.sh" <<'EOF'
#!/bin/sh
set -u
label="$1"
base=/tmp/stow-b1
workspace_id="$(cat "$base/workspace-id")"
readiness="$base/readiness-${label}.json"
childpid="$base/serve-${label}.childpid"
logfile="$base/serve-${label}.log"
exitfile="$base/serve-${label}.exit"
stow-s3 workspace serve --id "$workspace_id" --registry-dir /var/lib/aboiteau/state/stow/registry --ready-fd 3 3>"$readiness" >"$logfile" 2>&1 </dev/null &
child=$!
printf '%s\n' "$child" >"$childpid"
wait "$child"
status=$?
printf '%s\n' "$status" >"$exitfile.tmp"
mv "$exitfile.tmp" "$exitfile"
exit 0
EOF
  chmod 600 "$LOG_DIR/serve-supervisor.sh"
  bounded docker cp "$LOG_DIR/serve-supervisor.sh" "$CONTAINER_ID:/tmp/stow-b1/serve-supervisor.sh" \
    || fail "could not copy private Workspace supervisor"
  bounded docker exec "$CONTAINER_ID" sh -lc \
    'chown 1001:1001 /tmp/stow-b1/serve-supervisor.sh && chmod 600 /tmp/stow-b1/serve-supervisor.sh' \
    || fail "could not protect Workspace supervisor"

  start_workspace_serve() {
    local label="$1"
    local readiness="/tmp/stow-b1/readiness-${label}.json"
    local supervisor_pidfile="/tmp/stow-b1/serve-${label}.supervisorpid"
    local child_pidfile="/tmp/stow-b1/serve-${label}.childpid"
    local exitfile="/tmp/stow-b1/serve-${label}.exit"
    local logfile="/tmp/stow-b1/serve-${label}.log"
    bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
      "rm -f '$readiness' '$supervisor_pidfile' '$child_pidfile' '$exitfile' '$logfile'; nohup sh /tmp/stow-b1/serve-supervisor.sh '$label' >/dev/null 2>&1 </dev/null & echo \$! >'$supervisor_pidfile'" \
      || fail "native Workspace serve start failed for $label"
    local ready=0
    for _ in $(seq 1 120); do
      if bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
        "test -s '$readiness' && test -s '$supervisor_pidfile' && test -s '$child_pidfile' && kill -0 \$(cat '$child_pidfile')" >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 0.25
    done
    [[ "$ready" == 1 ]] || fail "native Workspace readiness timed out for $label"
    bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
      "chmod 600 '$readiness' '$supervisor_pidfile' '$child_pidfile' '$logfile'; cat '$supervisor_pidfile'; cat '$child_pidfile'" >"$LOG_DIR/serve-${label}-pids.txt" \
      || fail "could not capture native Workspace process ownership"
    bounded docker exec --user 1001:1001 "$CONTAINER_ID" \
      bun /tmp/stow-b1/stow-s3-probe.ts workspace-validation-selftest \
      /tmp/stow-b1/manifest.json /tmp/stow-b1/prepared.json "$readiness" \
      >"$LOG_DIR/readiness-${label}-validation.json" \
      || fail "native Workspace readiness validation failed for $label"
    jq -e '.ok == true and .noClientBeforeValidation and .s3ClientConstructions == 0 and .versionRejected and .foreignRootRejected and .foreignWorkspaceIDRejected and .offLoopbackEndpointRejected' \
      "$LOG_DIR/readiness-${label}-validation.json" >/dev/null \
      || fail "readiness negative checks failed for $label"
  }

  PHASE="workspace-first-serve"
  start_workspace_serve first
  local first_probe_mode=workspace-first
  if [[ "$MODE" == "recovery" ]]; then
    first_probe_mode=workspace-recovery-first
  fi
  if ! BOUNDED_TIMEOUT_MS=15000 bounded docker exec --user 1001:1001 "$CONTAINER_ID" \
    bun "/tmp/stow-b1/stow-s3-probe.ts" "$first_probe_mode" \
    /tmp/stow-b1/manifest.json /tmp/stow-b1/prepared.json /tmp/stow-b1/readiness-first.json \
    >"$LOG_DIR/workspace-first.json"; then
    fail "native Workspace first S3/file round trip failed; see workspace-first.json"
  fi
  jq -e '.ok == true and .readinessValid and .endpointLoopback and .directFileToS3GetMatches and .s3PutToWorkspaceFileMatches and (if .mode == "workspace-recovery-first" then .metadataBytesMatch and .metadataTypeMatches else true end)' \
    "$LOG_DIR/workspace-first.json" >/dev/null || fail "native Workspace first round trip did not match"

  if [[ "$MODE" == "recovery-baseline" ]]; then
    PHASE="recovery-baseline-observe"
    if ! bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
      'test -d /workspace/stow-workspace/.stow && find /workspace/stow-workspace/.stow -type f -print | sed "s#^/workspace/stow-workspace/##" | LC_ALL=C sort' \
      >"$LOG_DIR/native-stow-files.txt"; then
      fail "native Stow did not create its workspace object metadata"
    fi
    [[ -s "$LOG_DIR/native-stow-files.txt" ]] || fail "native Stow metadata directory had no files"
    curl --max-time 20 -fsS "${AUTH[@]}" -D "$LOG_DIR/workspace-archive.headers" \
      "$BASE/checkpoint?part=workspace" -o "$LOG_DIR/workspace.tar.gz" \
      || fail "split workspace checkpoint failed or timed out"
    curl --max-time 20 -fsS "${AUTH[@]}" -D "$LOG_DIR/state-archive.headers" \
      "$BASE/checkpoint?part=state" -o "$LOG_DIR/state.tar.gz" \
      || fail "split state checkpoint failed or timed out"
    [[ -s "$LOG_DIR/workspace.tar.gz" && -s "$LOG_DIR/state.tar.gz" ]] \
      || fail "split checkpoint returned an empty archive"
    tar -tzf "$LOG_DIR/workspace.tar.gz" >"$LOG_DIR/workspace-archive-members.txt"
    tar -tzf "$LOG_DIR/state.tar.gz" >"$LOG_DIR/state-archive-members.txt"
    local metadata_in_workspace_archive=false
    if rg -q '(^|/)\.stow(/|$)' "$LOG_DIR/workspace-archive-members.txt"; then
      metadata_in_workspace_archive=true
    fi
    local registry_in_state_archive=false
    if rg -q '(^|/)stow/registry(/|$)' "$LOG_DIR/state-archive-members.txt"; then
      registry_in_state_archive=true
    fi
    if [[ "$metadata_in_workspace_archive" != false || "$registry_in_state_archive" != true ]]; then
      fail "split archive baseline did not show the expected native metadata omission and registry inclusion"
    fi
    local native_metadata_count
    native_metadata_count="$(wc -l <"$LOG_DIR/native-stow-files.txt" | tr -d ' ')"
    jq -n \
      --arg status "baseline_gap_reproduced" \
      --arg image "$EVENTED_IMAGE" \
      --arg platform "$IMAGE_PLATFORM" \
      --arg hostArch "$HOST_ARCH" \
      --arg stowSHA256 "$(awk 'length($1)==64 && $1 ~ /^[0-9a-f]+$/ {print $1; exit}' "$LOG_DIR/stow-binary.txt")" \
      --arg containerID "$CONTAINER_ID" \
      --arg containerName "$NAME" \
      --argjson nativeMetadataCount "$native_metadata_count" \
      --argjson nativeMetadataExcluded true \
      --argjson registryIncludedInState true \
      --argjson recoveryPerformed false \
      '{status:$status,mode:"c1_archive_baseline",image:$image,platform:$platform,hostArch:$hostArch,stowBinarySHA256:$stowSHA256,containerID:$containerID,containerName:$containerName,nativeMetadataCount:$nativeMetadataCount,nativeMetadataExcludedFromWorkspaceArchive:$nativeMetadataExcluded,registryIncludedInStateArchive:$registryIncludedInState,recoveryPerformed:$recoveryPerformed}' \
      >"$LOG_DIR/result.json"
    echo "C1 archive omission baseline reproduced; evidence: $LOG_DIR"
    cat "$LOG_DIR/result.json"
    return 0
  fi

  if [[ "$MODE" == "recovery" ]]; then
    PHASE="workspace-quiesce-before-checkpoint"
    stop_workspace_serve first
    bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
      'jq -c "{version,workspace_id,root,working_directory,registry_dir,bucket}" /tmp/stow-b1/prepared.json' \
      >"$LOG_DIR/prepared-reference.json" \
      || fail "could not retain the nonsecret fixture reference"
    chmod 600 "$LOG_DIR/prepared-reference.json"
    local workspace_id
    workspace_id="$(jq -r '.workspace_id' "$LOG_DIR/prepared-reference.json")"
    [[ "$workspace_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || fail "fixture workspace identity was invalid"
    bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
      'find /workspace/stow-workspace/.stow -type f -print | sed "s#^/workspace/stow-workspace/##" | LC_ALL=C sort' \
      >"$LOG_DIR/native-stow-files.txt" || fail "could not inventory native Workspace metadata"
    rg -q '^\.stow/index\.json$' "$LOG_DIR/native-stow-files.txt" \
      || fail "quiesced native metadata omitted index.json"
    rg -q '^\.stow/manifest\.json$' "$LOG_DIR/native-stow-files.txt" \
      || fail "quiesced native metadata omitted manifest.json"

    PHASE="split-checkpoint"
    curl --max-time 20 -fsS "${AUTH[@]}" -D "$LOG_DIR/workspace-archive.headers" \
      "$BASE/checkpoint?part=workspace" -o "$LOG_DIR/workspace.tar.gz" \
      || fail "split workspace checkpoint failed or timed out"
    curl --max-time 20 -fsS "${AUTH[@]}" -D "$LOG_DIR/state-archive.headers" \
      "$BASE/checkpoint?part=state" -o "$LOG_DIR/state.tar.gz" \
      || fail "split state checkpoint failed or timed out"
    [[ -s "$LOG_DIR/workspace.tar.gz" && -s "$LOG_DIR/state.tar.gz" ]] \
      || fail "split checkpoint returned an empty archive"
    tar -tzf "$LOG_DIR/workspace.tar.gz" >"$LOG_DIR/workspace-archive-members.txt"
    tar -tzf "$LOG_DIR/state.tar.gz" >"$LOG_DIR/state-archive-members.txt"
    rg -q '(^|/)stow-workspace/\.stow/index\.json$' "$LOG_DIR/workspace-archive-members.txt" \
      || fail "candidate workspace archive omitted native index metadata"
    rg -q '(^|/)stow-workspace/\.stow/manifest\.json$' "$LOG_DIR/workspace-archive-members.txt" \
      || fail "candidate workspace archive omitted native manifest metadata"
    rg -q '(^|/)stow/registry/[^/]+\.json$' "$LOG_DIR/state-archive-members.txt" \
      || fail "candidate state archive omitted the native registry record"

    local original_container_id original_container_name overlay_sha
    original_container_id="$CONTAINER_ID"
    ORIGINAL_CONTAINER_ID="$CONTAINER_ID"
    original_container_name="$NAME"
    overlay_sha="$(cat "$LOG_DIR/control-server-overlay-sha256.txt")"
    printf '%s\n' "$workspace_id" >"$LOG_DIR/workspace-id-reference.txt"
    chmod 600 "$LOG_DIR/workspace-id-reference.txt"
    shasum -a 256 "$LOG_DIR/workspace.tar.gz" "$LOG_DIR/state.tar.gz" >"$LOG_DIR/archive-sha256.txt"

    PHASE="remove-original-container"
    local actual_name
    actual_name="$(bounded docker inspect "$original_container_id" --format '{{.Name}}')" \
      || fail "could not verify original container ownership before removal"
    [[ "$actual_name" == "/$original_container_name" ]] \
      || fail "original container name did not match; refusing removal"
    bounded docker rm -f "$original_container_id" >/dev/null \
      || fail "could not remove original synthetic container"
    if bounded docker inspect "$original_container_id" >/dev/null 2>&1; then
      fail "original container still exists after removal"
    fi
    CREATED=0
    CONTAINER_ID=""
    NAME="${original_container_name}-restore"
    if bounded docker container inspect "$NAME" >/dev/null 2>&1; then
      fail "generated restore container name already exists; refusing to touch it"
    fi
    CONTAINER_ID="$(BOUNDED_TIMEOUT_MS=30000 bounded docker create --platform linux/amd64 --name "$NAME" \
      --env "CONTROL_TOKEN=$CONTROL_TOKEN" --env STOW_ACCESS_KEY=stow --env STOW_SECRET_KEY=stow-secret \
      -p 127.0.0.1::4001 "$EVENTED_IMAGE")" || fail "could not create fresh empty restore container"
    CREATED=1
    printf '%s\n' "$CONTAINER_ID" >"$LOG_DIR/restore-container-id.txt"
    printf '%s\n' "$NAME" >"$LOG_DIR/restore-container-name.txt"
    overlay_control_server
    BOUNDED_TIMEOUT_MS=30000 bounded docker start "$CONTAINER_ID" >/dev/null \
      || fail "could not start fresh restore container"
    HOST_PORT="$(bounded docker port "$CONTAINER_ID" 4001/tcp | awk -F: 'NR==1 {print $NF}')" \
      || fail "could not resolve fresh restore control port"
    [[ "$HOST_PORT" =~ ^[0-9]+$ ]] || fail "fresh restore control port was not assigned"
    BASE="http://127.0.0.1:${HOST_PORT}"
    PHASE="restore-control-readiness"
    ready=0
    for _ in $(seq 1 120); do
      if curl --max-time 2 -fsS "$BASE/health" >/dev/null 2>&1; then ready=1; break; fi
      sleep 0.5
    done
    [[ "$ready" == 1 ]] || fail "fresh restore control server readiness timed out"
    PHASE="fresh-container-empty-check"
    bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
      'test ! -e /workspace/stow-workspace && test ! -e /var/lib/aboiteau/state/stow/registry' \
      || fail "fresh restore container unexpectedly contains a workspace or native registry before restore"
    printf '%s\n' '{"nativeRootAbsentBeforeRestore":true,"registryAbsentBeforeRestore":true}' \
      >"$LOG_DIR/fresh-container-empty-check.json"

    PHASE="split-restore"
    curl --max-time 30 -fsS "${AUTH[@]}" -X POST "$BASE/restore?part=workspace" \
      -H 'content-type: application/gzip' --data-binary "@$LOG_DIR/workspace.tar.gz" \
      -o "$LOG_DIR/workspace-restore-response.json" \
      || fail "workspace archive restore failed or timed out"
    curl --max-time 30 -fsS "${AUTH[@]}" -X POST "$BASE/restore?part=state&final=1" \
      -H 'content-type: application/gzip' --data-binary "@$LOG_DIR/state.tar.gz" \
      -o "$LOG_DIR/state-restore-response.json" \
      || fail "state archive restore failed or timed out"
    jq -e '.ok == true and .part == "workspace"' "$LOG_DIR/workspace-restore-response.json" >/dev/null \
      || fail "workspace restore response did not confirm success"
    jq -e '.ok == true and .part == "state"' "$LOG_DIR/state-restore-response.json" >/dev/null \
      || fail "state restore response did not confirm success"

    PHASE="restore-fixture-inputs"
    bounded docker exec "$CONTAINER_ID" sh -lc \
      'mkdir -p /tmp/stow-b1 && chown 1001:1001 /tmp/stow-b1 && chmod 700 /tmp/stow-b1' \
      || fail "could not create private restore probe directory"
    for fixture in manifest.json seed.txt; do
      local fixture_source="$LOG_DIR/workspace-manifest.json"
      [[ "$fixture" == "seed.txt" ]] && fixture_source="$LOG_DIR/seed.txt"
      bounded docker cp "$fixture_source" "$CONTAINER_ID:/tmp/stow-b1/$fixture" \
        || fail "could not copy fixture input $fixture into restored container"
    done
    bounded docker cp "$ROOT/scripts/stow-s3-probe.ts" "$CONTAINER_ID:/tmp/stow-b1/stow-s3-probe.ts" \
      || fail "could not copy probe into restored container"
    bounded docker cp "$LOG_DIR/serve-supervisor.sh" "$CONTAINER_ID:/tmp/stow-b1/serve-supervisor.sh" \
      || fail "could not copy supervisor into restored container"
    bounded docker cp "$LOG_DIR/prepared-reference.json" "$CONTAINER_ID:/tmp/stow-b1/prepared.json" \
      || fail "could not copy fixture descriptor reference into restored container"
    bounded docker cp "$LOG_DIR/workspace-id-reference.txt" "$CONTAINER_ID:/tmp/stow-b1/workspace-id" \
      || fail "could not copy fixture identity reference into restored container"
    bounded docker exec "$CONTAINER_ID" sh -lc \
      'chown 1001:1001 /tmp/stow-b1/* && chmod 600 /tmp/stow-b1/*' \
      || fail "could not protect fixture reference files in restored container"
    bounded docker exec --user 1001:1001 "$CONTAINER_ID" sh -lc \
      'cmp -s /workspace/stow-workspace/seed.txt /tmp/stow-b1/seed.txt' \
      || fail "restored workspace seed bytes did not match the synthetic fixture"

    PHASE="native-resume-without-prepare"
    # Add a distinct readiness path for the fresh container. The same prepared
    # descriptor is only an identity reference; no native prepare is invoked.
    start_workspace_serve restored
    if ! BOUNDED_TIMEOUT_MS=15000 bounded docker exec --user 1001:1001 "$CONTAINER_ID" \
      bun /tmp/stow-b1/stow-s3-probe.ts workspace-recovery-restored \
      /tmp/stow-b1/manifest.json /tmp/stow-b1/prepared.json /tmp/stow-b1/readiness-restored.json \
      >"$LOG_DIR/restored-verification.json"; then
      fail "restored native workspace did not serve the same ID/data/metadata; see restored-verification.json"
    fi
    jq -e '.ok == true and .readinessValid and .endpointLoopback and .directFileToS3GetMatches and .s3PutToWorkspaceFileMatches and .metadataBytesMatch and .metadataTypeMatches' \
      "$LOG_DIR/restored-verification.json" >/dev/null \
      || fail "restored workspace bytes or content-type metadata did not match"
    stop_workspace_serve restored
    jq -n \
      --arg status "split_archive_recovery_verified" \
      --arg image "$EVENTED_IMAGE" \
      --arg imageID "$(awk '{print $1}' "$LOG_DIR/image-inspect.txt")" \
      --arg platform "$IMAGE_PLATFORM" \
      --arg hostArch "$HOST_ARCH" \
      --arg emulation "$EMULATION" \
      --arg stowSHA256 "$(awk 'length($1)==64 && $1 ~ /^[0-9a-f]+$/ {print $1; exit}' "$LOG_DIR/stow-binary.txt")" \
      --arg controllerOverlaySHA256 "$overlay_sha" \
      --arg originalContainerID "$original_container_id" \
      --arg restoredContainerID "$CONTAINER_ID" \
      --arg workspaceArchiveSHA256 "$(awk 'NR==1 {print $1}' "$LOG_DIR/archive-sha256.txt")" \
      --arg stateArchiveSHA256 "$(awk 'NR==2 {print $1}' "$LOG_DIR/archive-sha256.txt")" \
      --argjson prepareCount 1 \
      --argjson nativeResumeWithoutPrepare true \
      --argjson splitArchivesRestored true \
      --argjson objectBytesPreserved true \
      --argjson contentTypePreserved true \
      --argjson originalRemovedBeforeRestore true \
      '{status:$status,mode:"c1_split_archive_recovery",image:$image,imageID:$imageID,platform:$platform,hostArch:$hostArch,emulation:$emulation,stowBinarySHA256:$stowSHA256,controllerOverlaySHA256:$controllerOverlaySHA256,originalContainerID:$originalContainerID,restoredContainerID:$restoredContainerID,workspaceArchiveSHA256:$workspaceArchiveSHA256,stateArchiveSHA256:$stateArchiveSHA256,prepareCount:$prepareCount,nativeResumeWithoutPrepare:$nativeResumeWithoutPrepare,splitArchivesRestored:$splitArchivesRestored,objectBytesPreserved:$objectBytesPreserved,contentTypePreserved:$contentTypePreserved,originalRemovedBeforeRestore:$originalRemovedBeforeRestore,sameContainerRestart:false,freshContainerReplacement:true,r2ColdRestore:false,multipartRecoveryQualified:false}' \
      >"$LOG_DIR/result.json"
    echo "C1 split archive recovery passed; evidence: $LOG_DIR"
    cat "$LOG_DIR/result.json"
    return 0
  fi

  PHASE="workspace-serve-stop"
  stop_workspace_serve first

  PHASE="workspace-serve-restart"
  start_workspace_serve restart
  if ! BOUNDED_TIMEOUT_MS=15000 bounded docker exec --user 1001:1001 "$CONTAINER_ID" \
    bun /tmp/stow-b1/stow-s3-probe.ts workspace-restart \
    /tmp/stow-b1/manifest.json /tmp/stow-b1/prepared.json /tmp/stow-b1/readiness-restart.json \
    >"$LOG_DIR/workspace-restart.json"; then
    fail "native Workspace process restart did not preserve bytes; see workspace-restart.json"
  fi
  jq -e '.ok == true and .readinessValid and .endpointLoopback and .directFileToS3GetMatches and .s3PutToWorkspaceFileMatches' \
    "$LOG_DIR/workspace-restart.json" >/dev/null || fail "native Workspace restart round trip did not match"

  local stow_sha image_id
  stow_sha="$(awk 'length($1)==64 && $1 ~ /^[0-9a-f]+$/ {print $1; exit}' "$LOG_DIR/stow-binary.txt")"
  image_id="$(awk '{print $1}' "$LOG_DIR/image-inspect.txt")"
  jq -n \
    --arg status "characterized" \
    --arg image "$EVENTED_IMAGE" \
    --arg imageID "$image_id" \
    --arg platform "$IMAGE_PLATFORM" \
    --arg hostArch "$HOST_ARCH" \
    --arg emulation "$EMULATION" \
    --arg stowSHA256 "$stow_sha" \
    --arg containerID "$CONTAINER_ID" \
    --arg containerName "$NAME" \
    --argjson workspaceIDValid true \
    --argjson manifestMatches true \
    --argjson readinessValidatedTwice true \
    --argjson directFileToS3Get true \
    --argjson s3PutToWorkspaceFile true \
    --argjson processRestartPreserved true \
    '{status:$status,mode:"native_workspace_b1",image:$image,imageID:$imageID,platform:$platform,hostArch:$hostArch,emulation:$emulation,containerID:$containerID,containerName:$containerName,stowBinarySHA256:$stowSHA256,workspaceIDValid:$workspaceIDValid,manifestMatches:$manifestMatches,readinessValidatedTwice:$readinessValidatedTwice,directFileToS3Get:$directFileToS3Get,s3PutToWorkspaceFile:$s3PutToWorkspaceFile,processRestartPreserved:$processRestartPreserved,prepareCount:1,serveStarts:2,containerRestart:false,r2ColdRestore:false,objectIdentityOrMultipartRecoveryQualified:false}' \
    >"$LOG_DIR/result.json"
  echo "native Workspace B1 characterization passed; evidence: $LOG_DIR"
  cat "$LOG_DIR/result.json"
}
trap cleanup EXIT INT TERM

for command in docker curl jq tar rg awk openssl bun node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing host command: $command"
done
[[ "$MODE" == "generic" || "$MODE" == "workspace" || "$MODE" == "recovery-baseline" || "$MODE" == "recovery" ]] || fail "mode must be generic, workspace, recovery-baseline or recovery"

# Resolve the image from wrangler.jsonc instead of accepting a mutable tag or
# caller-provided replacement.
EVENTED_IMAGE="$(awk '/"evented":/ { in_evented=1 } in_evented && /"image":/ { sub(/.*"image": "/, ""); sub(/".*/, ""); print; exit }' "$ROOT/wrangler.jsonc")"
[[ "$EVENTED_IMAGE" == *@sha256:* ]] || fail "wrangler.jsonc evented image is not digest-pinned"
printf '%s\n' "$EVENTED_IMAGE" >"$LOG_DIR/image-ref.txt"

# Resolve the effective Docker endpoint and allow local Unix sockets regardless
# of their path. Remote TCP/SSH endpoints are outside this disposable fixture.
if [[ -n "${DOCKER_CONTEXT:-}" ]]; then
  DOCKER_CONTEXT_NAME="$DOCKER_CONTEXT"
  DOCKER_ENDPOINT="$(bounded docker context inspect "$DOCKER_CONTEXT_NAME" --format '{{(index .Endpoints "docker").Host}}')" \
    || fail "could not resolve Docker context endpoint"
elif [[ -n "${DOCKER_HOST:-}" ]]; then
  DOCKER_ENDPOINT="$DOCKER_HOST"
  DOCKER_CONTEXT_NAME="DOCKER_HOST"
else
  DOCKER_CONTEXT_NAME="$(bounded docker context show)" || fail "could not resolve Docker context"
  DOCKER_ENDPOINT="$(bounded docker context inspect "$DOCKER_CONTEXT_NAME" --format '{{(index .Endpoints "docker").Host}}')" \
    || fail "could not resolve Docker context endpoint"
fi
case "$DOCKER_ENDPOINT" in
  unix:///*) ;;
  *) fail "selected Docker endpoint is not a local Unix socket" ;;
esac
printf '%s %s\n' "$DOCKER_CONTEXT_NAME" "$DOCKER_ENDPOINT" >"$LOG_DIR/docker-context.txt"

PHASE="daemon-preflight"
if ! bounded docker info --format '{{.ServerVersion}} {{.OSType}}/{{.Architecture}}' >"$LOG_DIR/docker-info.txt" 2>&1 \
  || ! rg -q '^[^[:space:]]+[[:space:]]+(linux|darwin|windows)/[[:alnum:]_]+$' "$LOG_DIR/docker-info.txt"; then
  fail "local Docker daemon unavailable; see docker-info.txt"
fi

if bounded docker container inspect "$NAME" >/dev/null 2>&1; then
  fail "generated container name already exists; refusing to touch it"
fi

# Use an already-cached exact digest when available. Pull only that digest if
# absent; never rebuild, retag, or substitute another artifact.
PHASE="image-inspection"
if ! bounded docker image inspect "$EVENTED_IMAGE" --format '{{.Id}} {{.Os}}/{{.Architecture}}' \
  >"$LOG_DIR/image-inspect.txt" 2>"$LOG_DIR/image-inspect-error.txt"; then
  if ! rg -qi 'no such image' "$LOG_DIR/image-inspect-error.txt"; then
    fail "could not inspect exact pinned image; see image-inspect-error.txt"
  fi
  if ! BOUNDED_TIMEOUT_MS=180000 bounded docker pull --platform linux/amd64 "$EVENTED_IMAGE" >"$LOG_DIR/pull.log" 2>&1; then
    fail "could not access exact pinned linux/amd64 evented image; see pull.log"
  fi
  bounded docker image inspect "$EVENTED_IMAGE" --format '{{.Id}} {{.Os}}/{{.Architecture}}' >"$LOG_DIR/image-inspect.txt" \
    || fail "could not inspect exact pinned image after pull"
fi
HOST_ARCH="$(uname -m)"
IMAGE_PLATFORM="$(awk '{print $2}' "$LOG_DIR/image-inspect.txt")"
[[ "$IMAGE_PLATFORM" == "linux/amd64" ]] || fail "exact image platform was $IMAGE_PLATFORM, expected linux/amd64"
case "$HOST_ARCH/$IMAGE_PLATFORM" in
  arm64/linux/amd64|aarch64/linux/amd64) EMULATION="yes" ;;
  x86_64/linux/amd64|amd64/linux/amd64) EMULATION="no" ;;
  *) EMULATION="unknown" ;;
esac

CONTAINER_ID="$(BOUNDED_TIMEOUT_MS=30000 bounded docker create --platform linux/amd64 --name "$NAME" \
  --env "CONTROL_TOKEN=$CONTROL_TOKEN" \
  --env STOW_ACCESS_KEY=stow \
  --env STOW_SECRET_KEY=stow-secret \
  -p 127.0.0.1::4001 \
  "$EVENTED_IMAGE")" || fail "could not create disposable container"
CREATED=1
if [[ "$MODE" == "recovery" ]]; then
  overlay_control_server
fi
printf '%s\n' "$CONTAINER_ID" >"$LOG_DIR/container-id.txt"
printf '%s\n' "$NAME" >"$LOG_DIR/container-name.txt"
PHASE="container-start"
BOUNDED_TIMEOUT_MS=30000 bounded docker start "$CONTAINER_ID" >/dev/null || fail "could not start disposable container"
HOST_PORT="$(bounded docker port "$CONTAINER_ID" 4001/tcp | awk -F: 'NR==1 {print $NF}')" \
  || fail "could not resolve disposable control port"
[[ "$HOST_PORT" =~ ^[0-9]+$ ]] || fail "container control port was not assigned"
BASE="http://127.0.0.1:${HOST_PORT}"
AUTH=(-H "authorization: Bearer ${CONTROL_TOKEN}")

PHASE="control-readiness"
ready=0
for _ in $(seq 1 120); do
  if curl --max-time 2 -fsS "$BASE/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
[[ "$ready" == 1 ]] || fail "control server readiness timed out"

# Capture installed binary facts/help before OpenCode startup. This still
# records the Stow artifact and Workspace CLI contract if /start later fails.
PHASE="stow-cli-inventory"
bounded docker exec "$CONTAINER_ID" sh -lc 'uname -m; sha256sum /usr/local/bin/stow-s3' >"$LOG_DIR/stow-binary.txt" 2>&1 \
  || fail "could not inspect installed Stow binary"
set +e
bounded docker exec "$CONTAINER_ID" stow-s3 --version >"$LOG_DIR/stow-version.txt" 2>&1
VERSION_CODE=$?
bounded docker exec "$CONTAINER_ID" stow-s3 --help >"$LOG_DIR/stow-help.txt" 2>&1
HELP_CODE=$?
bounded docker exec "$CONTAINER_ID" stow-s3 workspace --help >"$LOG_DIR/stow-workspace-help.txt" 2>&1
WORKSPACE_HELP_CODE=$?
set -e
for subcommand in prepare open adopt resume serve; do
  set +e
  bounded docker exec "$CONTAINER_ID" stow-s3 workspace "$subcommand" --help \
    >"$LOG_DIR/stow-workspace-${subcommand}-help.txt" 2>&1
  SUBCOMMAND_CODE=$?
  set -e
  printf '%s=%s\n' "$subcommand" "$SUBCOMMAND_CODE" >>"$LOG_DIR/workspace-subcommand-codes.txt"
done
set +e
bounded docker exec "$CONTAINER_ID" stow-s3 mcp --help >"$LOG_DIR/stow-mcp-help.txt" 2>&1
MCP_HELP_CODE=$?
set -e
for expected_flag in --object-dir --bucket --create-bucket; do
  rg -q -- "-{1,2}${expected_flag#--}" "$LOG_DIR/stow-mcp-help.txt" \
    || fail "pinned Stow MCP help does not document $expected_flag"
done

# B1 deliberately bypasses generic /configure, MCP bucket bootstrap and /start.
# The native Workspace service owns its own readiness endpoint/credentials, so
# port 9000 and the generic filesystem server remain unused in this mode.
if [[ "$MODE" == "workspace" || "$MODE" == "recovery-baseline" || "$MODE" == "recovery" ]]; then
  run_workspace_b1
  exit 0
fi

# Confirm the local control token gate and start the existing services without
# sending a prompt. The synthetic permission/model config is local only.
PHASE="control-configure"
HTTP_CODE="$(curl --max-time 5 -s -o /dev/null -w '%{http_code}' "$BASE/status")" \
  || fail "unauthenticated control status request timed out"
[[ "$HTTP_CODE" == 401 ]] || fail "unauthenticated control status returned $HTTP_CODE"
curl --max-time 10 -fsS "${AUTH[@]}" -X POST "$BASE/configure" \
  -H 'content-type: application/json' \
  -d '{"model":"opencode/deepseek-v4.1-flash","permissions":{"allow":["cat *"],"ask":[],"deny":[]}}' >/dev/null \
  || fail "control configure request failed or timed out"

# The generic filesystem S3 server requires an existing bucket. Bootstrap the
# synthetic one through the pinned Stow CLI's documented object-store option
# before the server opens the same filesystem directory; this is setup, not
# evidence of S3 CreateBucket request support.
PHASE="generic-bucket-bootstrap"
if ! BOUNDED_TIMEOUT_MS=15000 bounded docker exec -i --user 1001:1001 "$CONTAINER_ID" \
  stow-s3 mcp --object-dir /workspace/.stow --bucket stow-characterization --create-bucket \
  </dev/null >"$LOG_DIR/bucket-bootstrap.txt" 2>&1; then
  fail "pinned Stow CLI synthetic bucket bootstrap failed or timed out"
fi
printf '%s\n' 'created via pinned stow-s3 mcp --create-bucket; same /workspace/.stow store; before server start' \
  >"$LOG_DIR/bucket-bootstrap-method.txt"

PHASE="control-start"
curl --max-time 120 -fsS "${AUTH[@]}" -X POST "$BASE/start" -o "$LOG_DIR/start-response.json" \
  || fail "control start request failed or timed out; see container/start evidence"
curl --max-time 5 -fsS "${AUTH[@]}" "$BASE/status" >"$LOG_DIR/status.json" \
  || fail "control status request failed or timed out"
jq -e '.initialized and .running and .s3' "$LOG_DIR/status.json" >/dev/null \
  || fail "container services did not become ready"

# Run the actual Bun S3Client in-container, keeping port 9000 private to the
# container. It performs signed PUT/GET and tests direct-file/object separation.
PHASE="s3-characterization"
bounded docker cp "$ROOT/scripts/stow-s3-probe.ts" "$CONTAINER_ID:/tmp/stow-s3-probe.ts" \
  || fail "could not copy S3 probe into disposable container"
if ! BOUNDED_TIMEOUT_MS=15000 bounded docker exec "$CONTAINER_ID" bun /tmp/stow-s3-probe.ts characterize >"$LOG_DIR/s3-probe.json"; then
  fail "signed S3 characterization failed or timed out; see s3-probe.json"
fi
jq -e '.ok == true and .mode == "characterize"' "$LOG_DIR/s3-probe.json" >/dev/null \
  || fail "signed S3 characterization returned an invalid result"

# The native workspace archive should include the direct file while excluding
# the generic object store and its object-only key.
PHASE="workspace-checkpoint"
curl --max-time 20 -fsS "${AUTH[@]}" -D "$LOG_DIR/workspace-checkpoint.headers" \
  "$BASE/checkpoint?part=workspace" -o "$LOG_DIR/workspace.tar.gz" \
  || fail "workspace checkpoint request failed or timed out"
[[ -s "$LOG_DIR/workspace.tar.gz" ]] || fail "workspace checkpoint was empty"
tar -tzf "$LOG_DIR/workspace.tar.gz" >"$LOG_DIR/workspace-members.txt"
DIRECT_MEMBER="$(rg '(^|/)characterization-direct\.txt$' "$LOG_DIR/workspace-members.txt" | head -1 || true)"
[[ -n "$DIRECT_MEMBER" ]] || fail "workspace checkpoint omitted direct file"
tar -xOf "$LOG_DIR/workspace.tar.gz" "$DIRECT_MEMBER" >"$LOG_DIR/archive-direct.txt"
printf 'synthetic-direct-workspace-bytes-v1\n' >"$LOG_DIR/expected-direct.txt"
cmp -s "$LOG_DIR/expected-direct.txt" "$LOG_DIR/archive-direct.txt" \
  || fail "workspace checkpoint changed direct file bytes"
if rg '(^|/)\.stow(/|$)|characterization-object-only\.txt' "$LOG_DIR/workspace-members.txt" >/dev/null; then
  fail "workspace checkpoint unexpectedly contains generic object-store data"
fi

FINGERPRINT="$(awk 'tolower($1)=="x-workspace-fingerprint:" {gsub("\r", "", $2); print $2}' "$LOG_DIR/workspace-checkpoint.headers")"
[[ -n "$FINGERPRINT" ]] || fail "workspace checkpoint omitted fingerprint"
# Mutate the object-only store after recording the workspace fingerprint. This
# ordering tests whether that object mutation affects workspace checkpointing.
PHASE="s3-object-mutation"
if ! BOUNDED_TIMEOUT_MS=15000 bounded docker exec "$CONTAINER_ID" bun /tmp/stow-s3-probe.ts mutate >"$LOG_DIR/s3-mutation.json"; then
  fail "signed S3 mutation failed or timed out; see s3-mutation.json"
fi
jq -e '.ok == true and .mode == "mutate"' "$LOG_DIR/s3-mutation.json" >/dev/null \
  || fail "signed S3 mutation returned an invalid result"
HTTP_CODE="$(curl --max-time 10 -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" \
  "$BASE/checkpoint?part=workspace&since=${FINGERPRINT}")" \
  || fail "fingerprint checkpoint request timed out"
[[ "$HTTP_CODE" == 204 ]] || fail "object-only mutation checkpoint returned $HTTP_CODE instead of 204"

PHASE="evidence-summary"
STOW_SHA="$(awk 'length($1)==64 && $1 ~ /^[0-9a-f]+$/ {print $1; exit}' "$LOG_DIR/stow-binary.txt")"
IMAGE_ID="$(awk '{print $1}' "$LOG_DIR/image-inspect.txt")"
ARCHIVE_SHA="$(shasum -a 256 "$LOG_DIR/workspace.tar.gz" | awk '{print $1}')"
WORKSPACE_CONTRACT="help_reviewed_readiness_schema_unqualified"
SUBCOMMAND_CODES="$(awk 'BEGIN {printf "{"} {if (NR>1) printf ","; split($0,p,"="); printf "\"%s\":%s",p[1],p[2]} END {printf "}"}' "$LOG_DIR/workspace-subcommand-codes.txt")"
WORKSPACE_COMMANDS="{}"
for subcommand in prepare open adopt resume serve; do
  if rg -q "workspace <[^>]*\\b${subcommand}\\b" "$LOG_DIR/stow-workspace-help.txt"; then
    SUBCOMMAND_PRESENT=true
  else
    SUBCOMMAND_PRESENT=false
  fi
  WORKSPACE_COMMANDS="$(jq -c --arg name "$subcommand" --argjson present "$SUBCOMMAND_PRESENT" '. + {($name):$present}' <<<"$WORKSPACE_COMMANDS")"
done
if rg -q -- '-ready-fd' "$LOG_DIR/stow-workspace-serve-help.txt"; then
  READY_FD_HELP=true
else
  READY_FD_HELP=false
fi
jq -n \
  --arg status "characterized" \
  --arg image "$EVENTED_IMAGE" \
  --arg imageID "$IMAGE_ID" \
  --arg platform "$IMAGE_PLATFORM" \
  --arg hostArch "$HOST_ARCH" \
  --arg emulation "$EMULATION" \
  --arg stowSHA256 "$STOW_SHA" \
  --arg archiveSHA256 "$ARCHIVE_SHA" \
  --arg workspaceContract "$WORKSPACE_CONTRACT" \
  --arg containerID "$CONTAINER_ID" \
  --arg containerName "$NAME" \
  --argjson workspaceCommands "$WORKSPACE_COMMANDS" \
  --argjson readyFdInServeHelp "$READY_FD_HELP" \
  --argjson workspaceSubcommandExitCodes "$SUBCOMMAND_CODES" \
  --argjson objectMutationCheckpointStatus "$HTTP_CODE" \
  --argjson stowVersionExit "$VERSION_CODE" \
  --argjson stowHelpExit "$HELP_CODE" \
  --argjson workspaceHelpExit "$WORKSPACE_HELP_CODE" \
  --argjson mcpHelpExit "$MCP_HELP_CODE" \
  '{status:$status,image:$image,imageID:$imageID,platform:$platform,hostArch:$hostArch,emulation:$emulation,containerID:$containerID,containerName:$containerName,bucketBootstrap:"pinned_stow_s3_mcp_create_bucket",mcpHelpExit:$mcpHelpExit,stowBinarySHA256:$stowSHA256,stowReleaseArchiveSHA256:null,workspaceArchiveSHA256:$archiveSHA256,directFileInWorkspaceArchive:true,objectStoreExcludedFromWorkspaceArchive:true,objectMutationCheckpointStatus:$objectMutationCheckpointStatus,stowVersionExit:$stowVersionExit,stowHelpExit:$stowHelpExit,workspaceHelpExit:$workspaceHelpExit,workspaceSubcommandExitCodes:$workspaceSubcommandExitCodes,workspaceCommandsListed:$workspaceCommands,readyFdInServeHelp:$readyFdInServeHelp,workspaceContract:$workspaceContract}' \
  >"$LOG_DIR/result.json"

echo "characterization passed; evidence: $LOG_DIR"
cat "$LOG_DIR/result.json"
