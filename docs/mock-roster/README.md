# Mock Roster — Warriors Hub Feature Docs

**Status:** Ready to integrate
**Lives behind:** The "Mock Roster" admin button (`warriors-hub-production`)
**Last verified against live infra:** 2026-08-18

---

## What this is

A self-contained feature that lets an admin generate a randomised match-day squad —
optionally guaranteeing a named player a spot — write it to the shared D1 database, view
it, and clear it. It exists so the roster-dependent parts of the ecosystem (voting, First
Goal Scorer) have real data to point at without waiting on PlayHQ sync, which is currently
broken (PlayHQ API returns 404 for the stored team IDs — see `CHANGELOG.md`).

This replaces the "populate-mock-roster" feature described in the old `PHASE1-*` docs,
which targeted a database schema that isn't what's actually live. Everything in this repo
has been verified directly against the live D1 database and live worker code as of
2026-08-18.

---

## Files in this repo

| File | Purpose |
|---|---|
| `README.md` | This file — orientation and quick start |
| `API-REFERENCE.md` | Full request/response spec for all three endpoints |
| `SCHEMA.md` | The live D1 tables this feature reads and writes |
| `mock-roster-endpoint.js` | The actual worker code — drop-in module |
| `MOCK-ROSTER-BUTTON-INTEGRATION.md` | Step-by-step: wiring the code + button into `warriors-hub-production` |
| `DEPLOYMENT-AND-TESTING.md` | Deploy steps and the full test suite |
| `CHANGELOG.md` | What changed vs. the original Phase 1 docs, and why |
| `FGS-RECONCILIATION-PATCH.md` | Before/after patch reconciling FGS's separate mock-roster feature onto `player_directory` |

---

## Quick start

1. Read `SCHEMA.md` first if you haven't touched this D1 database before — the column
   names differ from the original Phase 1 spec.
2. Copy `mock-roster-endpoint.js` into Worker 1's `src/`.
3. Follow `MOCK-ROSTER-BUTTON-INTEGRATION.md` to wire the three routes and the admin button.
4. Deploy and run the test suite in `DEPLOYMENT-AND-TESTING.md`.

---

## The three endpoints at a glance

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/admin/populate-mock-roster` | POST | Create a randomised squad for a grade |
| `/api/teams/{grade}` | GET | Read back the current roster for a grade |
| `/api/admin/clear-mock-roster` | POST | Delete a mock roster so a fresh one can be generated |

All admin (`POST`) routes require the `ADMIN_PASSCODE` secret already set on
`warriors-hub-production`. The `GET` route is public, matching the rest of the hub's
read endpoints.

---

## Known limitations

- **Two mock-roster code paths exist.** This feature (Hub, D1-sourced) and FGS's
  pre-existing `/api/admin/create-mock-game` now draw from the same canonical
  `player_directory` (see `FGS-RECONCILIATION-PATCH.md`), but they're still two separate
  endpoints that write independently rather than one shared implementation.
- **Admin passcode is not synchronised across workers**, by explicit decision —
  `clfc-first-goal-scorer-production` still runs `Warriors-Kick-9247` while the Hub and
  voting worker run `Warriors-YE8899UE`. Left as-is; not part of this feature's scope.
- **PlayHQ sync is separate and still broken.** This feature is not a replacement for it,
  just a stand-in until the PlayHQ team IDs / API path are fixed.
- **No pagination or squad-size validation beyond a hard 1–161 range.** Fine for a club of
  161 players; revisit if the directory grows dramatically.
