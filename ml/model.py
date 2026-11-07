"""Item-item affinity, saved-model validation, and inference."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

try:
    from .data import REFERENCE_DATE, canonical_hash, file_sha256, load_snapshot, load_splits, read_json, resolve_reference, training_dataset, write_json
except ImportError:
    from data import REFERENCE_DATE, canonical_hash, file_sha256, load_snapshot, load_splits, read_json, resolve_reference, training_dataset, write_json


MODEL_TYPE = "item_item_cosine"
ARTIFACT_VERSION = 1


def _positive_id(value: Any) -> bool:
    return type(value) is int and 0 < value <= 2**53 - 1


def _finite_number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _ids(values: Any, name: str) -> list[int]:
    if not isinstance(values, list) or any(not _positive_id(value) for value in values):
        raise ValueError(f"{name} must contain positive safe integer IDs")
    if values != sorted(set(values)):
        raise ValueError(f"{name} must be sorted and unique")
    return values


def training_pairs(dataset: dict) -> list[dict[str, int]]:
    users = {row["id"] for row in dataset["users"]}
    circles = {row["id"] for row in dataset["circles"]}
    pairs = set()
    for row in dataset["memberships"]:
        user, circle = row["user_id"], row["circle_id"]
        if not _positive_id(user) or not _positive_id(circle) or user not in users or circle not in circles:
            raise ValueError("Membership references an unknown user or Circle")
        pairs.add((user, circle))
    return [{"user_id": user, "circle_id": circle} for user, circle in sorted(pairs)]


def shrink_similarity(cosine: float, overlap: int, shrinkage: float) -> float:
    if not _finite_number(cosine) or not 0 <= cosine <= 1:
        raise ValueError("Cosine similarity must be finite and between zero and one")
    if type(overlap) is not int or overlap < 0:
        raise ValueError("Overlap must be a nonnegative integer")
    if not _finite_number(shrinkage) or shrinkage <= 0:
        raise ValueError("Shrinkage must be finite and positive")
    return cosine * overlap / (overlap + shrinkage)


def fit_model(dataset: dict, shrinkage: float = 3) -> dict:
    """Build shrunk item similarities from binary memberships."""
    shrink_similarity(0, 0, shrinkage)
    user_ids = _ids(sorted(row["id"] for row in dataset["users"]), "user_ids")
    circle_ids = _ids(sorted(row["id"] for row in dataset["circles"]), "circle_ids")
    pairs = training_pairs(dataset)
    users = {value: index for index, value in enumerate(user_ids)}
    circles = {value: index for index, value in enumerate(circle_ids)}
    histories = {str(user): [] for user in user_ids}
    for row in pairs:
        histories[str(row["user_id"])].append(row["circle_id"])

    import numpy as np
    from scipy.sparse import csr_matrix
    from sklearn.metrics.pairwise import cosine_similarity

    matrix = csr_matrix((np.ones(len(pairs), dtype=np.float64), (
        [users[row["user_id"]] for row in pairs],
        [circles[row["circle_id"]] for row in pairs],
    )), shape=(len(user_ids), len(circle_ids)))
    overlaps = (matrix.T @ matrix).toarray().astype(np.int64)
    if user_ids and circle_ids:
        cosine = np.clip(cosine_similarity(matrix.T), 0, 1)
        similarities = cosine * overlaps / (overlaps + shrinkage)
        np.fill_diagonal(similarities, 0)
    else:
        similarities = np.zeros((len(circle_ids), len(circle_ids)))
    return {
        "model_type": MODEL_TYPE,
        "user_ids": user_ids,
        "circle_ids": circle_ids,
        "histories": histories,
        "similarity": similarities.tolist(),
        "overlap": overlaps.tolist(),
        "popularity": {str(circle): int(overlaps[index, index]) for index, circle in enumerate(circle_ids)},
        "config": {"shrinkage": shrinkage},
        "training_hash": canonical_hash(pairs),
    }


def validate_model(artifact: Any) -> dict:
    if (not isinstance(artifact, dict) or type(artifact.get("schema_version")) is not int
            or artifact["schema_version"] != ARTIFACT_VERSION):
        raise ValueError("Unsupported model artifact schema")
    if artifact.get("model_type") != MODEL_TYPE:
        raise ValueError("Unsupported model type")
    if artifact.get("mode") not in ("evaluation", "full_data"):
        raise ValueError("Invalid artifact mode")
    if type(artifact.get("seed")) is not int or not 0 <= artifact["seed"] <= 2**53 - 1:
        raise ValueError("Model seed must be a nonnegative safe integer")
    if artifact.get("reference_date") != REFERENCE_DATE:
        raise ValueError("Model reference date does not match this experiment")
    config = artifact.get("config")
    if not isinstance(config, dict):
        raise ValueError("Missing model configuration")
    shrinkage = config.get("shrinkage")
    shrink_similarity(0, 0, shrinkage)
    user_ids = _ids(artifact.get("user_ids"), "user_ids")
    circle_ids = _ids(artifact.get("circle_ids"), "circle_ids")
    circle_set = set(circle_ids)
    histories = artifact.get("histories")
    if not isinstance(histories, dict) or set(histories) != {str(user) for user in user_ids}:
        raise ValueError("Histories do not match user IDs")
    for history in histories.values():
        if any(circle not in circle_set for circle in _ids(history, "history")):
            raise ValueError("History references an unknown Circle")
    members = {circle: set() for circle in circle_ids}
    pairs = []
    for user in user_ids:
        for circle in histories[str(user)]:
            members[circle].add(user)
            pairs.append({"user_id": user, "circle_id": circle})
    if artifact.get("training_hash") != canonical_hash(pairs):
        raise ValueError("Training history hash mismatch")
    popularity = artifact.get("popularity")
    if not isinstance(popularity, dict) or set(popularity) != {str(circle) for circle in circle_ids}:
        raise ValueError("Popularity does not match Circle IDs")
    for circle in circle_ids:
        count = popularity[str(circle)]
        if type(count) is not int or count != len(members[circle]):
            raise ValueError("Popularity does not match training histories")

    size = len(circle_ids)
    for name in ("similarity", "overlap"):
        matrix = artifact.get(name)
        if not isinstance(matrix, list) or len(matrix) != size or any(
            not isinstance(row, list) or len(row) != size for row in matrix
        ):
            raise ValueError(f"Invalid {name} matrix dimensions")
    for i, left in enumerate(circle_ids):
        for j, right in enumerate(circle_ids):
            overlap = artifact["overlap"][i][j]
            if type(overlap) is not int or overlap != len(members[left] & members[right]):
                raise ValueError("Overlap does not match training histories")
            similarity = artifact["similarity"][i][j]
            if not _finite_number(similarity) or not 0 <= similarity <= 1:
                raise ValueError("Similarity must be finite and between zero and one")
            denominator = math.sqrt(popularity[str(left)] * popularity[str(right)])
            expected = 0 if i == j or denominator == 0 else shrink_similarity(overlap / denominator, overlap, shrinkage)
            if not math.isclose(similarity, expected, rel_tol=1e-10, abs_tol=1e-12):
                raise ValueError("Similarity does not match overlap and configuration")

    versions = artifact.get("versions")
    if not isinstance(versions, dict) or any(not isinstance(versions.get(name), str) or not versions[name]
                                             for name in ("python", "numpy", "scipy", "scikit-learn")):
        raise ValueError("Missing model runtime versions")
    for name in ("snapshot", "splits"):
        ref = artifact.get(name)
        if name == "splits" and artifact["mode"] == "full_data":
            if ref is not None:
                raise ValueError("Full-data artifacts must not reference evaluation splits")
            continue
        if not isinstance(ref, dict) or not isinstance(ref.get("path"), str) or not ref["path"]:
            raise ValueError(f"Missing {name} reference")
        digest = ref.get("sha256")
        if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError(f"Invalid {name} hash")
    return artifact


def load_model(path: str | Path) -> dict:
    artifact_path = Path(path).resolve()
    artifact = read_json(artifact_path)
    validate_model(artifact)
    snapshot_path = resolve_reference(artifact_path, artifact["snapshot"])
    snapshot = load_snapshot(snapshot_path)
    if snapshot["_sha256"] != artifact["snapshot"]["sha256"]:
        raise ValueError("Model snapshot hash mismatch")
    if snapshot["reference_date"] != artifact["reference_date"]:
        raise ValueError("Model reference date mismatch")
    splits = None
    if artifact["splits"] is not None:
        split_path = resolve_reference(artifact_path, artifact["splits"])
        if file_sha256(split_path) != artifact["splits"]["sha256"]:
            raise ValueError("Model split hash mismatch")
        splits = load_splits(split_path, snapshot)
        if splits["seed"] != artifact["seed"]:
            raise ValueError("Model split seed mismatch")
    dataset = training_dataset(snapshot, splits)
    if sorted(row["id"] for row in dataset["users"]) != artifact["user_ids"] or sorted(
        row["id"] for row in dataset["circles"]
    ) != artifact["circle_ids"]:
        raise ValueError("Model mappings differ from its training snapshot")
    if canonical_hash(training_pairs(dataset)) != artifact["training_hash"]:
        raise ValueError("Model contains incorrect training memberships")
    return artifact


def save_model(path: str | Path, artifact: dict) -> None:
    validate_model(artifact)
    write_json(path, artifact)


def score_user(artifact: dict, user_id: int, candidate_ids: list[int]) -> dict:
    if not _positive_id(user_id):
        raise ValueError("User ID must be a positive safe integer")
    ids = _ids(sorted(candidate_ids), "candidate_ids")
    result = {
        "scores": {str(circle): 0.0 for circle in ids},
        "support": {str(circle): 0 for circle in ids},
        "fallback_reason": None,
        "history_count": 0,
    }
    history = artifact["histories"].get(str(user_id))
    if history is None:
        result["fallback_reason"] = "unseen_user"
        return result
    result["history_count"] = len(history)
    if not history:
        result["fallback_reason"] = "no_history"
        return result
    columns = {circle: index for index, circle in enumerate(artifact["circle_ids"])}
    for circle in ids:
        if circle not in columns:
            continue
        column = columns[circle]
        result["scores"][str(circle)] = math.fsum(
            artifact["similarity"][columns[joined]][column] for joined in history
        ) / len(history)
        result["support"][str(circle)] = sum(
            artifact["overlap"][columns[joined]][column] for joined in history if joined != circle
        )
    if not any(result["scores"].values()):
        result["fallback_reason"] = "no_supported_candidates"
    return result
