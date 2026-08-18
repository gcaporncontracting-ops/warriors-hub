# API Reference — Mock Roster

Base URL: `https://warriors-hub-production.gcaporncontracting.workers.dev`

All request/response bodies are JSON. All responses set
`content-type: application/json` and `cache-control: no-store`.

---

## `POST /api/admin/populate-mock-roster`

Creates a new mock game fixture and a randomised squad for a grade.

### Auth
Requires `passcode` matching the `ADMIN_PASSCODE` secret.

### Request body

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `passcode` | string | ✅ | — | Must match `env.ADMIN_PASSCODE` |
| `grade` | string | ✅ | — | Free text, matched against `player_directory.grades` / `games.grade` |
| `squadSize` | integer | — | `17` | Must be 1–161 |
| `includeSlug` | string | — | — | A `player_directory.slug` guaranteed a spot on the squad |
| `force` | boolean | — | `false` | Allow creating a new mock game even if an open one already exists for this grade |

### Example

```bash
curl -X POST https://warriors-hub-production.gcaporncontracting.workers.dev/api/admin/populate-mock-roster \
  -H "Content-Type: application/json" \
  -d '{
    "passcode": "Warriors-YE8899UE",
    "grade": "Thirds",
    "squadSize": 17,
    "includeSlug": "gavin-caporn"
  }'
```

### Success — `200`

```json
{
  "ok": true,
  "gameId": "c1a2b3c4-...",
  "grade": "Thirds",
  "squadSize": 17,
  "players": [
    { "id": "a1b2...", "name": "Gavin Caporn" },
    { "id": "c3d4...", "name": "Anthony Scarpuzza" }
  ],
  "message": "Mock roster created for Thirds with 17 players"
}
```

### Errors

| Status | Body | Cause |
|---|---|---|
| 400 | `{"error": "Invalid JSON body"}` | Malformed request |
| 400 | `{"error": "grade is required"}` | Missing `grade` |
| 400 | `{"error": "squadSize must be an integer between 1 and 161"}` | Bad `squadSize` |
| 400 | `{"error": "An open mock roster already exists for this grade", "grade", "gameId", "hint"}` | Duplicate guard triggered; pass `force: true` or clear first |
| 400 | `{"error": "No player found in player_directory with slug \"...\""}` | `includeSlug` doesn't exist |
| 401 | `{"error": "Invalid passcode"}` | Wrong/missing passcode |
| 500 | `{"error": "Server error", "details": "..."}` | DB failure — game/player rows are rolled back best-effort |

---

## `GET /api/teams/{grade}`

Reads back the most recently created game (and its squad) for a grade — mock or
PlayHQ-synced, whichever is newer.

### Auth
None — public, matching the rest of the hub's read endpoints.

### Example

```bash
curl https://warriors-hub-production.gcaporncontracting.workers.dev/api/teams/Thirds
```

### Success — `200`, roster exists

```json
{
  "ok": true,
  "grade": "Thirds",
  "game": {
    "id": "c1a2b3c4-...",
    "grade": "Thirds",
    "home_team": "Warriors",
    "away_team": "Randomised Mock Opposition",
    "game_date_time": "2026-08-18 05:04:03",
    "status": "open",
    "is_mock": 1,
    "created_at": "2026-08-18 05:04:03"
  },
  "players": [ { "id": "...", "name": "Gavin Caporn" }, ... ],
  "playerCount": 17,
  "lastUpdated": "2026-08-18 05:04:03"
}
```

### Success — `200`, no roster found

```json
{
  "ok": true,
  "grade": "Thirds",
  "game": null,
  "players": [],
  "message": "No roster found for this grade"
}
```

---

## `POST /api/admin/clear-mock-roster`

Deletes mock game(s) and their squads for a grade. **Only ever deletes rows where
`is_mock = 1`** — a real, PlayHQ-synced game is never affected, even if its `gameId` is
passed explicitly.

### Auth
Requires `passcode` matching the `ADMIN_PASSCODE` secret.

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `passcode` | string | ✅ | Must match `env.ADMIN_PASSCODE` |
| `grade` | string | ✅ | Which grade to clear |
| `gameId` | string | — | Clear one specific mock game; omit to clear **all** open mock games for the grade |

### Example — clear everything for a grade

```bash
curl -X POST https://warriors-hub-production.gcaporncontracting.workers.dev/api/admin/clear-mock-roster \
  -H "Content-Type: application/json" \
  -d '{"passcode": "Warriors-YE8899UE", "grade": "Thirds"}'
```

### Success — `200`

```json
{
  "ok": true,
  "grade": "Thirds",
  "gamesCleared": 1,
  "playersCleared": 17,
  "message": "Cleared 1 mock game(s) and 17 player row(s) for Thirds"
}
```

### Success — `200`, nothing to clear

```json
{
  "ok": true,
  "grade": "Thirds",
  "gamesCleared": 0,
  "playersCleared": 0,
  "message": "No mock roster found to clear"
}
```

### Errors

| Status | Body | Cause |
|---|---|---|
| 400 | `{"error": "Invalid JSON body"}` | Malformed request |
| 400 | `{"error": "grade is required"}` | Missing `grade` |
| 401 | `{"error": "Invalid passcode"}` | Wrong/missing passcode |
| 500 | `{"error": "Server error", "details": "..."}` | DB failure |

---

## Error format convention

Every error response is `{"error": "<message>"}`, optionally with extra context fields
(`grade`, `gameId`, `hint`, `details`). Every success response includes `"ok": true` (or,
for the populate endpoint, is implicitly successful at `200`).
