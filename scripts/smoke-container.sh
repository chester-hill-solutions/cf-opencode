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
NAME="${NAME:-cf-opencode-smoke}"
CONTROL_PORT="${CONTROL_PORT:-4011}"
OPENCODE_PORT="${OPENCODE_PORT:-4010}"
STOW_PORT="${STOW_PORT:-9010}"
CONTROL_TOKEN="${CONTROL_TOKEN:-smoke-control-token}"
BASE="http://127.0.0.1:${CONTROL_PORT}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-opencode-smoke.XXXXXX")"
WS_ARCHIVE="${WORK}/workspace.tar.gz"
STATE_ARCHIVE="${WORK}/state.tar.gz"
ACCOUNT_ARCHIVE="${WORK}/account.tar.gz"
HEADERS="${WORK}/checkpoint.headers"

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

case "$RUNTIME" in
  docker)
    need docker
    build_image() { docker build -t "$IMAGE" "$ROOT"; }
    run_container() {
      docker run -d --name "$NAME" --env "CONTROL_TOKEN=${CONTROL_TOKEN}" \
        -p "${CONTROL_PORT}:4001" -p "${OPENCODE_PORT}:4000" -p "${STOW_PORT}:9000" \
        "$IMAGE" >/dev/null
    }
    exec_in() { docker exec "$NAME" "$@"; }
    cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
    ;;
  container)
    need container
    build_image() { container build -t "$IMAGE" "$ROOT"; }
    run_container() {
      container run -d --name "$NAME" --env "CONTROL_TOKEN=${CONTROL_TOKEN}" \
        -p "${CONTROL_PORT}:4001" -p "${OPENCODE_PORT}:4000" -p "${STOW_PORT}:9000" \
        "$IMAGE" >/dev/null
    }
    exec_in() { container exec "$NAME" "$@"; }
    cleanup() { container stop "$NAME" >/dev/null 2>&1 || true; }
    ;;
  *)
    fail "RUNTIME must be docker or container"
    ;;
esac

cleanup
trap 'cleanup; rm -rf "$WORK"' EXIT

echo "building ${IMAGE}…"
build_image

echo "starting ${NAME}…"
run_container

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

curl -fsS "${AUTH[@]}" -X POST "${BASE}/start" >/dev/null
status="$(curl -fsS "${AUTH[@]}" "${BASE}/status")"
echo "$status" | jq -e '.initialized and .running and .s3' >/dev/null || fail "status not ready: ${status}"
ok "OpenCode and local S3 running"

exec_in curl -fsS http://127.0.0.1:9000/_stow/health >/dev/null
ok "local S3 healthy inside the container"

curl -fsS "${AUTH[@]}" "${BASE}/opencode/api/info" | jq -e . >/dev/null
ok "OpenCode proxy reachable"

# Workspace marker + checkpoint.
exec_in sh -c 'printf "smoke\n" > /workspace/smoke.txt && chmod 0644 /workspace/smoke.txt'
curl -fsS "${AUTH[@]}" -D "$HEADERS" "${BASE}/checkpoint?part=workspace" -o "$WS_ARCHIVE"
[[ -s "$WS_ARCHIVE" ]] || fail "workspace checkpoint empty"
tar tzf "$WS_ARCHIVE" | grep -q 'smoke.txt' || fail "workspace archive does not contain smoke.txt"
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
ok "state checkpoint contains the marker"

# Workspace restore round-trip.
exec_in rm -f /workspace/smoke.txt
curl -fsS "${AUTH[@]}" -X POST --data-binary "@${WS_ARCHIVE}" "${BASE}/restore?part=workspace&final=1" >/dev/null
exec_in test -f /workspace/smoke.txt || fail "workspace restore lost the marker"
curl -fsS "${AUTH[@]}" -X POST "${BASE}/start" >/dev/null
curl -fsS "${AUTH[@]}" "${BASE}/status" | jq -e '.initialized and .running and .s3' >/dev/null \
  || fail "container did not restart after workspace restore"
ok "workspace restore round-trip"

# An archive with a symlink into harness state must be refused. GNU tar extracts
# the link itself successfully, so the workspace scan is the check that stops it.
exec_in sh -c 'rm -rf /tmp/evil-workspace && mkdir -p /tmp/evil-workspace && ln -s /var/lib/aboiteau/state /tmp/evil-workspace/escape && tar czf /tmp/evil-workspace.tar.gz -C /tmp/evil-workspace .'
code="$(exec_in sh -c "curl -s -o /dev/null -w '%{http_code}' -H 'authorization: Bearer ${CONTROL_TOKEN}' -X POST --data-binary @/tmp/evil-workspace.tar.gz 'http://127.0.0.1:4001/restore?part=workspace&final=1'")"
[[ "$code" == "500" ]] || fail "escaping workspace symlink returned ${code}, expected 500"
ok "escaping workspace symlink refused"

curl -fsS "${AUTH[@]}" -X POST --data-binary "@${WS_ARCHIVE}" "${BASE}/restore?part=workspace&final=1" >/dev/null
curl -fsS "${AUTH[@]}" -X POST "${BASE}/start" >/dev/null
curl -fsS "${AUTH[@]}" "${BASE}/status" | jq -e '.initialized and .running and .s3' >/dev/null \
  || fail "container did not recover after refusing the malicious archive"
ok "workspace recovered after refusal"

# State restore round-trip.
exec_in rm -f /var/lib/aboiteau/state/smoke-state.txt
curl -fsS "${AUTH[@]}" -X POST --data-binary "@${STATE_ARCHIVE}" "${BASE}/restore?part=state" >/dev/null
exec_in test -f /var/lib/aboiteau/state/smoke-state.txt || fail "state restore lost the marker"
curl -fsS "${AUTH[@]}" -X POST "${BASE}/start" >/dev/null
curl -fsS "${AUTH[@]}" "${BASE}/status" | jq -e '.initialized and .running and .s3' >/dev/null \
  || fail "container did not restart after state restore"
ok "state restore round-trip"

# Account-state snapshot used by onboarding.
curl -fsS "${AUTH[@]}" "${BASE}/state-checkpoint" -o "$ACCOUNT_ARCHIVE"
[[ -s "$ACCOUNT_ARCHIVE" ]] || fail "account state checkpoint empty"
curl -fsS "${AUTH[@]}" -X POST "${BASE}/start" >/dev/null
ok "account state checkpoint"

echo "container smoke test passed"
