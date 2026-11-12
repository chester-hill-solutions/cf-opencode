#!/usr/bin/env bash
set -euo pipefail

# Cross-image archive/restore proof. Images must already be built and pinned by
# the caller; this script never rebuilds or retags them.
#   LEGACY_IMAGE=cf-opencode:smoke EVENTED_IMAGE=cf-opencode:evented-smoke \
#     scripts/smoke-evented-runtime.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEGACY_IMAGE="${LEGACY_IMAGE:?set LEGACY_IMAGE to the cached stock-CLI image}"
EVENTED_IMAGE="${EVENTED_IMAGE:?set EVENTED_IMAGE to the new evented image}"
RUNTIME="${RUNTIME:-docker}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-opencode-event-smoke.XXXXXX")"
chmod 700 "$WORK"
LEGACY_NAME="cf-opencode-event-smoke-legacy-$$"
EVENTED_NAME="cf-opencode-event-smoke-evented-$$"
CONTROL_TOKEN="$(openssl rand -hex 32)"
OPENCODE_PASSWORD="$(openssl rand -hex 32)"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing host command: $1"; }
need curl
need docker
need jq

LEGACY_ID="$(docker image inspect "$LEGACY_IMAGE" --format '{{.Id}}')" || fail "legacy image is unavailable"
EVENTED_ID="$(docker image inspect "$EVENTED_IMAGE" --format '{{.Id}}')" || fail "evented image is unavailable"
[[ "$LEGACY_ID" != "$EVENTED_ID" ]] || fail "legacy and evented image IDs must differ"

cleanup() {
  docker rm -f "$LEGACY_NAME" "$EVENTED_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

run_container() {
  local name="$1" image="$2"
  docker run -d --name "$name" \
    -e "CONTROL_TOKEN=$CONTROL_TOKEN" -e "OPENCODE_PASSWORD=$OPENCODE_PASSWORD" \
    -e OPENCODE_DISABLE_MODELS_FETCH=true \
    -p 127.0.0.1::4001 "$image" >/dev/null
  local control_port
  control_port="$(docker port "$name" 4001/tcp | sed 's/.*://')"
  printf '%s' "$control_port"
}

wait_health() {
  local base="$1"
  for _ in $(seq 1 300); do
    curl -fsS "$base/health" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}

legacy_control_port="$(run_container "$LEGACY_NAME" "$LEGACY_IMAGE")"
legacy_control="http://127.0.0.1:$legacy_control_port"
wait_health "$legacy_control" || fail "legacy fixture did not become healthy"
curl -fsS -H "authorization: Bearer $CONTROL_TOKEN" -X POST "$legacy_control/configure" \
  -H 'content-type: application/json' -d '{}' >/dev/null
curl -fsS -H "authorization: Bearer $CONTROL_TOKEN" -X POST "$legacy_control/start" >/dev/null
CONTROL_BASE_URL="$legacy_control" CONTROL_TOKEN="$CONTROL_TOKEN" PROBE_ROOT="$WORK" \
  bun "$ROOT/runtime/opencode/archive-probe.ts" create
curl -fsS -H "authorization: Bearer $CONTROL_TOKEN" \
  "$legacy_control/checkpoint?part=state" -o "$WORK/legacy-state.tar.gz"
[[ -s "$WORK/legacy-state.tar.gz" ]] || fail "legacy state archive is empty"
ok "pinned legacy image $LEGACY_ID archived its default database, session and synthetic credential"

evented_control_port="$(run_container "$EVENTED_NAME" "$EVENTED_IMAGE")"
evented_control="http://127.0.0.1:$evented_control_port"
wait_health "$evented_control" || fail "evented image did not become healthy"
curl -fsS -H "authorization: Bearer $CONTROL_TOKEN" -X POST --data-binary "@$WORK/legacy-state.tar.gz" \
  "$evented_control/restore?part=state" >/dev/null
curl -fsS -H "authorization: Bearer $CONTROL_TOKEN" -X POST "$evented_control/configure" \
  -H 'content-type: application/json' -d '{}' >/dev/null
start_json="$(curl -fsS -H "authorization: Bearer $CONTROL_TOKEN" -X POST "$evented_control/start")"
echo "$start_json" | jq -e '.eventPersistence == true' >/dev/null || fail "evented /start did not prove persistent events"
docker exec "$EVENTED_NAME" test -f /var/lib/aboiteau/state/data/opencode/opencode.db \
  || fail "evented image did not use the stock default database path"
CONTROL_BASE_URL="$evented_control" CONTROL_TOKEN="$CONTROL_TOKEN" PROBE_ROOT="$WORK" \
  bun "$ROOT/runtime/opencode/archive-probe.ts" verify-fixture
ok "cross-image restore found the legacy session and synthetic credential"

CONTROL_BASE_URL="$evented_control" CONTROL_TOKEN="$CONTROL_TOKEN" PROBE_ROOT="$WORK" \
  bun "$ROOT/runtime/opencode/archive-probe.ts" create-events
curl -fsS -H "authorization: Bearer $CONTROL_TOKEN" \
  "$evented_control/checkpoint?part=state" -o "$WORK/evented-state.tar.gz"
[[ -s "$WORK/evented-state.tar.gz" ]] || fail "evented state archive is empty"
curl -fsS -H "authorization: Bearer $CONTROL_TOKEN" -X POST --data-binary "@$WORK/evented-state.tar.gz" \
  "$evented_control/restore?part=state" >/dev/null
start_json="$(curl -fsS -H "authorization: Bearer $CONTROL_TOKEN" -X POST "$evented_control/start")"
echo "$start_json" | jq -e '.eventPersistence == true' >/dev/null || fail "restarted evented /start lost its persistence proof"
CONTROL_BASE_URL="$evented_control" CONTROL_TOKEN="$CONTROL_TOKEN" PROBE_ROOT="$WORK" \
  bun "$ROOT/runtime/opencode/archive-probe.ts" verify-fixture
CONTROL_BASE_URL="$evented_control" CONTROL_TOKEN="$CONTROL_TOKEN" PROBE_ROOT="$WORK" \
  bun "$ROOT/runtime/opencode/archive-probe.ts" verify-events
ok "event rows survived checkpoint, restore and restart"
