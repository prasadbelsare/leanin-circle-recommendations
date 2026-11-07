import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from ml.data import REFERENCE_DATE, ROOT, NODE_ROOT, file_sha256, write_json
from ml.model import save_model
from ml.tests.test_model import handwritten_artifact


def fixture_dataset():
    with (NODE_ROOT / "data" / "users.json").open(encoding="utf-8") as stream:
        user_template = json.load(stream)[0]
    with (NODE_ROOT / "data" / "circles.json").open(encoding="utf-8") as stream:
        circle_template = json.load(stream)[0]
    with (NODE_ROOT / "data" / "topics.json").open(encoding="utf-8") as stream:
        topics = [row for row in json.load(stream) if row["slug"] in
                  ("leadership-skills", "public-speaking", "confidence")]
    users = []
    for user_id in (10, 30, 90):
        user = copy.deepcopy(user_template)
        user.update(id=user_id, first_name="Fixture", last_name=f"Member{user_id}",
                    has_photo=False, bio=None, job_title=None, company=None,
                    industry=None, location=None, profile_completeness=0,
                    topic_interests=["confidence"] if user_id == 10 else [])
        users.append(user)
    circles = []
    for circle_id, topic, members in ((101, "leadership-skills", 2),
                                       (202, "public-speaking", 1),
                                       (505, "confidence", 0)):
        circle = copy.deepcopy(circle_template)
        circle.update(id=circle_id, name=f"Fixture {topic}", slug=f"fixture-{topic}",
                      description=f"A Circle focused on {topic.replace('-', ' ')}.",
                      topic=topic, tags=[], access="public", max_members=None,
                      member_count=members, format="virtual",
                      join_policy="request" if circle_id == 202 else "open",
                      last_activity_at=REFERENCE_DATE, feed_posts_30d=20,
                      chat_messages_30d=200)
        circles.append(circle)
    memberships = [
        {"user_id": user, "circle_id": circle, "role": role, "joined_at": REFERENCE_DATE}
        for user, circle, role in ((10, 101, "member"), (30, 101, "leader"), (30, 202, "member"))
    ]
    return {"users": users, "circles": circles, "topics": topics,
            "memberships": memberships, "activity": []}


class CliIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="circle-ml-cli-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.directory = Path(cls.temporary.name)
        data_dir = cls.directory / "data"
        for name, records in fixture_dataset().items():
            write_json(data_dir / f"{name}.json", records)
        cls.snapshot = cls.directory / "snapshot.json"
        cls.model = cls.directory / "model.json"
        exported = subprocess.run([
            shutil.which("node") or "node", str(NODE_ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"),
            str(NODE_ROOT / "scripts" / "ml-bridge.ts"), "export", "--data-dir", str(data_dir),
            "--out", str(cls.snapshot),
        ], cwd=NODE_ROOT, shell=False, text=True, encoding="utf-8", capture_output=True,
            timeout=60, check=False)
        if exported.returncode:
            raise AssertionError(f"Fixture export failed: {exported.stderr}")
        artifact = handwritten_artifact()
        artifact["snapshot"]["sha256"] = file_sha256(cls.snapshot)
        save_model(cls.model, artifact)
        cls.original_hashes = (file_sha256(cls.snapshot), file_sha256(cls.model))

    def tearDown(self):
        self.assertEqual(self.original_hashes, (file_sha256(self.snapshot), file_sha256(self.model)))

    def command(self, script, *arguments, expected=0):
        result = subprocess.run([sys.executable, str(ROOT / "ml" / script), *map(str, arguments)],
                                cwd=ROOT, shell=False, text=True, encoding="utf-8",
                                capture_output=True, timeout=60, check=False)
        self.assertEqual(result.returncode, expected, result.stderr)
        return result

    def inference(self, user_id=10, limit=5):
        response = self.command("eval.py", "--model", self.model, "--user-id", user_id, "--limit", limit)
        return json.loads(response.stdout)

    def test_real_inference_preserves_eligibility_rationales_and_limits(self):
        for limit in (1, 3, 5, 10, 20):
            with self.subTest(limit=limit):
                response = self.inference(limit=limit)
                self.assertEqual(response["metadata"]["count"], min(limit, 2))
                self.assertEqual(response["metadata"]["requested_limit"], limit)
                self.assertFalse(response["metadata"]["hybrid_enabled"])
                self.assertIsNone(response["metadata"]["fallback_reason"])
                self.assertEqual(response["baseline"][0]["circle_id"], 505)
                self.assertIn("your interest in confidence", response["baseline"][0]["explanation"])
                diagnostic = response["collaborative_diagnostic"]
                self.assertEqual(diagnostic[0]["circle_id"], 202)
                self.assertGreater(diagnostic[0]["cf_score"], 0)
                self.assertEqual(diagnostic[0]["join_policy"], "request")
                self.assertIn("membership requires approval", diagnostic[0]["content_rationale"])
                self.assertNotIn("your interest", diagnostic[0]["content_rationale"])
                self.assertNotIn(101, [row["circle_id"] for row in diagnostic])
        self.assertEqual(self.inference(), self.inference())

    def test_cold_start_uses_exact_baseline_order_without_personal_claims(self):
        response = self.inference(user_id=90, limit=3)
        self.assertEqual(response["metadata"]["fallback_reason"], "no_history")
        self.assertEqual([row["circle_id"] for row in response["baseline"]],
                         [row["circle_id"] for row in response["collaborative_diagnostic"]])
        for row in response["baseline"]:
            self.assertNotIn("your interest", row["explanation"])
            self.assertNotIn("your bio", row["explanation"])
            self.assertNotIn("nearby", row["explanation"])

    def test_invalid_arguments_and_unknown_user_fail_cleanly(self):
        for user_id, limit in ((0, 5), (10, 21), (10, "1.5"), (999, 5)):
            with self.subTest(user_id=user_id, limit=limit):
                result = self.command("eval.py", "--model", self.model, "--user-id", user_id,
                                      "--limit", limit, expected=2)
                self.assertEqual(result.stdout, "")
                self.assertNotIn("Traceback", result.stderr)

    def test_missing_model_falls_back_without_creating_an_artifact(self):
        missing = self.directory / "missing.json"
        result = self.command("eval.py", "--model", missing, "--snapshot", self.snapshot,
                              "--user-id", 10, "--limit", 5)
        response = json.loads(result.stdout)
        self.assertEqual(response["metadata"]["fallback_reason"], "model_unavailable")
        self.assertEqual([row["circle_id"] for row in response["baseline"]],
                         [row["circle_id"] for row in response["collaborative_diagnostic"]])
        self.assertFalse(missing.exists())

    def test_protected_inputs_and_full_data_evaluation_rejected(self):
        for output in (self.model, self.snapshot):
            with self.subTest(output=output):
                result = self.command("eval.py", "--model", self.model, "--user-id", 10,
                                      "--out", output, expected=2)
                self.assertIn("must not overwrite", result.stderr)
        result = self.command("evaluate.py", "--model", self.model, "--split", "test", expected=2)
        self.assertIn("Full-data demo artifacts", result.stderr)


if __name__ == "__main__":
    unittest.main()
