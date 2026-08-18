# D1 Schema — Tables Used by Mock Roster

**Database:** `warriors-hub` (binding `DB`)
**Database ID:** `050e6010-0ba6-400f-a64d-30b3f1168b78`
**Verified live:** 2026-08-18

This is the schema as it actually exists in production, pulled directly from
`sqlite_master`. It differs from the schema described in the original
`PHASE1-INTEGRATION-GUIDE.md` — see `CHANGELOG.md` for specifics. Treat this file, not
the old Phase 1 doc, as the source of truth.

---

## `player_directory`

The canonical list of all 161 players. This feature only **reads** from this table.

```sql
CREATE TABLE player_directory (
  slug TEXT PRIMARY KEY,
  internal_id TEXT,
  full_name TEXT NOT NULL,
  pin TEXT,
  playhq_uid TEXT,
  grades TEXT NOT NULL DEFAULT '[]',
  match_status TEXT NOT NULL DEFAULT 'matched',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

Notes:
- `slug` is the primary key — no separate autoincrement `id` column, unlike the old
  Phase 1 spec.
- `grades` is a JSON-encoded array stored as text, e.g. `["Thirds", "Reserves"]`.
  There's no dedicated join table — a player's grades live inline on their directory row.
- `pin` is the player's 4-digit login PIN — irrelevant to this feature, don't touch it.

---

## `games`

One row per fixture — mock or PlayHQ-synced.

```sql
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  player_hq_game_id TEXT,
  grade TEXT NOT NULL,
  home_team TEXT,
  away_team TEXT,
  game_date_time TEXT,
  status TEXT NOT NULL DEFAULT 'open',      -- open | locked | closed
  is_mock INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  starting_jackpot REAL DEFAULT 0,
  final_prize_pool REAL DEFAULT 0,
  winning_player_id TEXT REFERENCES players(id),
  result_status TEXT DEFAULT 'pending',
  payment_deadline_at TEXT,
  status_bucket TEXT DEFAULT 'PRE_GAME',
  home_score INTEGER,
  away_score INTEGER,
  venue TEXT
)
```

Notes for this feature:
- `id` is a `TEXT` UUID, generated app-side (`crypto.randomUUID()`) — **not**
  autoincrement, unlike the old Phase 1 spec.
- `is_mock = 1` is the flag this feature relies on for the clear endpoint's safety
  guarantee. Real PlayHQ syncs should always write `is_mock = 0`.
- The jackpot/prize/result columns belong to First Goal Scorer (Worker 3) — this feature
  never writes to them, only leaves them at their defaults.

---

## `players`

The squad for a given game — one row per player per fixture.

```sql
CREATE TABLE players (
  id TEXT PRIMARY KEY,
  player_hq_id TEXT,
  name TEXT NOT NULL,
  grade TEXT NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id),
  is_private INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  removed_from_wheel INTEGER NOT NULL DEFAULT 0
)
```

Notes for this feature:
- **No foreign key to `player_directory`.** `name` is copied in directly at insert time —
  there is no `player_slug` column, despite the old Phase 1 spec describing one. This
  means renaming a player in `player_directory` after a roster is generated will **not**
  retroactively update `players.name` for existing rosters.
- `id` is a fresh `TEXT` UUID per row, unrelated to `player_directory.slug`.
- `removed_from_wheel` belongs to Worker 4 (Training Wheel) — this feature always inserts
  `0` and never touches it afterward.

---

## Relationships this feature relies on

```
player_directory (161 rows, source of truth for names)
        |
        | (read-only; name copied by value, not referenced)
        v
   games  1 ---- * players
   (is_mock flag        (grade + game_id,
    distinguishes         no FK back to
    mock vs real)         player_directory)
```

---

## Queries this feature runs

| Operation | Table(s) | Notes |
|---|---|---|
| Check for existing open mock game | `games` | `WHERE grade = ? AND is_mock = 1 AND status = 'open'` |
| Validate `includeSlug` | `player_directory` | `WHERE slug = ?` |
| Insert fixture | `games` | New UUID, `is_mock = 1`, `status = 'open'` |
| Insert guaranteed player | `players` ← `player_directory` | `SELECT ... FROM player_directory WHERE slug = ?` |
| Insert random squad fill | `players` ← `player_directory` | `ORDER BY RANDOM() LIMIT ?`, excludes `includeSlug` if set |
| Read roster back | `games`, `players` | Most recent `games` row for the grade, joined by `game_id` |
| Clear roster | `players`, `games` | Both scoped to `is_mock = 1`; players deleted before games (FK order) |
