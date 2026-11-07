import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data import (REFERENCE_DATE, bridge_context, canonical_hash, file_sha256,
                  load_snapshot, load_splits, positive_id, prepare_splits,
                  protect_output, read_json, training_dataset, validate_splits, write_json)


def snapshot_fixture():
    return {
        "schema_version": 1, "reference_date": REFERENCE_DATE,
        "dataset": {
            "users": [{"id": 1001}, {"id": 101}, {"id": 5001}],
            "circles": [{"id": cid, "member_count": 3, "max_members": 3} for cid in (11, 23, 37)],
            "topics": [{"id": 77}],
            "memberships": [
                {"user_id": 101, "circle_id": 11, "role": "member"},
                {"user_id": 101, "circle_id": 23, "role": "member"},
                {"user_id": 101, "circle_id": 37, "role": "leader"},
                {"user_id": 1001, "circle_id": 37, "role": "member"},
            ],
            "activity": [{"id": 1, "circle_id": 11, "author_user_id": 101},
                         {"id": 2, "circle_id": 23, "author_user_id": 101},
                         {"id": 3, "circle_id": 37, "author_user_id": 101}],
        },
        "recommendations": [],
    }


class DataTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "snapshot.json"
        write_json(self.path, snapshot_fixture())
        self.snapshot = load_snapshot(self.path)

    def test_snapshot_hash_is_exact_file_hash(self):
        self.assertEqual(self.snapshot["_sha256"], file_sha256(self.path))
        self.assertEqual(self.snapshot["_source_path"], str(self.path.resolve()))
        self.assertNotIn("_sha256", read_json(self.path))

    def test_deterministic_split_preserves_leadership_and_training_history(self):
        splits = prepare_splits(self.snapshot, 17)
        self.assertEqual(splits, prepare_splits(self.snapshot, 17))
        targets = splits["validation"] + splits["test"]
        self.assertEqual({row["circle_id"] for row in targets}, {11, 23})
        self.assertEqual({row["user_id"] for row in splits["skipped_users"]}, {1001, 5001})
        shuffled = copy.deepcopy(self.snapshot)
        shuffled["dataset"]["users"].reverse()
        shuffled["dataset"]["memberships"].reverse()
        self.assertEqual(splits, prepare_splits(shuffled, 17))

    def test_masking_removes_both_holdouts_and_posts_without_freeing_capacity(self):
        splits = prepare_splits(self.snapshot, 17)
        masked = training_dataset(self.snapshot, splits)
        self.assertEqual([(row["user_id"], row["circle_id"]) for row in masked["memberships"]], [(101, 37), (1001, 37)])
        self.assertEqual([row["id"] for row in masked["activity"]], [3])
        self.assertEqual(masked["circles"], self.snapshot["dataset"]["circles"])
        self.assertEqual(len(self.snapshot["dataset"]["memberships"]), 4)
        self.assertEqual(len(self.snapshot["dataset"]["activity"]), 3)

    def test_split_file_cannot_be_used_with_a_different_snapshot(self):
        splits = prepare_splits(self.snapshot, 17)
        path = Path(self.directory.name) / "splits.json"
        write_json(path, splits)
        self.assertEqual(load_splits(path, self.snapshot), splits)
        altered = copy.deepcopy(self.snapshot)
        altered["_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "different snapshot"):
            load_splits(path, altered)

    def test_leader_or_duplicate_holdouts_are_rejected(self):
        splits = prepare_splits(self.snapshot, 17)
        leader = copy.deepcopy(splits)
        leader["validation"][0]["circle_id"] = 37
        with self.assertRaisesRegex(ValueError, "ordinary memberships"):
            validate_splits(leader, self.snapshot)
        repeated = copy.deepcopy(splits)
        repeated["test"] = repeated["validation"]
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            validate_splits(repeated, self.snapshot)

    def test_evaluable_users_cannot_be_silently_removed_from_a_split(self):
        splits = prepare_splits(self.snapshot, 17)
        splits["validation"] = []
        splits["test"] = []
        splits["skipped_users"].append({"user_id": 101, "reason": "insufficient_history"})
        with self.assertRaisesRegex(ValueError, "silently skipped"):
            validate_splits(splits, self.snapshot)

    def test_unknown_memberships_duplicate_ids_and_boolean_ids_are_rejected(self):
        for change in ("unknown", "duplicate", "boolean"):
            with self.subTest(change=change):
                value = snapshot_fixture()
                if change == "unknown":
                    value["dataset"]["memberships"][0]["circle_id"] = 9001
                elif change == "duplicate":
                    value["dataset"]["users"].append({"id": 101})
                else:
                    value["dataset"]["users"][0]["id"] = True
                write_json(self.path, value)
                with self.assertRaises(ValueError):
                    load_snapshot(self.path)

    def test_nonfinite_duplicate_keys_and_reference_mismatch_fail(self):
        for raw in ('{"a": NaN}', '{"a": 1e9999}', '{"a": 1, "a": 2}'):
            self.path.write_text(raw, encoding="utf-8")
            with self.assertRaises(ValueError):
                read_json(self.path)
        value = snapshot_fixture()
        value["reference_date"] = "2026-01-01T00:00:00.000Z"
        write_json(self.path, value)
        with self.assertRaisesRegex(ValueError, "reference date"):
            load_snapshot(self.path)

    def test_failed_atomic_write_preserves_previous_file(self):
        before = self.path.read_bytes()
        with self.assertRaises(ValueError):
            write_json(self.path, {"score": float("nan")})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_canonical_hash_is_independent_of_object_key_order(self):
        self.assertEqual(canonical_hash({"a": 1, "b": 2}), canonical_hash({"b": 2, "a": 1}))

    def test_output_guards_preserve_inputs_and_repository_sources(self):
        with self.assertRaisesRegex(ValueError, "must not overwrite"):
            protect_output(self.path, [self.path])
        with self.assertRaisesRegex(ValueError, "under .local"):
            protect_output(Path(__file__).resolve())
        self.assertEqual(protect_output(self.path.parent / "report.json"), self.path.parent / "report.json")

    def test_split_seeds_match_javascript_safe_integer_range(self):
        for seed in (-1, True, 2**53, 1.5):
            with self.subTest(seed=seed), self.assertRaises(ValueError):
                prepare_splits(self.snapshot, seed)

    def test_bridge_uses_argument_arrays_without_shell_and_includes_split_path(self):
        output = {"schema_version": 1, "reference_date": REFERENCE_DATE, "users": []}
        result = subprocess.CompletedProcess([], 0, json.dumps(output), "")
        with patch("data.subprocess.run", return_value=result) as run:
            actual = bridge_context(self.path, self.path.parent / "split.json", 101, 3)
        self.assertEqual(actual, output)
        args, kwargs = run.call_args
        self.assertIsInstance(args[0], list)
        self.assertFalse(kwargs["shell"])
        self.assertIn("--splits", args[0])
        self.assertEqual(args[0][-2:], ["--user-id", "101"])

    def test_bridge_failures_and_timeouts_are_explicit(self):
        with patch("data.subprocess.run", return_value=subprocess.CompletedProcess([], 2, "", "invalid snapshot")):
            with self.assertRaisesRegex(ValueError, "invalid snapshot"):
                bridge_context(self.path)
        with patch("data.subprocess.run", side_effect=subprocess.TimeoutExpired("node", 120)):
            with self.assertRaisesRegex(ValueError, "timed out"):
                bridge_context(self.path)

    def test_invalid_cli_ids_are_rejected(self):
        for value in ("0", "01", "-1", "1.5", "1e2", " 1", "١", str(2**53)):
            with self.subTest(value=value), self.assertRaises(ValueError):
                positive_id(value)


if __name__ == "__main__":
    unittest.main()
