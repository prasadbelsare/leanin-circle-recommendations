# Lean In Circle Recommendations

A recommendation system built to help Lean In members discover relevant, active Circles based on their interests, professional background, and community activity.

This repository contains two approaches:

| Component | Implementation | Documentation |
| --- | --- | --- |
| **Primary: TypeScript / Node.js** | Express REST API with SQLite and content-based recommendations | [Setup and API](ts-nodejs/README.md), [Technical Design](ts-nodejs/docs/design.md) |
| **Experiment: Python ML** | Item-item collaborative filtering with training and offline evaluation | [Setup](ml/README.md), [Technical Design](ml/docs/design.md), [Evaluation](ml/docs/evaluation.md) |

## Why I tried two approaches

I wanted to explore whether machine learning could improve recommendations beyond a simpler, explainable scoring approach.

I first built the **TypeScript REST API** using users' interests, profile information, and Circle activity. I then experimented with **Python-based collaborative filtering** to see whether existing membership patterns could produce better recommendations.

On the synthetic dataset, the content-based approach performed better:

| Approach | Test Recall@5 |
| --- | ---: |
| Content-based recommendation | **0.2639** |
| Collaborative filtering | 0.1806 |

These results are based on 72 eligible held-out users. They measure historical membership reconstruction, not real-world joining behavior.

I kept the content-based approach as the primary API because it performed better in this experiment, provides understandable explanations, and does not require model training.

## A personal note

Lean In's mission of helping women grow in their careers through supportive communities is meaningful, and I was interested in how technology could make those connections easier.

I designed this solution to help members discover relevant and active Circles, avoid unavailable options, and understand why each Circle is recommended. With further development, a similar approach could support Circle discovery on Lean In Connect.

## How I used AI

I used **OpenAI Codex as a development assistant** for implementation, code review, test generation, edge-case analysis, and documentation.

I guided the technical decisions, reviewed the scoring and ranking behavior, tested API responses, and evaluated the ML experiment against the primary approach.

The primary recommendation API uses deterministic scoring and evidence-based explanations. It does not rely on an LLM at runtime.

## Repository structure

```text
README.md
ml/
  README.md
  docs/
  train.py
  model.py
  eval.py
  evaluate.py
  data.py
  metrics.py
  requirements.txt
  config.json
  tests/
ts-nodejs/
  README.md
  src/
  scripts/
  tests/
  docs/
  data/
  package.json
  package-lock.json
  generate.mjs
  Software Engineer at Lean In Assignment.pdf
```

## Primary API — Setup

**Requirements:** Node.js 22.14 or newer and npm. Python is not required.

From the repository root, run in Windows PowerShell:

```powershell
Set-Location ts-nodejs
npm.cmd ci
npm.cmd run seed
npm.cmd run build
npm.cmd start
```

The API runs at `http://localhost:3000` by default.

In another terminal, test the recommendation endpoint:

```powershell
Invoke-RestMethod 'http://localhost:3000/users/7/recommendations?limit=5' | ConvertTo-Json -Depth 5
```

The database is populated from the five supplied JSON datasets. Setup instructions, API examples, configuration, and error handling are documented in the [TypeScript API README](ts-nodejs/README.md).

## Python ML experiment

The optional ML experiment uses historical Circle memberships to calculate item-item affinity.

It provides:
- Model training and saved-model inference.
- Validation and test evaluation.
- A comparison with the primary content-based recommender.
- Evaluation metrics including Recall@K, NDCG@K, and recommendation coverage.

The experiment uses a TypeScript bridge for eligibility checks, baseline recommendations, and explanations. It does not require an HTTP server, and it is not part of the primary REST API's serving path.

See [ML Setup](ml/README.md) and [Evaluation Results](ml/docs/evaluation.md).

## Testing and validation

From the repository root, after installing the required dependencies:

**TypeScript API:**

```powershell
npm.cmd --prefix ts-nodejs run typecheck
npm.cmd --prefix ts-nodejs test
npm.cmd --prefix ts-nodejs run build
npm.cmd --prefix ts-nodejs run verify:compiled
```

**Python ML experiment:**

```powershell
.\ml\.venv\Scripts\python.exe -m unittest discover -s ml/tests -v
```

Python environment setup and model reproduction instructions are available in [ml/README.md](ml/README.md).

Generated databases, virtual environments, trained model artifacts, and raw evaluation reports are excluded from Git. The evaluation summary is included in the repository documentation.
