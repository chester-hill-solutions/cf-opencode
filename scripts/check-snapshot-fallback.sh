#!/bin/zsh
# Exercise the stale-snapshot fallback: recycle to capture a snapshot, poison
# the stored handle, then prove the next turn drops it and restarts from the
# image (restoring the R2 archive). Assert on the start path, not the reply:
# the model may fail for reasons unrelated to the fallback.
set -u
TOKEN=$(grep '^API_TOKEN=' .dev.vars | cut -d= -f2)
BASE=${BASE:-https://cf-opencode.chester-hill-solutions.workers.dev}
KEY=${KEY:-snap-fb3}
AUTH=(-H "authorization: Bearer $TOKEN")
J=(-H "content-type: application/json")

state() { curl -s -m 15 "${AUTH[@]}" "$BASE/api/conversations/$KEY"; }
debug() { curl -s -m 15 "${AUTH[@]}" "$BASE/api/conversations/$KEY/debug"; }
stale_count() {
  curl -s -m 20 "${AUTH[@]}" "$BASE/api/metrics" | jq -r '.metrics["snapshot.stale"] // 0'
}
send() {
  curl -sS -m 240 -X POST "${AUTH[@]}" "${J[@]}" \
    -d "$(jq -nc --arg t "$1" --arg k "$2" '{text:$t,idempotencyKey:$k}')" \
    "$BASE/api/conversations/$KEY/messages"
}
settle() {
  for i in $(seq 1 90); do
    [ "$(state | jq -r .phase)" = idle ] && return 0
    sleep 4
  done
  return 1
}

echo "turn 1: $(send 'Reply with exactly: f1' 'fb3-1')"
settle || { echo "turn 1 stuck: $(state | jq -c '{phase}')"; exit 1; }
echo "state: $(state | jq -c '{lastReply,lastTurnError,containerStarts,checkpointSize}')"

echo "recycle: $(curl -s -m 240 -X POST "${AUTH[@]}" "$BASE/api/conversations/$KEY/recycle")"
echo "debug after recycle: $(debug | jq -c '{snapshot,startMode}')"
BEFORE=$(stale_count)

echo "invalidate: $(curl -s -m 30 -X POST "${AUTH[@]}" "$BASE/api/conversations/$KEY/debug/snapshot/invalidate")"
echo "turn 2: $(send 'Reply with exactly: f2' 'fb3-2')"
settle || { echo "turn 2 stuck: $(state | jq -c '{phase}')"; exit 1; }

AFTER=$(stale_count)
echo "state: $(state | jq -c '{lastReply,lastTurnError,containerStarts}')"
echo "debug: $(debug | jq -c '{snapshot,startMode}')"
echo "snapshot.stale: $BEFORE -> $AFTER"

MODE=$(debug | jq -r .startMode)
HAS_SNAPSHOT=$(debug | jq -r .snapshot)
if [ "$MODE" = image ] && [ "$HAS_SNAPSHOT" = false ] && [ "$AFTER" -gt "$BEFORE" ]; then
  echo "PASS: stale snapshot dropped, restarted from image"
  exit 0
fi
echo "FAIL: mode=$MODE snapshot=$HAS_SNAPSHOT stale=$BEFORE->$AFTER"
exit 1
