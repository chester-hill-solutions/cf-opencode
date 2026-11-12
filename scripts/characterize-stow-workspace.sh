#!/usr/bin/env bash
set -euo pipefail
umask 077

# Disposable R0-15A characterization of the currently pinned generic Stow
# filesystem backend. It never builds an image, mounts host data, or calls a
# model/provider. All S3 traffic stays inside the throwaway container.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR="$(mktemp -d "/tmp/stow-workspace-characterization-${STAMP}.XXXXXX")"
chmod 700 "$LOG_DIR"
NAME="stow-char-${STAMP}-$$"
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
trap cleanup EXIT INT TERM

for command in docker curl jq tar rg awk openssl bun node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing host command: $command"
done

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
