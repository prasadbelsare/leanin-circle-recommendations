import copy
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data import REFERENCE_DATE, file_sha256, load_snapshot, prepare_splits, write_json
import evaluate
from metrics import (aggregate_quality, baseline_ids, collaborative_ranking,
                     quality_metrics, ranking_metrics)
from test_data import snapshot_fixture

spec = importlib.util.spec_from_file_location("inference_cli", Path(__file__).resolve().parents[1] / "eval.py")
inference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inference)


def context_fixture(user_id=101):
    rows = []
    for rank, (circle_id, source) in enumerate(((37, "explicit"), (11, "bio"), (23, "explicit")), 1):
        rows.append({
            "circle": {"id": circle_id, "name": f"Circle {circle_id}", "topic": "leadership-skills",
                       "description": None, "format": "virtual", "join_policy": "request"},
            "totalScore": 70 - rank, "inactivityPenalty": 80 if circle_id == 23 else 0,
            "selection": {"rank": rank, "selectionScore": 70 - rank,
                          "unsupportedContextPurpose": False, "config": {"strongBioConfidence": 0.8}},
            "matchingEvidence": {"matches": [{"topic": "leadership-skills" if source == "explicit" else "mentorship",
                                               "source": source, "strength": 0.9, "confidence": 0.9}]},
            "explanation": "Explore this Circle; membership requires approval.",
        })
    return {"user_id": user_id, "scored": rows, "baseline": rows, "diagnostics": rows,
            "near_duplicate_pairs": [[11, 23]]}


def prediction(fallback=None):
    return {"scores": {"11": 0.5, "23": 0.5, "37": 0.1},
            "support": {"11": 2, "23": 2, "37": 1}, "history_count": 1,
            "fallback_reason": fallback}


class MetricTests(unittest.TestCase):
    def test_recall_and_ndcg_use_heldout_rank(self):
        self.assertEqual(ranking_metrics([11, 23, 37], 37, 3), {"recall": 1.0, "ndcg": 0.5})
        self.assertEqual(ranking_metrics([11, 23, 37], 37, 1), {"recall": 0.0, "ndcg": 0.0})

    def test_quality_uses_bridge_similarity_and_source_evidence(self):
        quality = quality_metrics(context_fixture(), [11, 23], 5)
        self.assertEqual(quality["near_duplicate_pairs"], 1)
        self.assertEqual(quality["dormant_count"], 1)
        self.assertEqual(quality["explicit_coverage"], 1)
        self.assertEqual(quality["bio_coverage"], 1)
        self.assertEqual(quality["eligibility_violations"], 0)

    def test_unsupported_context_does_not_supply_interest_coverage(self):
        context = context_fixture()
        context["diagnostics"][1]["selection"]["unsupportedContextPurpose"] = True
        self.assertIsNone(quality_metrics(context, [11], 5)["bio_coverage"])

    def test_eligibility_and_repeated_ids_are_counted(self):
        quality = quality_metrics(context_fixture(), [11, 11, 9000], 5)
        self.assertEqual(quality["eligibility_violations"], 1)
        self.assertEqual(quality["repeated_circle_ids"], 1)

    def test_aggregate_reports_denominators_and_fallback(self):
        quality = quality_metrics(context_fixture(), [11, 23], 5)
        result = aggregate_quality([{"quality": quality, "ranking": [11, 23], "fallback_reason": "no_history"}], {11, 23, 37})
        self.assertAlmostEqual(result["catalog_coverage"], 2 / 3)
        self.assertEqual(result["near_duplicate_pair_rate"], 1)
        self.assertEqual(result["dormant_exposure_rate"], 0.5)
        self.assertEqual(result["fallback_rate"], 1)

    def test_cf_ties_use_ids_and_zero_support_preserves_baseline(self):
        context = context_fixture()
        ranking, _ = collaborative_ranking({}, 101, context, lambda *_: prediction())
        self.assertEqual(ranking, [11, 23, 37])
        ranking, _ = collaborative_ranking({}, 101, context, lambda *_: prediction("no_supported_candidates"))
        self.assertEqual(ranking, baseline_ids(context))


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.snapshot_path = self.root / "snapshot.json"
        write_json(self.snapshot_path, snapshot_fixture())
        self.snapshot = load_snapshot(self.snapshot_path)
        self.splits = prepare_splits(self.snapshot, 17)
        self.splits_path = self.root / "splits.json"
        write_json(self.splits_path, self.splits)
        self.artifact = {"mode": "evaluation", "snapshot": {"path": "snapshot.json", "sha256": self.snapshot["_sha256"]},
                         "splits": {"path": "splits.json", "sha256": file_sha256(self.splits_path)},
                         "popularity": {"11": 0, "23": 0, "37": 2}, "config": {"shrinkage": 3}}
        self.context = {"schema_version": 1, "reference_date": REFERENCE_DATE,
                        "users": [context_fixture(uid) for uid in (101, 1001, 5001)]}

    def test_evaluation_uses_masked_bridge_and_shared_candidate_pool(self):
        with patch("evaluate.load_model", return_value=self.artifact), patch("evaluate.score_user", return_value=prediction()), patch("evaluate.bridge_context", return_value=self.context) as bridge:
            result = evaluate.evaluate_model(self.root / "model.json", "validation")
        self.assertEqual(result["cohort"]["evaluated_users"], 1)
        self.assertEqual(result["cohort"]["insufficient_history_users"], 2)
        self.assertEqual(set(result["metrics"]), {"baseline", "popularity", "collaborative"})
        self.assertEqual(bridge.call_args.kwargs["splits_path"], self.splits_path)
        for metrics in result["metrics"].values():
            self.assertEqual(metrics["5"]["recall"], 1)
            self.assertEqual(metrics["5"]["eligibility_violations"], 0)

    def test_ineligible_targets_are_reported_not_scored_as_misses(self):
        context = copy.deepcopy(self.context)
        target = self.splits["validation"][0]["circle_id"]
        context["users"][0]["diagnostics"] = [row for row in context["users"][0]["diagnostics"] if row["circle"]["id"] != target]
        with patch("evaluate.load_model", return_value=self.artifact), patch("evaluate.bridge_context", return_value=context):
            result = evaluate.evaluate_model(self.root / "model.json", "validation")
        self.assertEqual(result["cohort"]["evaluated_users"], 0)
        self.assertEqual(result["cohort"]["excluded_targets"][0]["circle_id"], target)
        self.assertIsNone(result["metrics"]["baseline"]["5"]["recall"])

    def test_bad_model_is_not_silently_evaluated_as_baseline(self):
        with patch("evaluate.load_model", side_effect=ValueError("bad artifact")):
            with self.assertRaisesRegex(ValueError, "bad artifact"):
                evaluate.evaluate_model(self.root / "model.json", "test")

    def test_demo_artifact_cannot_be_used_for_heldout_evaluation(self):
        artifact = {**self.artifact, "mode": "full_data", "splits": None}
        with patch("evaluate.load_model", return_value=artifact):
            with self.assertRaisesRegex(ValueError, "demo artifacts"):
                evaluate.evaluate_model(self.root / "model.json", "test")

    def test_missing_model_falls_back_only_with_explicit_snapshot(self):
        one = {**self.context, "users": [self.context["users"][0]]}
        with patch.object(inference, "load_model", side_effect=FileNotFoundError()), patch.object(inference, "bridge_context", return_value=one):
            result = inference.infer(self.root / "missing.json", 101, 3, self.snapshot_path)
            self.assertEqual(result["metadata"]["fallback_reason"], "model_unavailable")
            self.assertEqual([row["circle_id"] for row in result["baseline"]], [37, 11, 23])
            self.assertEqual([row["circle_id"] for row in result["collaborative_diagnostic"]], [37, 11, 23])
            with self.assertRaisesRegex(ValueError, "provide --snapshot"):
                inference.infer(self.root / "missing.json", 101)

    def test_inference_is_deterministic_and_labels_content_rationale(self):
        artifact = {**self.artifact, "mode": "full_data", "splits": None}
        one = {**self.context, "users": [self.context["users"][0]]}
        with patch.object(inference, "load_model", return_value=artifact), patch.object(inference, "bridge_context", return_value=one), patch.object(inference, "score_user", return_value=prediction()):
            first = inference.infer(self.root / "model.json", 101, 3)
            self.assertEqual(first, inference.infer(self.root / "model.json", 101, 3))
            self.assertEqual([row["circle_id"] for row in first["collaborative_diagnostic"]], [11, 23, 37])
            self.assertIn("content_rationale", first["collaborative_diagnostic"][0])
            self.assertIn("explanation", first["baseline"][0])
            self.assertEqual(first["collaborative_diagnostic"][0]["join_policy"], "request")

    def test_unknown_users_and_invalid_limits_are_errors(self):
        with patch.object(inference, "load_model", side_effect=FileNotFoundError()):
            with self.assertRaisesRegex(ValueError, "Unknown user"):
                inference.infer(self.root / "missing.json", 999999, 5, self.snapshot_path)
        for limit in (0, 21, 1.5, True):
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                inference.infer(self.root / "model.json", 101, limit)

    def test_limits_cap_available_results_without_duplicates(self):
        one = {**self.context, "users": [self.context["users"][0]]}
        with patch.object(inference, "load_model", side_effect=FileNotFoundError()), patch.object(inference, "bridge_context", return_value=one):
            for limit in (1, 3, 5, 10, 20):
                result = inference.infer(self.root / "missing.json", 101, limit, self.snapshot_path)
                self.assertEqual(result["metadata"]["count"], min(3, limit))
                self.assertEqual(len(result["baseline"]), min(3, limit))

    def test_empty_candidate_pool_returns_successful_empty_results(self):
        one = {**self.context, "users": [{"user_id": 101, "scored": [], "baseline": [], "diagnostics": [], "near_duplicate_pairs": []}]}
        with patch.object(inference, "load_model", side_effect=FileNotFoundError()), patch.object(inference, "bridge_context", return_value=one):
            result = inference.infer(self.root / "missing.json", 101, 5, self.snapshot_path)
        self.assertEqual(result["metadata"]["count"], 0)
        self.assertEqual(result["baseline"], [])
        self.assertEqual(result["collaborative_diagnostic"], [])

    def test_prepare_splits_cannot_overwrite_snapshot(self):
        before = self.snapshot_path.read_bytes()
        with patch("sys.stderr", new_callable=io.StringIO):
            code = evaluate.main(["--prepare-splits", "--snapshot", str(self.snapshot_path), "--out", str(self.snapshot_path)])
        self.assertEqual(code, 2)
        self.assertEqual(before, self.snapshot_path.read_bytes())

    def test_inference_and_evaluation_reports_cannot_overwrite_artifact_inputs(self):
        model_path = self.root / "model.json"
        write_json(model_path, self.artifact)
        protected = [model_path, self.snapshot_path, self.splits_path]
        before = [path.read_bytes() for path in protected]
        for path in protected:
            with self.subTest(path=path), patch("sys.stderr", new_callable=io.StringIO):
                self.assertEqual(inference.main(["--model", str(model_path), "--user-id", "101", "--out", str(path)]), 2)
                self.assertEqual(evaluate.main(["--model", str(model_path), "--split", "test", "--out", str(path)]), 2)
        self.assertEqual([path.read_bytes() for path in protected], before)


if __name__ == "__main__":
    unittest.main()
