#!/usr/bin/env bash
#
# Record the A/B mapping BEFORE any image is looked at.
#
#   scripts/mapping.sh <best-label> <candidate-label> [seed] > scores/iter-N/mapping.json
#
# A mapping chosen after seeing scores is not a blind comparison. The seed makes the flip reproducible
# while still hiding the answer from the person writing the prompt.
set -euo pipefail

BEST="${1:?usage: mapping.sh <best-label> <candidate-label> [seed]}"
CANDIDATE="${2:?usage: mapping.sh <best-label> <candidate-label> [seed]}"
SEED="${3:-hillclimb}"

/usr/bin/python3 - "$BEST" "$CANDIDATE" "$SEED" <<'PY'
import json, random, sys
best, candidate, seed = sys.argv[1:4]
rng = random.Random(seed)
a, b = best, candidate
if rng.random() < 0.5:
    a, b = b, a
print(json.dumps({"A": a, "B": b}, indent=2))
PY
