# Circle Recommendation REST API

Primary assignment implementation using Node.js, Express, TypeScript, SQLite,
Zod, and Vitest. The service returns available Circles in a deterministic order
with evidence-based, member-facing explanations.

[Technical design](docs/design.md) ? [Database](docs/database.md) ?
[Scoring](docs/scoring.md) ? [Selection](docs/diversity.md) ?
[Explanations](docs/explanations.md) ? [Dataset](data/README.md)

## Requirements

- Node.js 22.14 or newer; npm lockfile installation via `npm ci`.
- No external database server or Python runtime.
- Node.js 22.14 emits an experimental warning for its built-in `node:sqlite` module.

## Local setup

From the repository root in Windows PowerShell:

```powershell
Set-Location ts-nodejs
npm.cmd ci
npm.cmd run seed
npm.cmd run build
npm.cmd start
```

On macOS/Linux, use `npm` instead of `npm.cmd`. PowerShell can use `npm.cmd`
without modifying execution policy. The server listens on port 3000 by default;
Ctrl+C stops it. For source reloads, use `npm.cmd run dev` instead of building
and starting the compiled server.

Seeding validates all five JSON inputs and their references, then replaces the
snapshot in one transaction. Repeated imports produce the same records; failed
imports roll back. The server creates missing tables but does not import data.

| Environment variable | Default | Contract |
| --- | --- | --- |
| `PORT` | `3000` | Integer from 1 to 65535 |
| `DATABASE_PATH` | `.local/circles.sqlite` | SQLite file path, relative to `ts-nodejs/` when commands run there |

Environment variables are supplied through the process environment. Example:

```powershell
$env:PORT = '3001'
$env:DATABASE_PATH = '.local/development.sqlite'
npm.cmd run seed
npm.cmd run dev
```

## API

`GET /users/:userId/recommendations?limit=5`

- `userId`: positive safe integer in decimal notation, without leading zeros.
- `limit`: optional integer from 1 to 20; default 5.
- Responses contain up to the requested limit. An empty candidate pool returns
  HTTP 200 with `count: 0` and an empty array.
- Signs, fractions, whitespace, exponent/hex notation, repeated parameters, and
  unknown query parameters return HTTP 400.

```powershell
Invoke-RestMethod 'http://localhost:3000/health'
Invoke-RestMethod 'http://localhost:3000/users/7/recommendations?limit=1' | ConvertTo-Json -Depth 5
Invoke-RestMethod 'http://localhost:3000/users/42/recommendations?limit=5' | ConvertTo-Json -Depth 5
```

Equivalent HTTP request:

```sh
curl "http://localhost:3000/users/7/recommendations?limit=1"
```

Use `curl.exe` on Windows when invoking the curl executable. Example response:

```json
{
  "metadata": { "user_id": 7, "requested_limit": 1, "count": 1 },
  "recommendations": [
    {
      "rank": 1,
      "circle_id": 35,
      "name": "Board-Ready Women",
      "description": "A supportive circle for women focused on leadership skills.",
      "primary_topic": "leadership-skills",
      "format": "in_person",
      "join_policy": "open",
      "explanation": "Explore your interest in leadership skills with this Circle."
    }
  ]
}
```

`primary_topic` is a taxonomy slug or null. `description` is omitted when absent.
Formats are `in_person`, `virtual`, or `hybrid`; join policies are `open` or
`request`. Approval requirements are preserved in metadata and explanations.
Scores, profiles, and internal evidence are not part of the HTTP response.
Full responses: [user 7](docs/examples/user-7-recommendations.json),
[user 42](docs/examples/user-42-recommendations.json).

| HTTP status | Error code | Condition |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Invalid user ID, limit, or query parameters |
| 404 | `USER_NOT_FOUND` | No user with the supplied valid ID |
| 500 | `INTERNAL_ERROR` | Unexpected internal failure; details are not exposed |

Errors use `{ "error": { "code": "...", "message": "..." } }`.
`GET /health` returns HTTP 200 with `{ "status": "ok", "database": "ok" }`;
a database query failure returns HTTP 503. Health checks connectivity, not seed
completeness.

## Recommendation policy

Exclude existing memberships of either role, unlisted Circles, and full Circles.
Null capacity is unlimited. Approval-required and inactive public Circles remain
eligible. Relevance combines explicit interests, conservative bio inference, and
professional context with activity. Greedy selection reduces redundancy and
rewards coverage of distinct interests.

Scoring uses the fixed dataset reference `2026-09-21T00:00:00.000Z`. Dormancy
(90+ days without activity, zero feed posts, at most five chat messages) subtracts
80 points. Healthy Circles with purpose metadata receive one selection point
for non-cold-start users. Missing metadata remains eligible as fallback; neither
this adjustment nor cold-start selection invents personal interests or location
matches. Configuration and structured evidence are documented in the references.

## Tests and scripts

Run from `ts-nodejs/`:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run verify:compiled
```

Vitest covers database integrity, eligibility, scoring, diversity, explanations,
HTTP behavior, new records, and all seeded scenarios. Tests use isolated databases.
`verify:compiled` launches the built API on a temporary port with a disposable
snapshot and checks actual HTTP responses. It requires a build and permission to
start and stop its own child process.

| Script | Purpose |
| --- | --- |
| `dev` | Source server with automatic reload |
| `seed` | Validate and atomically replace the SQLite snapshot |
| `build` | Compile TypeScript and copy the SQL schema |
| `start` | Start the compiled Express server |
| `typecheck` | Check source, tests, and the offline bridge |
| `test`, `test:watch` | Run Vitest once or in watch mode |
| `verify:compiled` | Check the compiled API through HTTP |
| `ml:export` | Export validated data and full-pool evidence to `../ml/.local/snapshot.json` |

The [Python experiment](../ml/README.md) is an optional offline consumer of the
bridge. The API does not load model artifacts or invoke Python.
