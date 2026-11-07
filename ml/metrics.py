"""Ranking diagnostics; product rules and similarity come from TypeScript."""

from __future__ import annotations

from itertools import combinations
import math


def ranking_metrics(ranking, target, k):
    selected = ranking[:k]
    if target not in selected:
        return {"recall": 0.0, "ndcg": 0.0}
    position = selected.index(target)
    return {"recall": 1.0, "ndcg": 1 / math.log2(position + 2)}


def baseline_ids(context):
    return [row["circle"]["id"] for row in context["diagnostics"]]


def _topics(rows, source):
    topics = set()
    for row in rows:
        if row["selection"]["unsupportedContextPurpose"]:
            continue
        for match in row["matchingEvidence"]["matches"]:
            if (match["source"] == source and match["strength"] > 0
                    and (source != "bio" or match["confidence"] >= row["selection"]["config"]["strongBioConfidence"])):
                topics.add(match["topic"])
    return topics


def quality_metrics(context, ranking, k):
    candidates = {row["circle"]["id"]: row for row in context["diagnostics"]}
    selected_ids = ranking[:k]
    selected = [candidates[circle_id] for circle_id in selected_ids if circle_id in candidates]
    duplicates = {tuple(sorted(pair)) for pair in context["near_duplicate_pairs"]}
    selected_pairs = list(combinations(selected_ids, 2))
    result = {
        "selected_count": len(selected_ids),
        "eligibility_violations": sum(circle_id not in candidates for circle_id in selected_ids),
        "repeated_circle_ids": len(selected_ids) - len(set(selected_ids)),
        "near_duplicate_pairs": sum(tuple(sorted(pair)) in duplicates for pair in selected_pairs),
        "selected_pairs": len(selected_pairs),
        "dormant_count": sum(row["inactivityPenalty"] > 0 for row in selected),
    }
    for source in ("explicit", "bio"):
        available = _topics(candidates.values(), source)
        covered = _topics(selected, source)
        result[f"{source}_coverage"] = len(covered & available) / len(available) if available else None
    return result


def aggregate_quality(results, catalog):
    total = sum(row["quality"]["selected_count"] for row in results)
    pairs = sum(row["quality"]["selected_pairs"] for row in results)
    selected = set(circle_id for row in results for circle_id in row["ranking"])
    output = {
        "catalog_coverage": len(selected & catalog) / len(catalog) if catalog else 0.0,
        "catalog_size": len(catalog),
        "distinct_recommended_circles": len(selected & catalog),
        "near_duplicate_pair_rate": sum(row["quality"]["near_duplicate_pairs"] for row in results) / pairs if pairs else 0.0,
        "dormant_exposure_rate": sum(row["quality"]["dormant_count"] for row in results) / total if total else 0.0,
        "eligibility_violations": sum(row["quality"]["eligibility_violations"] for row in results),
        "repeated_circle_ids": sum(row["quality"]["repeated_circle_ids"] for row in results),
        "fallback_rate": sum(bool(row["fallback_reason"]) for row in results) / len(results) if results else 0.0,
        "recommendation_count": total,
    }
    for source in ("explicit", "bio"):
        values = [row["quality"][f"{source}_coverage"] for row in results
                  if row["quality"][f"{source}_coverage"] is not None]
        output[f"{source}_interest_coverage"] = sum(values) / len(values) if values else None
        output[f"{source}_coverage_users"] = len(values)
    return output


def collaborative_ranking(artifact, user_id, context, score_function):
    candidate_ids = baseline_ids(context)
    prediction = score_function(artifact, user_id, candidate_ids)
    if prediction["fallback_reason"]:
        return candidate_ids, prediction
    ranking = sorted(candidate_ids, key=lambda circle_id: (-prediction["scores"][str(circle_id)], circle_id))
    return ranking, prediction
