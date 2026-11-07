# Collaborative Filtering Experiment

Optional item-item collaborative filtering over Circle memberships. The
content-based TypeScript API remains the primary solution. Evaluation with
shrinkage 3 shows lower retrieval and interest-coverage metrics for collaborative
filtering; it is not integrated into the REST endpoint.

[Technical design](docs/design.md) ? [Evaluation protocol and results](docs/evaluation.md)

## Requirements and setup

Python 3.11 and Node.js 22.14 or newer. Scientific dependencies are pinned in
`requirements.txt`; TypeScript dependencies are installed from the sibling
project's lockfile. All commands below run from the repository root in Windows
PowerShell.

```powershell
npm.cmd --prefix ts-nodejs ci
py -3.11 -m venv ml/.venv
.\ml\.venv\Scripts\python.exe -m pip install -r ml/requirements.txt
.\ml\.venv\Scripts\python.exe -m pip check
```

The Python CLI invokes `ts-nodejs/scripts/ml-bridge.ts` through a subprocess
argument array. The bridge uses in-memory SQLite and the primary service's
eligibility, scoring, selection, and explanation functions. No HTTP server or
preseeded application database is required. Source datasets remain in
`ts-nodejs/data/`.

On macOS/Linux, create the environment with `python3.11 -m venv ml/.venv`, use
`ml/.venv/bin/python` for the Python executable, and `npm` for `npm.cmd`.

## Data export and splits

```powershell
npm.cmd --prefix ts-nodejs run ml:export
.\ml\.venv\Scripts\python.exe ml/evaluate.py --prepare-splits --snapshot ml/.local/snapshot.json --seed 20260921 --out ml/.local/splits.json
```

The export contains the original records, all eligible candidates, baseline
scores/order, explanations, and full selection diagnostics. Split preparation
holds out one ordinary-member membership for validation and one for test when
at least one training membership remains. Leadership roles are not targets.
Both holdout sets and associated author/Circle posts are masked globally.
Snapshot capacity and activity aggregates remain fixed.

Exports, splits, models, and raw reports reside under ignored `ml/.local/`.
The committed evaluation summary provides results without requiring generated
artifacts in the repository. Artifacts reference exact snapshot and split hashes;
changing either input requires a corresponding model rebuild. CLI outputs cannot
overwrite their inputs or repository source files.

## Train and evaluate

Create a model for held-out evaluation:

```powershell
.\ml\.venv\Scripts\python.exe ml/train.py --snapshot ml/.local/snapshot.json --splits ml/.local/splits.json --shrinkage 3 --out ml/.local/model.json
```

Evaluate the saved artifact without refitting:

```powershell
.\ml\.venv\Scripts\python.exe ml/evaluate.py --model ml/.local/model.json --split validation --out ml/.local/validation-report.json
.\ml\.venv\Scripts\python.exe ml/evaluate.py --model ml/.local/model.json --split test --out ml/.local/test-report.json
```

`config.json` defines the seed, default shrinkage, and a candidate validation grid.
The documented comparison uses fixed shrinkage 3; it does not establish that this
value is optimal. Any parameter search must use validation data and separate
artifact paths before the selected model is evaluated on test data. Metrics are
Recall/NDCG at 5 and 10, catalog coverage, near-duplicate exposure, explicit/bio
interest coverage, dormancy, fallback rate, and eligibility violations.

## Per-user inference

A separate full-data artifact supports inference with current membership history:

```powershell
.\ml\.venv\Scripts\python.exe ml/train.py --snapshot ml/.local/snapshot.json --full-data --shrinkage 3 --out ml/.local/demo-model.json
.\ml\.venv\Scripts\python.exe ml/eval.py --model ml/.local/demo-model.json --user-id 7 --limit 5
.\ml\.venv\Scripts\python.exe ml/eval.py --model ml/.local/demo-model.json --user-id 42 --limit 5
```

`eval.py` is the inference CLI. `evaluate.py` computes aggregate held-out metrics.
Evaluation artifacts are rejected by the demo CLI; full-data artifacts are
rejected by held-out evaluation.

Inference returns `metadata`, `baseline`, and `collaborative_diagnostic`.
Each result includes Circle metadata, baseline rank/scores, CF affinity,
co-membership support, and an evidence-based content rationale. A content rationale
supports the Circle's relevance; it does not explain collaborative ordering.
`support_count` sums overlap across joined Circles and is not a unique-user count.

| Argument / condition | Contract |
| --- | --- |
| `--user-id` | Positive safe integer; unknown users return an error |
| `--limit` | Integer 1?20, default 5; fewer candidates produce fewer results |
| `--out` | Optional JSON output file under `ml/.local/` inside the repository |
| No history or no supported candidates | Preserve baseline order |
| Unseen Circle | Retain as an eligible candidate with zero CF support |
| Invalid or mismatched model | Error; explicit `--snapshot` enables inference-only baseline fallback |
| Empty candidate pool | Successful empty lists |

CF ties use ascending Circle ID. Affinity is bounded in `[0, 1]` and is not a
probability of joining. Batch evaluation fails on invalid artifacts rather than
reporting baseline fallback as model performance.

## Tests and layout

```powershell
.\ml\.venv\Scripts\python.exe -m unittest discover -s ml/tests -v
npm.cmd --prefix ts-nodejs run typecheck
npm.cmd --prefix ts-nodejs test
```

Tests cover formulas, artifact validation, hashes, split isolation, ranking metrics,
CLI arguments, deterministic inference, and real Python/TypeScript integration.
Handwritten artifacts isolate inference tests from fitting.

| Module | Responsibility |
| --- | --- |
| `data.py` | Input validation, deterministic splits, masking, atomic writes, bridge calls |
| `model.py` | Binary membership fitting, artifact integrity, saved-model scoring |
| `train.py` | Explicit artifact training |
| `eval.py` | Per-user baseline and collaborative comparison |
| `evaluate.py`, `metrics.py` | Split preparation, cohort evaluation, quality metrics |

The experiment evaluates synthetic membership reconstruction. Historical profile
states, past capacity, and future membership outcomes are unavailable. Its
limitations and the decision to retain the content-based API are documented in
the [design](docs/design.md) and [results](docs/evaluation.md).
