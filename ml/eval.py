"""Saved-model inference and content-baseline comparison."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

if __package__:
    from .data import (artifact_input_paths, bridge_context, limit_value, load_snapshot,
                       positive_id, protect_output, resolve_reference, write_json)
    from .metrics import baseline_ids, collaborative_ranking
    from .model import load_model, score_user
else:
    from data import (artifact_input_paths, bridge_context, limit_value, load_snapshot,
                      positive_id, protect_output, resolve_reference, write_json)
    from metrics import baseline_ids, collaborative_ranking
    from model import load_model, score_user


def infer(model_path, user_id, limit=5, snapshot_path=None):
    if type(user_id) is not int or user_id <= 0 or user_id > 2**53 - 1:
        raise ValueError("User ID must be a positive safe integer")
    if type(limit) is not int or not 1 <= limit <= 20:
        raise ValueError("Limit must be between 1 and 20")
    artifact = None
    model_error = None
    try:
        artifact = load_model(model_path)
    except (ValueError, OSError) as error:
        if snapshot_path is None:
            raise ValueError("Model is unavailable; provide --snapshot for baseline fallback") from error
        model_error = "model_unavailable"
    if snapshot_path is None:
        snapshot_path = resolve_reference(model_path, artifact["snapshot"])
    snapshot = load_snapshot(snapshot_path)
    if not any(row["id"] == user_id for row in snapshot["dataset"]["users"]):
        raise ValueError("Unknown user")
    if artifact and artifact["snapshot"]["sha256"] != snapshot["_sha256"]:
        artifact = None
        model_error = "snapshot_mismatch"
    # Demo inference requires full-snapshot histories.
    if artifact and artifact["mode"] != "full_data":
        raise ValueError("Inference/demo requires a full-data artifact; use evaluate.py for held-out evaluation")
    exported = bridge_context(snapshot_path, user_id=user_id, limit=limit)
    if len(exported["users"]) != 1 or exported["users"][0]["user_id"] != user_id:
        raise ValueError("Bridge returned the wrong user")
    context = exported["users"][0]
    baseline = baseline_ids(context)
    if artifact:
        ranking, prediction = collaborative_ranking(artifact, user_id, context, score_user)
    else:
        ranking = baseline
        prediction = {"scores": {str(circle_id): 0.0 for circle_id in baseline},
                      "support": {str(circle_id): 0 for circle_id in baseline},
                      "history_count": 0, "fallback_reason": model_error}
    rows = {row["circle"]["id"]: row for row in context["diagnostics"]}
    base_ranks = {circle_id: rank for rank, circle_id in enumerate(baseline, 1)}

    def render(ids, collaborative):
        result = []
        for rank, circle_id in enumerate(ids[:limit], 1):
            row = rows[circle_id]
            circle = row["circle"]
            item = {"rank": rank, "circle_id": circle_id, "name": circle["name"],
                    "primary_topic": circle["topic"], "format": circle["format"],
                    "join_policy": circle["join_policy"],
                    "baseline_rank": base_ranks[circle_id],
                    "baseline_total_score": row["totalScore"],
                    "baseline_selection_score": row["selection"]["selectionScore"],
                    "cf_score": prediction["scores"][str(circle_id)],
                    "support_count": prediction["support"][str(circle_id)],
                    "inactivity_penalty": row["inactivityPenalty"],
                    "content_rationale" if collaborative else "explanation": row["explanation"]}
            if circle["description"] is not None:
                item["description"] = circle["description"]
            result.append(item)
        return result

    return {
        "metadata": {"user_id": user_id, "requested_limit": limit,
                     "count": min(limit, len(baseline)), "reference_date": snapshot["reference_date"],
                     "snapshot_sha256": snapshot["_sha256"],
                     "history_count": prediction["history_count"],
                     "fallback_reason": prediction["fallback_reason"],
                     "mode": "offline_diagnostic", "hybrid_enabled": False},
        "baseline": render(baseline, False),
        "collaborative_diagnostic": render(ranking, True),
        "note": "Collaborative ordering is diagnostic only; content rationales do not explain that ordering.",
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--user-id", required=True, type=positive_id)
    parser.add_argument("--limit", default=5, type=limit_value)
    parser.add_argument("--snapshot", type=Path, help="Current snapshot; also enables fallback when the model is unavailable")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.out:
            protect_output(args.out, [args.snapshot, *artifact_input_paths(args.model)])
        result = infer(args.model, args.user_id, args.limit, args.snapshot)
        if args.out:
            write_json(args.out, result)
        else:
            print(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False))
        return 0
    except (ValueError, OSError, TimeoutError) as error:
        print(f"Inference error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
