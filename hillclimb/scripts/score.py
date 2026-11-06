#!/usr/bin/env python3
"""Turn blind critic reports into one mechanical keep/revert decision.

Paired (an iteration):

    score.py scores/iter-3 --best best --candidate iter-3-after

Single-set (the baseline pass):

    score.py scores/baseline --single

`<scores_dir>` holds one `<viewport>.json` per critic plus a `mapping.json` the orchestrator wrote
**before** seeing any score:

    {"A": "best", "B": "iter-3-after"}

Paired critic report shape:

    {"viewport": "900x650",
     "criteria": {"task_clarity": {"A": 7, "B": 5, "why": "..."}, ...},
     "better": "A", "why": "...", "hardGateEvidence": []}

Single-set report shape:

    {"criteria": {"task_clarity": {"score": 7, "note": "..."}, ...}}

Keeping the arithmetic here rather than in prose is deliberate: the keep/revert decision is mechanical,
and a decision made by hand after reading a persuasive critique is not a hill-climb step.

Exit codes: 0 keep (or single-set report), 1 revert.
"""

import argparse
import json
import os
import sys

# The default ruler. Override with --weights (a JSON object of criterion -> weight summing to 100) when
# the run's frozen rubric weights differently.
DEFAULT_WEIGHTS = {
    "task_clarity": 20,
    "visual_hierarchy": 15,
    "density_rhythm": 15,
    "state_coverage": 15,
    "accessibility": 15,
    "consistency": 10,
    "polish": 10,
}
THRESHOLD = 2.0
RESERVED = {"mapping.json", "decision.json", "weights.json", "gate.json"}


def load_weights(path):
    if not path:
        weights = dict(DEFAULT_WEIGHTS)
    else:
        raw = json.load(open(path))
        if isinstance(raw, dict) and "criteria" in raw:
            raw = raw["criteria"]
        weights = {
            k: float(v["weight"] if isinstance(v, dict) else v) for k, v in raw.items()
        }
    total = sum(weights.values())
    if abs(total - 100.0) > 1e-6:
        raise SystemExit(f"weights must sum to 100, got {total}")
    return weights


def weighted(scores, weights, where):
    missing = sorted(set(weights) - set(scores))
    if missing:
        raise SystemExit(f"{where}: critic report missing criteria {missing}")
    # A weight is a percentage of 100 and a criterion score is 0-10, so divide the weighted sum by 10.
    return sum(weights[k] * float(scores[k]) for k in weights) / 10.0


def mean(xs):
    return sum(xs) / len(xs)


def reports_in(directory):
    reports = []
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json") or name in RESERVED:
            continue
        report = json.load(open(os.path.join(directory, name)))
        if not isinstance(report, dict) or "criteria" not in report:
            continue
        report.setdefault("viewport", os.path.splitext(name)[0])
        reports.append(report)
    if not reports:
        raise SystemExit(f"no critic reports found in {directory}")
    return reports


def single(directory, weights):
    reports = reports_in(directory)
    per_viewport = {}
    criterion_totals = {k: [] for k in weights}
    for report in reports:
        values = {}
        for k, v in report["criteria"].items():
            values[k] = v.get("score") if isinstance(v, dict) else v
        vp = report["viewport"]
        per_viewport[vp] = round(weighted(values, weights, vp), 2)
        for k in weights:
            criterion_totals[k].append(float(values[k]))

    run_score = mean(per_viewport.values())
    print("single-set score (absolute reference; not comparable across critic draws)")
    for vp, score in per_viewport.items():
        print(f"  {vp:<14} {score:6.2f}")
    print(f"\nrun score      {run_score:6.2f} / 100")

    criterion_means = {k: mean(criterion_totals[k]) for k in weights}
    print("\nper criterion (0-10, mean across viewports) — weighted headroom next")
    for k, w in sorted(weights.items(), key=lambda kv: -kv[1] * (10 - criterion_means[kv[0]])):
        s = criterion_means[k]
        print(f"  {k:<20} w={w:<3} score {s:5.2f}   headroom {w * (10 - s):6.1f}")

    json.dump(
        {
            "mode": "single",
            "runScore": round(run_score, 2),
            "viewports": per_viewport,
            "criteria": {k: round(v, 2) for k, v in criterion_means.items()},
            "headroom": {
                k: round(weights[k] * (10 - criterion_means[k]), 1) for k in weights
            },
        },
        open(os.path.join(directory, "decision.json"), "w"),
        indent=2,
        sort_keys=True,
    )
    return 0


def paired(directory, best, candidate, weights, threshold, allow_regression):
    mapping = json.load(open(os.path.join(directory, "mapping.json")))
    if sorted(mapping.values()) != sorted([best, candidate]):
        raise SystemExit(f"mapping {mapping} does not match {best} / {candidate}")

    def letter_for(label):
        for letter, value in mapping.items():
            if value == label:
                return letter
        raise SystemExit(f"label {label} missing from mapping")

    best_letter, candidate_letter = letter_for(best), letter_for(candidate)
    reports = reports_in(directory)

    per_viewport = {}
    criterion_totals = {k: {best_letter: [], candidate_letter: []} for k in weights}
    for report in reports:
        vp = report["viewport"]
        best_scores = {k: v[best_letter] for k, v in report["criteria"].items()}
        candidate_scores = {k: v[candidate_letter] for k, v in report["criteria"].items()}
        b = weighted(best_scores, weights, f"{vp} {best_letter}")
        c = weighted(candidate_scores, weights, f"{vp} {candidate_letter}")
        per_viewport[vp] = {
            "best": round(b, 2),
            "candidate": round(c, 2),
            "delta": round(c - b, 2),
        }
        for k in weights:
            criterion_totals[k][best_letter].append(float(best_scores[k]))
            criterion_totals[k][candidate_letter].append(float(candidate_scores[k]))

    best_score = mean([v["best"] for v in per_viewport.values()])
    candidate_score = mean([v["candidate"] for v in per_viewport.values()])
    delta = candidate_score - best_score
    regressions = {vp: v["delta"] for vp, v in per_viewport.items() if v["delta"] < 0}

    reason = "delta"
    verdict = "keep" if delta >= threshold else "revert"
    if verdict == "keep" and regressions and not allow_regression:
        verdict = "revert"
        reason = "viewport regression"

    print(f"viewport scores ({len(reports)} critic reports)")
    for vp, v in per_viewport.items():
        flag = "  <-- REGRESSION" if v["delta"] < 0 else ""
        print(f"  {vp:<14} {v['best']:6.2f} → {v['candidate']:6.2f}   Δ {v['delta']:+6.2f}{flag}")
    print(f"\nrun score   {best_score:.2f} → {candidate_score:.2f}   Δ {delta:+.2f}")
    suffix = f" ({reason})" if reason != "delta" else ""
    print(f"threshold   +{threshold:.1f}   verdict: {verdict.upper()}{suffix}")

    print("\nper criterion (0-10, mean across viewports)")
    for k, w in weights.items():
        b = mean(criterion_totals[k][best_letter])
        c = mean(criterion_totals[k][candidate_letter])
        print(f"  {k:<20} w={w:<3} {b:5.2f} → {c:5.2f}   Δ {c - b:+.2f}")

    for report in reports:
        why = (report.get("why") or "").strip().replace("\n", " ")
        print(f"\n[{report.get('viewport', '?')}] critic says {report.get('better')}: {why}")

    json.dump(
        {
            "mode": "paired",
            "best": best,
            "candidate": candidate,
            "bestScore": round(best_score, 2),
            "candidateScore": round(candidate_score, 2),
            "delta": round(delta, 2),
            "threshold": threshold,
            "verdict": verdict,
            "reason": reason,
            "mapping": mapping,
            "viewports": per_viewport,
            "regressions": regressions,
            "critics": {
                r.get("viewport", "?"): {
                    "better": r.get("better"),
                    "why": r.get("why"),
                    "hardGateEvidence": r.get("hardGateEvidence", []),
                }
                for r in reports
            },
        },
        open(os.path.join(directory, "decision.json"), "w"),
        indent=2,
        sort_keys=True,
    )
    return 0 if verdict == "keep" else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("scores_dir")
    parser.add_argument("--best", help="label of the current best run")
    parser.add_argument("--candidate", help="label of the candidate run")
    parser.add_argument("--weights", help="JSON criterion -> weight (sums to 100)")
    parser.add_argument("--threshold", type=float, default=THRESHOLD)
    parser.add_argument(
        "--allow-viewport-regression",
        action="store_true",
        help="accept a gain at one viewport that costs another (not recommended)",
    )
    parser.add_argument("--single", action="store_true", help="score a single-set (baseline) pass")
    args = parser.parse_args()

    weights = load_weights(args.weights)
    if args.single:
        if args.best or args.candidate:
            raise SystemExit("--single takes no --best/--candidate")
        return single(args.scores_dir, weights)
    if not args.best or not args.candidate:
        raise SystemExit("a paired decision needs --best and --candidate (or use --single)")
    return paired(
        args.scores_dir,
        args.best,
        args.candidate,
        weights,
        args.threshold,
        args.allow_viewport_regression,
    )


if __name__ == "__main__":
    sys.exit(main())
