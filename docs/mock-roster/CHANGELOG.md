# Changelog — Mock Roster Feature

## 2026-08-18 — Initial build, corrected against live infra

### Context

The original `PHASE1-INTEGRATION-GUIDE.md` described a `populate-mock-roster` endpoint
and schema that was never actually deployed to `warriors-hub-production` — confirmed by a
live `HTTP 404` on that endpoint. The schema it described also doesn't match what's live
in D1. This feature is a clean-room rebuild against the real, verified infrastructure.

### What was verified live before writing any code

- `POST /api/admin/populate-mock-roster` → `404` on `warriors-hub-production` (not deployed)
- `player_directory` has 161 rows, keyed by `slug TEXT PRIMARY KEY` (not an autoincrement
  `id` with a separate unique `slug` column, as the old docs described)
- `games` and `players` use `TEXT` UUID primary keys, not `INTEGER PRIMARY KEY AUTOINCREMENT`
- `players.name` is stored directly — **there is no `player_slug` foreign key** to
  `player_directory`, contradicting the old schema doc
- `games` has an `is_mock INTEGER` flag and richer columns (`status_bucket`, prize/jackpot
  fields for First Goal Scorer) not mentioned in the old docs
- The live hub `index.html` has **no Teams button, no Sync button, and no Mock Roster
  button** anywhere on the page — the admin surface only covers PIN requests and notices
- The confirmed live admin passcode is `Warriors-YE8899UE` (hardcoded as the in-code
  fallback on `warriors-hub-production`) — the older docs' `Warriors-Kick-9247` is stale
- `warriors-sync`'s `/api/sync/playerhq` is reachable and passcode-protected correctly, but
  the PlayHQ API itself returns `404` for the stored team ID (`696edf4b` for Thirds) — sync
  is not currently functional end-to-end

### What was built

- `handlePopulateMockRoster` — generates a randomised squad, with an optional guaranteed
  slot for a named player (`includeSlug`), targeting the real live schema
- `handleGetTeams` — read-back endpoint; did not exist live in any form before this
- `handleClearMockRoster` — added after initial build, once it became clear there was no
  way to remove a stale mock roster other than raw D1 `DELETE` statements. Scoped strictly
  to `is_mock = 1` rows as a safety guarantee against ever deleting real PlayHQ data

### Manual testing performed before the endpoint existed

Before any code was written, the exact behaviour of `populate-mock-roster` was proven out
by hand directly against D1:
1. Created a mock game for grade `Thirds` (`is_mock = 1`)
2. Inserted `gavin-caporn` as a guaranteed player
3. Randomly filled 16 more from `player_directory`
4. Verified the 17-player squad by query

That manually-created test data (game id `45f120e8-b57f-4f85-8317-d6315a6ad561`) was
cleared from D1 the same day, once the clear logic was proven — no leftover test data
remains as of this changelog.

### Known open issues carried forward

- Grade string casing is inconsistent across the ecosystem (`"Thirds"` in
  `player_directory` vs. `thirds` in the voting worker's routes) — not fixed by this
  feature, just documented
- PlayHQ sync remains broken independent of this work
- No UI currently exists on the live hub to reach any of this without the integration
  steps in `MOCK-ROSTER-BUTTON-INTEGRATION.md` being carried out

---

## 2026-08-18 (later same day) — Grade-casing claim corrected; real mismatch found and reconciled

### Correction

The "grade casing mismatch" flagged above was wrong. Pulling the actual live worker code
for `warriors-vote-v2(-production)` and `clfc-first-goal-scorer-production` showed both
hardcode `ACTIVE_GRADES = ["League", "Reserves", "Colts", "Thirds"]` — Title Case,
identical to `player_directory.grades` and to this feature's own `grade` values. The
lowercase `/vote/thirds` seen in the hub's link is a URL path segment only, not the `grade`
value compared in any API call. There was nothing to fix here.

### The real mismatch: two independent mock-roster implementations

While verifying the above, a second, already-deployed mock-roster feature was found:
`POST /api/admin/create-mock-game` on `clfc-first-goal-scorer-production`. It predates
this repo's work and was unknown when this feature was first built. It wrote to the same
`games`/`players` D1 tables (`is_mock = 1`) but sourced player names from
`VOTES_KV.gradelist:{grade}` instead of `player_directory` — a second, silently
duplicated identity source, contradicting the project's own stated goal of
`player_directory` being the single canonical source.

**Resolution:** `mockGetPlayersForGrade()` on the FGS worker was repointed to query
`player_directory` directly, filtered by grade membership — see
`FGS-RECONCILIATION-PATCH.md` for the full before/after. `EXPECTED_PLAYERS = 22` and all
other FGS game logic (spins, entries, payments, jackpots) were left untouched; only the
name source changed.

**By design, left unreconciled:**
- `VOTES_KV.gradelist:{grade}` itself is untouched — it's still the real source for
  Player's Player voting, populated by genuine PlayHQ syncs, and is a legitimately
  separate concern from mock-roster generation.
- The two endpoints (`/api/admin/create-mock-game` on FGS,
  `/api/admin/populate-mock-roster` on the Hub) still exist as two separate calls rather
  than one shared endpoint. They now agree on *who's eligible* but still write
  independently. Fully unifying them would require one worker calling the other over
  the network — treated as a follow-up, not part of this fix.

### Admin passcode drift — explicitly left alone

`clfc-first-goal-scorer-production` still runs on `Warriors-Kick-9247` while
`warriors-hub-production` / `warriors-vote-v2` run on `Warriors-YE8899UE`. Per explicit
instruction, passcodes were left as-is and not synchronised as part of this pass.
