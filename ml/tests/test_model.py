import copy
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ml.data import canonical_hash, file_sha256, write_json
from ml.model import load_model, save_model, score_user, shrink_similarity, training_pairs, validate_model


def handwritten_artifact():
    similarity = 1 / (4 * math.sqrt(2))
    pairs = [{"user_id": 10, "circle_id": 101},
             {"user_id": 30, "circle_id": 101},
             {"user_id": 30, "circle_id": 202}]
    return {
        "schema_version": 1,
        "model_type": "item_item_cosine",
        "mode": "full_data",
        "seed": 17,
        "reference_date": "2026-09-21T00:00:00.000Z",
        "user_ids": [10, 30, 90],
        "circle_ids": [101, 202, 505],
        "histories": {"10": [101], "30": [101, 202], "90": []},
        "similarity": [[0, similarity, 0], [similarity, 0, 0], [0, 0, 0]],
        "overlap": [[2, 1, 0], [1, 1, 0], [0, 0, 0]],
        "popularity": {"101": 2, "202": 1, "505": 0},
        "config": {"shrinkage": 3},
        "training_hash": canonical_hash(pairs),
        "snapshot": {"path": "snapshot.json", "sha256": "0" * 64},
        "splits": None,
        "versions": {"python": "3.11.0", "numpy": "1.26.4", "scipy": "1.13.1", "scikit-learn": "1.5.2"},
    }


def fixture_snapshot():
    return {
        "schema_version": 1,
        "reference_date": "2026-09-21T00:00:00.000Z",
        "dataset": {
            "users": [{"id": 90}, {"id": 10}, {"id": 30}],
            "circles": [{"id": 505}, {"id": 202}, {"id": 101}],
            "topics": [], "activity": [],
            "memberships": [
                {"user_id": 30, "circle_id": 202, "role": "member"},
                {"user_id": 10, "circle_id": 101, "role": "member"},
                {"user_id": 30, "circle_id": 101, "role": "leader"},
            ],
        },
        "recommendations": [],
    }


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.artifact = handwritten_artifact()

    def test_formula_shrinks_low_overlap(self):
        self.assertAlmostEqual(shrink_similarity(0.8, 1, 3), 0.2)
        self.assertAlmostEqual(shrink_similarity(0.8, 9, 3), 0.6)
        self.assertEqual(shrink_similarity(0.8, 0, 3), 0)

    def test_formula_rejects_invalid_settings(self):
        for arguments in [(1, 1, 0), (1, -1, 3), (float("nan"), 1, 3), (True, 1, 3), (1, 1, float("inf"))]:
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                shrink_similarity(*arguments)

    def test_binary_pairs_ignore_duplicate_roles_and_input_order(self):
        data = fixture_snapshot()["dataset"]
        data["memberships"].append({"user_id": 10, "circle_id": 101, "role": "leader"})
        self.assertEqual(len(training_pairs(data)), 3)
        self.assertEqual(canonical_hash(training_pairs(data)), self.artifact["training_hash"])

    def test_unknown_membership_reference_fails(self):
        data = fixture_snapshot()["dataset"]
        data["memberships"].append({"user_id": 999, "circle_id": 101, "role": "member"})
        with self.assertRaisesRegex(ValueError, "unknown"):
            training_pairs(data)

    def test_nonconsecutive_ids_and_unseen_circle(self):
        result = score_user(validate_model(self.artifact), 10, [999, 505, 202])
        self.assertAlmostEqual(result["scores"]["202"], 1 / (4 * math.sqrt(2)))
        self.assertEqual(result["support"], {"202": 1, "505": 0, "999": 0})
        self.assertEqual(result["scores"]["999"], 0)
        self.assertIsNone(result["fallback_reason"])

    def test_scores_average_history_without_mutation(self):
        before = copy.deepcopy(self.artifact)
        result = score_user(self.artifact, 30, [202])
        self.assertAlmostEqual(result["scores"]["202"], 1 / (8 * math.sqrt(2)))
        self.assertEqual(result["history_count"], 2)
        self.assertEqual(self.artifact, before)

    def test_fallback_cases(self):
        for user, candidates, reason in [(90, [202], "no_history"),
                                          (700, [202], "unseen_user"),
                                          (10, [505, 999], "no_supported_candidates")]:
            with self.subTest(reason=reason):
                result = score_user(self.artifact, user, candidates)
                self.assertEqual(result["fallback_reason"], reason)
                self.assertTrue(all(value == 0 for value in result["scores"].values()))

    def test_duplicate_candidates_and_invalid_ids_fail(self):
        for user, circles in [(True, [202]), (0, [202]), (10, [202, 202]), (10, [-1])]:
            with self.subTest(user=user, circles=circles), self.assertRaises(ValueError):
                score_user(self.artifact, user, circles)

    def test_deterministic_input_order(self):
        self.assertEqual(score_user(self.artifact, 10, [505, 202]), score_user(self.artifact, 10, [202, 505]))

    def test_rejects_corrupt_artifacts(self):
        corruptions = [
            lambda a: a.update(schema_version=True),
            lambda a: a.update(model_type="other"),
            lambda a: a.update(seed=-1),
            lambda a: a.update(seed=2**53),
            lambda a: a.update(reference_date="2027-01-01T00:00:00.000Z"),
            lambda a: a["circle_ids"].reverse(),
            lambda a: a["user_ids"].append(90),
            lambda a: a["histories"]["10"].append(999),
            lambda a: a["histories"].pop("90"),
            lambda a: a.update(training_hash="0" * 64),
            lambda a: a["popularity"].update({"101": 3}),
            lambda a: a["similarity"].pop(),
            lambda a: a["similarity"][0].__setitem__(0, 0.2),
            lambda a: a["similarity"][0].__setitem__(1, float("nan")),
            lambda a: a["similarity"][0].__setitem__(1, 0.9),
            lambda a: a["overlap"][0].__setitem__(1, 2),
            lambda a: a["config"].update(shrinkage=0),
            lambda a: a["versions"].pop("scipy"),
            lambda a: a.update(mode="evaluation"),
            lambda a: a["snapshot"].update(sha256="bad"),
        ]
        for index, corrupt in enumerate(corruptions):
            with self.subTest(index=index), self.assertRaises(ValueError):
                artifact = copy.deepcopy(self.artifact)
                corrupt(artifact)
                validate_model(artifact)

    def test_save_load_preserves_scores_and_never_fits(self):
        with tempfile.TemporaryDirectory() as directory, patch("ml.model.fit_model", side_effect=AssertionError("Training forbidden")):
            root = Path(directory)
            write_json(root / "snapshot.json", fixture_snapshot())
            self.artifact["snapshot"]["sha256"] = file_sha256(root / "snapshot.json")
            save_model(root / "model.json", self.artifact)
            before = file_sha256(root / "model.json")
            loaded = load_model(root / "model.json")
            self.assertEqual(loaded, self.artifact)
            self.assertEqual(score_user(loaded, 10, [202, 505]), score_user(self.artifact, 10, [202, 505]))
            self.assertEqual(before, file_sha256(root / "model.json"))

    def test_changed_snapshot_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_json(root / "snapshot.json", fixture_snapshot())
            self.artifact["snapshot"]["sha256"] = file_sha256(root / "snapshot.json")
            save_model(root / "model.json", self.artifact)
            snapshot = fixture_snapshot()
            snapshot["dataset"]["users"].append({"id": 999})
            write_json(root / "snapshot.json", snapshot)
            with self.assertRaisesRegex(ValueError, "snapshot hash"):
                load_model(root / "model.json")

    def test_duplicate_json_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.json"
            path.write_text('{"schema_version": 1, "schema_version": 2}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Duplicate JSON"):
                load_model(path)

    def test_changed_split_bytes_are_rejected_without_retraining(self):
        with tempfile.TemporaryDirectory() as directory, patch("ml.model.fit_model", side_effect=AssertionError("Training forbidden")):
            root = Path(directory)
            write_json(root / "snapshot.json", fixture_snapshot())
            snapshot_hash = file_sha256(root / "snapshot.json")
            splits = {
                "schema_version": 1, "seed": 17, "snapshot_sha256": snapshot_hash,
                "validation": [], "test": [],
                "skipped_users": [{"user_id": user, "reason": "insufficient_history"} for user in [10, 30, 90]],
            }
            write_json(root / "splits.json", splits)
            self.artifact["mode"] = "evaluation"
            self.artifact["snapshot"]["sha256"] = snapshot_hash
            self.artifact["splits"] = {"path": "splits.json", "sha256": file_sha256(root / "splits.json")}
            save_model(root / "model.json", self.artifact)
            self.assertEqual(load_model(root / "model.json"), self.artifact)
            with (root / "splits.json").open("a", encoding="utf-8") as stream:
                stream.write("\n")
            with self.assertRaisesRegex(ValueError, "split hash"):
                load_model(root / "model.json")

    def test_invalid_artifact_does_not_replace_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.json"
            path.write_text("existing", encoding="utf-8")
            self.artifact["similarity"][0][1] = float("inf")
            with self.assertRaises(ValueError):
                save_model(path, self.artifact)
            self.assertEqual(path.read_text(encoding="utf-8"), "existing")


if __name__ == "__main__":
    unittest.main()
