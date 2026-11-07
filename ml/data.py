"""Validated experiment data, reproducible splits, and the offline TS boundary."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import subprocess
import tempfile


REFERENCE_DATE = "2026-09-21T00:00:00.000Z"
ROOT = Path(__file__).resolve().parents[1]
ML_ROOT = ROOT / "ml"
NODE_ROOT = ROOT / "ts-nodejs"


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path):
    def invalid_constant(value):
        raise ValueError(f"Non-finite JSON value: {value}")

    with Path(path).open(encoding="utf-8") as stream:
        value = json.load(stream, object_pairs_hook=_unique_object,
                          parse_constant=invalid_constant)

    def finite(item):
        if isinstance(item, float) and not math.isfinite(item):
            raise ValueError("JSON numbers must be finite")
        if isinstance(item, dict):
            for child in item.values():
                finite(child)
        elif isinstance(item, list):
            for child in item:
                finite(child)
    finite(value)
    return value


def canonical_hash(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def file_sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    target = Path(path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False, allow_nan=False)
            stream.write("\n")
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def protect_output(path, inputs=()):
    target = Path(path).resolve()
    if target in {Path(value).resolve() for value in inputs if value is not None}:
        raise ValueError("Output must not overwrite a model, snapshot, or split input")
    try:
        relative = target.relative_to(ROOT)
    except ValueError:
        return target
    if relative.parts[:2] != ("ml", ".local"):
        raise ValueError("Experiment outputs must be under .local/ inside ml/")
    return target


def artifact_input_paths(model_path):
    paths = [Path(model_path).resolve()]
    try:
        artifact = read_json(model_path)
    except (ValueError, OSError):
        return paths
    if isinstance(artifact, dict):
        for key in ("snapshot", "splits"):
            if isinstance(artifact.get(key), dict):
                try:
                    paths.append(resolve_reference(model_path, artifact[key]))
                except ValueError:
                    continue
    return paths


def resolve_reference(artifact_path, reference):
    if not isinstance(reference, dict) or not isinstance(reference.get("path"), str):
        raise ValueError("Artifact reference must contain a path")
    digest = reference.get("sha256")
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("Artifact reference must contain a SHA-256 digest")
    return (Path(artifact_path).resolve().parent / reference["path"]).resolve()


def _id(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value <= 2**53 - 1


def _records(value, name):
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise ValueError(f"{name} must be an array of objects")
    return value


def load_snapshot(path):
    snapshot = read_json(path)
    if not isinstance(snapshot, dict) or type(snapshot.get("schema_version")) is not int or snapshot["schema_version"] != 1:
        raise ValueError("Unsupported snapshot schema")
    if snapshot.get("reference_date") != REFERENCE_DATE:
        raise ValueError("Snapshot reference date does not match this experiment")
    dataset = snapshot.get("dataset")
    if not isinstance(dataset, dict):
        raise ValueError("Snapshot is missing dataset")
    ids = {}
    for name in ("users", "circles", "topics", "activity"):
        rows = _records(dataset.get(name), name)
        values = [row.get("id") for row in rows]
        if any(not _id(value) for value in values) or len(set(values)) != len(values):
            raise ValueError(f"{name} IDs must be unique positive integers")
        ids[name] = set(values)
    memberships = _records(dataset.get("memberships"), "memberships")
    pairs = set()
    for row in memberships:
        pair = (row.get("user_id"), row.get("circle_id"))
        if not _id(pair[0]) or not _id(pair[1]) or pair[0] not in ids["users"] or pair[1] not in ids["circles"]:
            raise ValueError("Membership references an unknown user or Circle")
        if row.get("role") not in ("member", "leader") or pair in pairs:
            raise ValueError("Membership roles and pairs must be valid and unique")
        pairs.add(pair)
    for row in dataset["activity"]:
        if (not _id(row.get("author_user_id")) or not _id(row.get("circle_id"))
                or (row["author_user_id"], row["circle_id"]) not in pairs):
            raise ValueError("Activity author must belong to its Circle")
    _records(snapshot.get("recommendations"), "recommendations")
    snapshot["_source_path"] = str(Path(path).resolve())
    snapshot["_sha256"] = file_sha256(path)
    return snapshot


def prepare_splits(snapshot, seed):
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 2**53 - 1:
        raise ValueError("Seed must be a nonnegative safe integer")
    generator = random.Random(seed)
    by_user = {row["id"]: [] for row in snapshot["dataset"]["users"]}
    for row in snapshot["dataset"]["memberships"]:
        by_user[row["user_id"]].append(row)
    result = {"schema_version": 1, "seed": seed,
              "snapshot_sha256": snapshot["_sha256"],
              "validation": [], "test": [], "skipped_users": []}
    for user_id in sorted(by_user):
        memberships = by_user[user_id]
        ordinary = sorted(row["circle_id"] for row in memberships if row["role"] == "member")
        if len(ordinary) < 2 or len(memberships) < 3:
            result["skipped_users"].append({"user_id": user_id, "reason": "insufficient_history"})
            continue
        validation, test = generator.sample(ordinary, 2)
        result["validation"].append({"user_id": user_id, "circle_id": validation})
        result["test"].append({"user_id": user_id, "circle_id": test})
    validate_splits(result, snapshot)
    return result


def validate_splits(splits, snapshot):
    if not isinstance(splits, dict) or type(splits.get("schema_version")) is not int or splits["schema_version"] != 1:
        raise ValueError("Unsupported split schema")
    if splits.get("snapshot_sha256") != snapshot["_sha256"]:
        raise ValueError("Split belongs to a different snapshot")
    seed = splits.get("seed")
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 2**53 - 1:
        raise ValueError("Split seed must be a nonnegative safe integer")
    membership_map = {(row["user_id"], row["circle_id"]): row
                      for row in snapshot["dataset"]["memberships"]}
    histories = {}
    for user_id, circle_id in membership_map:
        histories.setdefault(user_id, set()).add(circle_id)
    seen = set()
    group_users = []
    for name in ("validation", "test"):
        users = set()
        for row in _records(splits.get(name), name):
            user_id, circle_id = row.get("user_id"), row.get("circle_id")
            if not _id(user_id) or not _id(circle_id):
                raise ValueError("Held-out IDs must be positive integers")
            pair = (user_id, circle_id)
            membership = membership_map.get(pair)
            if not membership or membership["role"] != "member":
                raise ValueError("Held-out pairs must be existing ordinary memberships")
            if pair in seen or user_id in users:
                raise ValueError("Duplicate held-out pair or multiple labels for one user")
            seen.add(pair)
            users.add(user_id)
        group_users.append(users)
    if group_users[0] != group_users[1]:
        raise ValueError("Validation and test must cover the same users")
    for user_id, history in histories.items():
        removed = {circle_id for uid, circle_id in seen if uid == user_id}
        if removed and not history - removed:
            raise ValueError("Holdouts must retain training history")
    known_users = {row["id"] for row in snapshot["dataset"]["users"]}
    skipped = _records(splits.get("skipped_users"), "skipped_users")
    skipped_ids = [row.get("user_id") for row in skipped]
    if (any(not _id(uid) for uid in skipped_ids) or len(set(skipped_ids)) != len(skipped_ids)
            or set(skipped_ids) != known_users - group_users[0]
            or any(row.get("reason") != "insufficient_history" for row in skipped)):
        raise ValueError("Skipped-user coverage is inconsistent")
    for user_id in skipped_ids:
        memberships = [row for row in membership_map.values() if row["user_id"] == user_id]
        if len(memberships) >= 3 and sum(row["role"] == "member" for row in memberships) >= 2:
            raise ValueError("A user with sufficient history cannot be silently skipped")
    return splits


def load_splits(path, snapshot):
    return validate_splits(read_json(path), snapshot)


def training_dataset(snapshot, splits):
    data = copy.deepcopy(snapshot["dataset"])
    if splits is None:
        return data
    validate_splits(splits, snapshot)
    held_out = {(row["user_id"], row["circle_id"])
                for group in ("validation", "test") for row in splits[group]}
    data["memberships"] = [row for row in data["memberships"]
                           if (row["user_id"], row["circle_id"]) not in held_out]
    data["activity"] = [row for row in data["activity"]
                        if (row["author_user_id"], row["circle_id"]) not in held_out]
    return data


def bridge_context(snapshot_path, splits_path=None, user_id=None, limit=5):
    command = [shutil.which("node") or "node",
               str(NODE_ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"),
               str(NODE_ROOT / "scripts" / "ml-bridge.ts"), "context",
               "--snapshot", str(Path(snapshot_path).resolve()), "--limit", str(limit)]
    if splits_path is not None:
        command += ["--splits", str(Path(splits_path).resolve())]
    if user_id is not None:
        command += ["--user-id", str(user_id)]
    try:
        result = subprocess.run(command, cwd=NODE_ROOT, shell=False, capture_output=True,
                                text=True, encoding="utf-8", timeout=120, check=False)
    except subprocess.TimeoutExpired as error:
        raise ValueError("TypeScript bridge timed out") from error
    if result.returncode:
        raise ValueError(f"TypeScript bridge failed: {result.stderr.strip() or 'unknown error'}")
    try:
        context = json.loads(result.stdout, object_pairs_hook=_unique_object)
    except (ValueError, TypeError) as error:
        raise ValueError("TypeScript bridge did not return valid JSON") from error
    if (not isinstance(context, dict) or context.get("schema_version") != 1
            or context.get("reference_date") != REFERENCE_DATE):
        raise ValueError("TypeScript bridge returned incompatible context")
    users = _records(context.get("users"), "context users")
    if len({row.get("user_id") for row in users}) != len(users):
        raise ValueError("TypeScript bridge returned duplicate users")
    return context


def positive_id(value):
    if not value.isascii() or not value.isdigit() or value.startswith("0"):
        raise ValueError("Expected a positive decimal integer")
    result = int(value)
    if not _id(result):
        raise ValueError("Expected a positive safe integer")
    return result


def limit_value(value):
    result = positive_id(value)
    if result > 20:
        raise ValueError("Limit must be between 1 and 20")
    return result
