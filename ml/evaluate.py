"""Membership splits and offline ranking evaluation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

if __package__:
    from .data import (artifact_input_paths, bridge_context, load_snapshot, load_splits,
                       prepare_splits, protect_output, resolve_reference, write_json)
    from .metrics import (aggregate_quality, baseline_ids, collaborative_ranking,
                          quality_metrics, ranking_metrics)
    from .model import load_model, score_user
else:
    from data import (artifact_input_paths, bridge_context, load_snapshot, load_splits,
                      prepare_splits, protect_output, resolve_reference, write_json)
    from metrics import (aggregate_quality, baseline_ids, collaborative_ranking,
                         quality_metrics, ranking_metrics)
    from model import load_model, score_user


def evaluate_model(model_path, split):
    if split not in ("validation", "test"):
        raise ValueError("Split must be validation or test")
    artifact = load_model(model_path)
    if artifact["mode"] != "evaluation" or artifact["splits"] is None:
        raise ValueError("Full-data demo artifacts cannot be used for held-out evaluation")
    snapshot_path = resolve_reference(model_path, artifact["snapshot"])
    splits_path = resolve_reference(model_path, artifact["splits"])
    snapshot = load_snapshot(snapshot_path)
    splits = load_splits(splits_path, snapshot)
    exported = bridge_context(snapshot_path, splits_path=splits_path, limit=20)
    contexts = {row["user_id"]: row for row in exported["users"]}
    expected_users = {row["id"] for row in snapshot["dataset"]["users"]}
    if set(contexts) != expected_users:
        raise ValueError("Bridge context does not cover all snapshot users")
    labels = {row["user_id"]: row["circle_id"] for row in splits[split]}
    excluded = []
    eligible_labels = {}
    for user_id, target in sorted(labels.items()):
        if target not in baseline_ids(contexts[user_id]):
            excluded.append({"user_id": user_id, "circle_id": target,
                             "reason": "snapshot_eligibility"})
        else:
            eligible_labels[user_id] = target
    cohort = sorted(eligible_labels)
    catalog = {row["circle"]["id"] for uid in cohort for row in contexts[uid]["diagnostics"]}
    rankings = {}
    for user_id in cohort:
        context = contexts[user_id]
        baseline = baseline_ids(context)
        collaborative, prediction = collaborative_ranking(artifact, user_id, context, score_user)
        rankings[user_id] = {
            "baseline": (baseline, None),
            "popularity": (sorted(baseline, key=lambda cid: (-artifact["popularity"].get(str(cid), 0), cid)), None),
            "collaborative": (collaborative, prediction["fallback_reason"]),
        }
    results = {}
    for method in ("baseline", "popularity", "collaborative"):
        results[method] = {}
        for k in (5, 10):
            rows = []
            for user_id in cohort:
                ranking, fallback = rankings[user_id][method]
                rows.append({"user_id": user_id, "ranking": ranking[:k],
                             "fallback_reason": fallback,
                             "relevance": ranking_metrics(ranking, eligible_labels[user_id], k),
                             "quality": quality_metrics(contexts[user_id], ranking, k)})
            results[method][str(k)] = {
                "recall": sum(row["relevance"]["recall"] for row in rows) / len(rows) if rows else None,
                "ndcg": sum(row["relevance"]["ndcg"] for row in rows) / len(rows) if rows else None,
                **aggregate_quality(rows, catalog),
            }
    return {
        "schema_version": 1, "status": "evaluated", "split": split,
        "experiment": "synthetic_snapshot_membership_reconstruction",
        "snapshot_sha256": snapshot["_sha256"], "reference_date": snapshot["reference_date"],
        "seed": splits["seed"], "model_config": artifact["config"],
        "cohort": {"snapshot_users": len(expected_users), "held_out_users": len(labels),
                   "evaluated_users": len(cohort), "insufficient_history_users": len(splits["skipped_users"]),
                   "excluded_targets": excluded, "skipped_users": splits["skipped_users"]},
        "metrics": results,
        "per_user": [{"user_id": uid, "target_circle_id": eligible_labels[uid],
                      "rankings": {method: rows[0][:10] for method, rows in rankings[uid].items()},
                      "collaborative_fallback_reason": rankings[uid]["collaborative"][1]} for uid in cohort],
        "metric_definitions": {
            "recall_ndcg": "Mean over users with one eligible held-out target; unobserved memberships are unlabeled.",
            "catalog_coverage": "Distinct recommended Circles / union of eligible candidates for evaluated users.",
            "near_duplicate_pair_rate": "Near-duplicate pairs from TypeScript / all unordered pairs within returned lists.",
            "interest_coverage": "Mean fraction of matchable supported topics covered, over users with at least one such topic, separately by source.",
            "dormant_exposure_rate": "Recommendations carrying the existing inactivity penalty / all returned recommendations.",
            "fallback_rate": "Users receiving baseline ordering because collaborative support is unavailable / evaluated users.",
        },
        "limitations": ["Synthetic reconstruction is not future-join accuracy or evidence of production improvement.",
                        "Current metadata, member counts, access, and activity aggregates remain snapshot context.",
                        "Both validation and test memberships and their authored posts are removed from fitting and evaluation contexts.",
                        "Hybrid remains disabled until a separate evidence review; no settings were tuned by this command."],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-splits", action="store_true")
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--seed", type=int, default=20260921)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--split", choices=("validation", "test"))
    args = parser.parse_args(argv)
    if args.prepare_splits:
        if args.snapshot is None or args.out is None or args.model is not None or args.split is not None:
            parser.error("--prepare-splits requires --snapshot and --out, without --model or --split")
    elif args.model is None or args.split is None or args.snapshot is not None:
        parser.error("Evaluation requires --model and --split, without --snapshot")
    try:
        if args.out:
            inputs = [args.snapshot] if args.prepare_splits else artifact_input_paths(args.model)
            protect_output(args.out, inputs)
        if args.prepare_splits:
            result = prepare_splits(load_snapshot(args.snapshot), args.seed)
        else:
            result = evaluate_model(args.model, args.split)
        if args.out:
            write_json(args.out, result)
        else:
            print(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False))
        return 0
    except (ValueError, OSError, TimeoutError) as error:
        print(f"Evaluation error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
