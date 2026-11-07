#!/bin/zsh
# Exercise the stale-snapshot fallback: recycle to capture a snapshot, poison
# the stored handle, then prove the next turn drops it and restores from R2.
set -u
TOKEN=$(grep '^API_TOKEN=' .dev.vars | cut -d= -f2)
BASE=${BASE:-https://cf-opencode.chester-hill-solutions.workers.dev}
KEY=${KEY:-snap-fb2}
AUTH=(-H "authorization: Bearer $TOKEN")
J=(-H "content-type: application/json")

state() { curl -s -m 15 "${AUTH[@]}" "$BASE/api/conversations/$KEY" }
debug() { curl -s -m 15 "${AUTH[@]}" "$BASE/api/conversations/$KEY/debug"; }
send() { curl -sS -m 240 -X POST "${AUTH[@]}" "${J[@]}" -d "$(jq -nc --arg t "$1" --arg k "$2" '{text:$t,idempotencyKey:$k}')" "$BASE/api/conversations/$KEY/messages"; }
wait_reply() {
  for i in $(seq 1 90); do
    S=$(state)
    if [ "$(echo "$S" | jq -r .phase)" = idle ] && [ "$(echo "$S" | jq -r '.lastReply // empty')" = "$1" ]; then
      return 0
    fi
    sleep 4
  done
  return 1
}

echo "turn 1: $(send 'Reply with exactly: f1' 'fb2-1')"
wait_reply f1 || { echo "turn 1 did not settle: $(state | jq -c '{phase,lastReply,lastTurnError}')"; exit 1; }
echo "state: $(state | jq -c '{lastReply,checkpointSize}')"

echo "recycle: $(curl -s -m 240 -X POST "${AUTH[@]}" "$BASE/api/conversations/$KEY/recycle")"
echo "debug after recycle: $(debug | jq -c '{snapshot,startMode}')"

echo "invalidate: $(curl -s -m 30 -X POST "${AUTH[@]}" "$BASE/api/conversations/$KEY/debug/snapshot/invalidate")"

echo "turn 2: $(send 'Reply with exactly: f2' 'fb2-2')"
wait_reply f2 || { echo "turn 2 did not settle: $(state | jq -c '{phase,lastReply,lastTurnError}')"; exit 1; }
echo "state: $(state | jq -c '{lastReply,containerStarts}')"
echo "debug: $(debug | jq -c '{startMode,snapshot}')"
echo "metrics: $(curl -s -m 20 "${AUTH[@]}" "$BASE/api/metrics" | jq -c '.metrics | {stale: .["snapshot.stale"], failed: .["snapshot.failed"], restored: .["snapshot.restored"]}')"
