#!/usr/bin/env bash
#
# Every hard gate for one iteration, in one command.
#
#   HILLCLIMB_TREES="src" \
#   HILLCLIMB_GATE_CMD="./scripts/check.sh" \
#   HILLCLIMB_LOG="runs/iter-3-after/app.log" \
#   HILLCLIMB_CONSOLE_PATTERNS="hillclimb/console-patterns.txt" \
#     scripts/gate.sh runs/iter-3-after [--baseline]
#
# Order matters: scope first (a diff over the file budget is out of the loop and never gets built), then
# the repo's own gates, then the console gate on the capture run's log. Results go to
# `<run-dir>/gate.json`, which the ledger quotes verbatim.
#
# Environment:
#   HILLCLIMB_TREES             the surface trees (default ".")
#   HILLCLIMB_MAX_FILES         files allowed per iteration (default 3)
#   HILLCLIMB_GATE_CMD          build/typecheck/test command (omit to skip)
#   HILLCLIMB_LOG               log file from the capture run (omit to skip console gate)
#   HILLCLIMB_CONSOLE_PATTERNS  file of grep -E patterns that must NOT appear in the log
set -uo pipefail

RUN="${1:?usage: gate.sh <run-dir> [--baseline]}"
MODE="${2:-}"
[ -d "$RUN" ] || { echo "no capture run at $RUN — capture before gating" >&2; exit 2; }

SNAP="${HILLCLIMB_SNAPSHOT:-${TMPDIR:-/tmp}/hillclimb-baseline}"
export HILLCLIMB_SNAPSHOT="$SNAP"
MAX_FILES="${HILLCLIMB_MAX_FILES:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
failures=()

echo "== scope =="
FILES="$("$HERE/snapshot.sh" changed || true)"
if [ "$MODE" = "--baseline" ]; then
    echo "   baseline: scope gate skipped"
elif [ -z "$FILES" ]; then
    echo "   no changed files — an iteration with no diff is not an iteration" >&2
    failures+=("scope: empty diff")
else
    printf '   %s\n' $FILES
    COUNT=$(printf '%s\n' "$FILES" | wc -l | tr -d ' ')
    if [ "$COUNT" -gt "$MAX_FILES" ]; then
        failures+=("scope: $COUNT files changed, max is $MAX_FILES")
    fi
fi

CHECK="skipped"
if [ -n "${HILLCLIMB_GATE_CMD:-}" ]; then
    echo "== repo gates ($HILLCLIMB_GATE_CMD) =="
    if eval "$HILLCLIMB_GATE_CMD" >"$RUN/gate-check.log" 2>&1; then
        echo "   pass"; CHECK="pass"
    else
        echo "   FAIL — tail:" >&2; tail -25 "$RUN/gate-check.log" >&2
        failures+=("gate command failed"); CHECK="fail"
    fi
fi

CONSOLE="skipped"
if [ -n "${HILLCLIMB_LOG:-}" ] && [ -f "${HILLCLIMB_LOG:-}" ]; then
    echo "== console =="
    if [ -n "${HILLCLIMB_CONSOLE_PATTERNS:-}" ] && [ -f "$HILLCLIMB_CONSOLE_PATTERNS" ]; then
        if grep -nE -f "$HILLCLIMB_CONSOLE_PATTERNS" "$HILLCLIMB_LOG" >"$RUN/console-gate.log" 2>&1; then
            echo "   FAIL — forbidden lines:" >&2; tail -10 "$RUN/console-gate.log" >&2
            failures+=("console gate"); CONSOLE="fail"
        else
            echo "   pass"; CONSOLE="pass"
        fi
    else
        echo "   no patterns file; skipped"; CONSOLE="skipped"
    fi
fi

/usr/bin/python3 - "$RUN" "$MODE" "$CHECK" "$CONSOLE" "${failures[@]-}" <<'PY'
import json, sys, time
run, mode, check, console, *failures = sys.argv[1:]
failures = [f for f in failures if f]
result = {
    "mode": "baseline" if mode == "--baseline" else "iteration",
    "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "ok": not failures,
    "scope": "skipped" if mode == "--baseline" else ("fail" if any(f.startswith("scope:") for f in failures) else "pass"),
    "repoGate": check,
    "console": console,
    "failures": failures,
}
json.dump(result, open(run.rstrip("/") + "/gate.json", "w"), indent=2, sort_keys=True)
print("\n" + ("GATES PASSED" if result["ok"] else "GATES FAILED: " + "; ".join(failures)))
PY
