#!/usr/bin/env bash
#
# The loop's memory of "before".
#
#   HILLCLIMB_TREES="src Package.swift" scripts/snapshot.sh init
#   HILLCLIMB_TREES="src Package.swift" scripts/snapshot.sh changed
#   HILLCLIMB_TREES="src Package.swift" scripts/snapshot.sh advance
#   HILLCLIMB_TREES="src Package.swift" scripts/snapshot.sh revert
#   HILLCLIMB_TREES="src Package.swift" scripts/snapshot.sh diff
#
# **Why a snapshot and not `git checkout`.** The worktree is often deliberately not clean: the person's
# in-progress work is uncommitted, including files inside this surface. `git checkout -- <file>` would
# discard *their* work, not the loop's. Reverting restores the exact bytes the loop started from and
# touches nothing else, so the ledger's "final diff" is the snapshot diff rather than `git diff`.
#
# Environment:
#   HILLCLIMB_TREES     space-separated files/dirs that make up the surface (default: current dir)
#   HILLCLIMB_SNAPSHOT  snapshot location (default: <tmpdir>/hillclimb-baseline)
set -euo pipefail

SNAP="${HILLCLIMB_SNAPSHOT:-${TMPDIR:-/tmp}/hillclimb-baseline}"
# shellcheck disable=SC2206
TREES=(${HILLCLIMB_TREES:-.})

snapshot_into() {
    for tree in "${TREES[@]}"; do
        if [ -d "$tree" ]; then
            /usr/bin/rsync -a --exclude '.git' "$tree" "$SNAP/"
        elif [ -f "$tree" ]; then
            /usr/bin/rsync -a "$tree" "$SNAP/"
        else
            echo "warning: $tree does not exist; skipping" >&2
        fi
    done
}

changed_paths() {
    for tree in "${TREES[@]}"; do
        if [ -d "$tree" ]; then
            { /usr/bin/diff -rq "$SNAP/$(basename "$tree")" "$tree" 2>/dev/null || true; } \
                | sed -n 's/^Files .* and \(.*\) differ$/\1/p; s/^Only in \(.*\): \(.*\)$/\1\/\2/p'
        elif [ -f "$tree" ]; then
            cmp -s "$SNAP/$(basename "$tree")" "$tree" || echo "$tree"
        fi
    done | sort -u
}

case "${1:-}" in
    init)
        if [ -e "$SNAP" ]; then
            echo "snapshot already exists: $SNAP (delete it deliberately to re-baseline)" >&2
            exit 1
        fi
        mkdir -p "$SNAP"
        snapshot_into
        echo "snapshot written to $SNAP"
        ;;
    advance)
        # After a **keep**. If the snapshot does not move, the next revert undoes two changes.
        rm -rf "$SNAP"
        mkdir -p "$SNAP"
        snapshot_into
        echo "snapshot advanced to the current tree"
        ;;
    changed)
        changed_paths
        ;;
    revert)
        changed="$(changed_paths)"
        if [ -z "$changed" ]; then
            echo "nothing to revert"
            exit 0
        fi
        while IFS= read -r path; do
            [ -n "$path" ] || continue
            rel="${path#"$SNAP"/}"
            if [ -e "$SNAP/$rel" ]; then
                mkdir -p "$(dirname "$rel")"
                # cp, not rsync: rsync's quick check (size + whole-second mtime) can skip a real change
                # when the iteration rewrote a file of the same size within the same second.
                /bin/cp -p "$SNAP/$rel" "$rel"
                echo "restored $rel"
            else
                rm -f "$rel"
                echo "removed $rel (added by the iteration)"
            fi
        done <<< "$changed"
        ;;
    diff)
        for tree in "${TREES[@]}"; do
            if [ -d "$tree" ]; then
                /usr/bin/diff -ru "$SNAP/$(basename "$tree")" "$tree" || true
            elif [ -f "$tree" ]; then
                /usr/bin/diff -u "$SNAP/$(basename "$tree")" "$tree" || true
            fi
        done
        ;;
    *)
        echo "usage: HILLCLIMB_TREES='...' snapshot.sh init|changed|advance|revert|diff" >&2
        exit 2
        ;;
esac
