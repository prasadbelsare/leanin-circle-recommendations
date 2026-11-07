"""Train and persist an item-item collaborative filtering model."""

from __future__ import annotations

import argparse
from importlib.metadata import version
import json
import os
from pathlib import Path
import platform
import sys

try:
    from .data import file_sha256, load_snapshot, load_splits, protect_output, training_dataset
    from .model import ARTIFACT_VERSION, fit_model, save_model
except ImportError:
    from data import file_sha256, load_snapshot, load_splits, protect_output, training_dataset
    from model import ARTIFACT_VERSION, fit_model, save_model


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description="Fit and save an offline Circle collaborative model.")
    command.add_argument("--snapshot", type=Path, required=True)
    mode = command.add_mutually_exclusive_group(required=True)
    mode.add_argument("--splits", type=Path)
    mode.add_argument("--full-data", action="store_true", help="Demo only; not valid for held-out evaluation.")
    command.add_argument("--out", type=Path, required=True)
    command.add_argument("--shrinkage", type=float)
    return command


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        config = json.loads(Path(__file__).with_name("config.json").read_text(encoding="utf-8"))
        output = protect_output(args.out, [args.snapshot, args.splits])
        snapshot_path = args.snapshot.resolve()
        splits_path = args.splits.resolve() if args.splits else None
        snapshot = load_snapshot(snapshot_path)
        splits = load_splits(splits_path, snapshot) if splits_path else None
        dataset = training_dataset(snapshot, splits)
        shrinkage = args.shrinkage if args.shrinkage is not None else config["shrinkage"]
        model = fit_model(dataset, shrinkage=shrinkage)
        reference = lambda path: {"path": os.path.relpath(path, output.parent), "sha256": file_sha256(path)}
        artifact = {
            **model,
            "schema_version": ARTIFACT_VERSION,
            "reference_date": snapshot["reference_date"],
            "seed": splits["seed"] if splits else config["seed"],
            "mode": "full_data" if args.full_data else "evaluation",
            "snapshot": reference(snapshot_path),
            "splits": reference(splits_path) if splits_path else None,
            "versions": {"python": platform.python_version(), **{
                name: version(name) for name in ("numpy", "scipy", "scikit-learn")
            }},
        }
        save_model(output, artifact)
        print(json.dumps({"status": "trained", "mode": artifact["mode"], "artifact": str(output),
                          "training_hash": artifact["training_hash"]}, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, ImportError) as error:
        print(f"Training failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
