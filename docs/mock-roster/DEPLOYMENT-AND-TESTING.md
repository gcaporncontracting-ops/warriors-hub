# Deployment & Testing — Mock Roster

---

## Pre-deploy checklist

- [ ] Read `SCHEMA.md` — confirm the live D1 schema hasn't drifted further since 2026-08-18
- [ ] `mock-roster-endpoint.js` copied into `warriors-hub-production/src/`
- [ ] Routes wired per `MOCK-ROSTER-BUTTON-INTEGRATION.md`:
  - [ ] `POST /api/admin/populate-mock-roster`
  - [ ] `GET /api/teams/:grade`
  - [ ] `POST /api/admin/clear-mock-roster`
- [ ] Front-end Generate + Clear buttons added to the admin overlay, gated behind the
      existing `clfc_hub_admin_pass` localStorage passcode
- [ ] Clear button has a `confirm()` prompt — it's destructive
- [ ] `env.ADMIN_PASSCODE` secret confirmed live (fallback in code is `Warriors-YE8899UE`,
      but don't rely on the fallback — set the real secret)
- [ ] No changes needed to `wrangler.toml` — reuses the existing `DB` binding

## Deploy

```bash
cd warriors-hub-production
npx wrangler deploy --env production
```

Watch logs during first live use:

```bash
npx wrangler tail --env production
```

---

## Full test suite

Run in order. Each test assumes the grade `Thirds` is clear before Test 1 — Test 6 handles
that, but if you're starting fresh, run Test 6 first regardless of its expected "nothing to
clear" result, just to be safe.

### Test 1 — Generate a roster (happy path)

```bash
curl -s -X POST https://warriors-hub-production.gcaporncontracting.workers.dev/api/admin/populate-mock-roster \
  -H "Content-Type: application/json" \
  -d '{
    "passcode": "Warriors-YE8899UE",
    "grade": "Thirds",
    "squadSize": 17,
    "includeSlug": "gavin-caporn"
  }' | jq .
```

**Pass criteria:** `ok: true`, `squadSize: 17`, `players` array contains "Gavin Caporn".

---

### Test 2 — Duplicate guard

Run Test 1 again immediately, without `force`.

**Pass criteria:** `HTTP 400`, `error: "An open mock roster already exists for this grade"`,
response includes the existing `gameId`.

---

### Test 3 — Force override

```bash
curl -s -X POST https://warriors-hub-production.gcaporncontracting.workers.dev/api/admin/populate-mock-roster \
  -H "Content-Type: application/json" \
  -d '{"passcode": "Warriors-YE8899UE", "grade": "Thirds", "force": true}' | jq .
```

**Pass criteria:** `ok: true` — a second mock game now exists for `Thirds` alongside the first.
Clean up with Test 6 afterward (it clears all open mock games for a grade, not just one).

---

### Test 4 — Read it back

```bash
curl -s https://warriors-hub-production.gcaporncontracting.workers.dev/api/teams/Thirds | jq .
```

**Pass criteria:** `game` populated, `players` array present, `playerCount` matches the
squad size from the most recently created game.

---

### Test 5 — Auth failure

```bash
curl -s -X POST https://warriors-hub-production.gcaporncontracting.workers.dev/api/admin/populate-mock-roster \
  -H "Content-Type: application/json" \
  -d '{"passcode": "wrong", "grade": "Thirds"}' -w "\nHTTP %{http_code}\n"
```

**Pass criteria:** `HTTP 401`, `error: "Invalid passcode"`.

---

### Test 6 — Bad slug

```bash
curl -s -X POST https://warriors-hub-production.gcaporncontracting.workers.dev/api/admin/populate-mock-roster \
  -H "Content-Type: application/json" \
  -d '{"passcode": "Warriors-YE8899UE", "grade": "Thirds", "includeSlug": "not-a-real-player", "force": true}' \
  -w "\nHTTP %{http_code}\n"
```

**Pass criteria:** `HTTP 400`, no new game row created (verify with Test 4 — count
shouldn't have changed).

---

### Test 7 — Clear the mock roster

```bash
curl -s -X POST https://warriors-hub-production.gcaporncontracting.workers.dev/api/admin/clear-mock-roster \
  -H "Content-Type: application/json" \
  -d '{"passcode": "Warriors-YE8899UE", "grade": "Thirds"}' | jq .
```

**Pass criteria:** `ok: true`, `gamesCleared` and `playersCleared` both greater than 0
(should clear everything left over from Tests 1–3 in one call, since it clears *all* open
mock games for the grade when `gameId` is omitted).

---

### Test 8 — Clear is idempotent

Run Test 7 again immediately.

**Pass criteria:** `ok: true`, `gamesCleared: 0`, `playersCleared: 0`,
`message: "No mock roster found to clear"`.

---

### Test 9 — Clear never touches real data (critical — do not skip)

1. Manually insert (or sync via PlayHQ once fixed) a real game row with `is_mock = 0` for
   some grade.
2. Run `clear-mock-roster` against that same grade.
3. **Pass criteria:** `gamesCleared: 0`, `playersCleared: 0` — the real game must still be
   present in `games` afterward. Confirm with a direct D1 query:
   ```sql
   SELECT id, grade, is_mock FROM games WHERE grade = '<grade>';
   ```
   The real row must still be there.

This is the guardrail against the clear button ever wiping a genuine match-day roster —
treat a failure here as a release blocker.

---

### Test 10 — Full cycle via the actual button (manual, in-browser)

1. Open the hub, tap the hidden ADMIN link, enter the passcode.
2. Select a grade, click **Generate Mock Roster** — confirm the status message and that
   `GET /api/teams/{grade}` (Test 4) reflects it.
3. Click **Clear Mock Roster**, confirm the `confirm()` dialog appears, accept it — confirm
   the status message and that the roster is gone.

---

## Post-deploy monitoring

```bash
npx wrangler tail --env production --format json | jq .
```

Watch for:
- `500` responses (DB errors — check D1 dashboard for quota/connectivity issues)
- Repeated `401`s (passcode misconfigured on the front end, or a stale cached value in
  `localStorage`)
- Any request hitting `clear-mock-roster` with a `gameId` for a game where `is_mock = 0` —
  should always no-op per Test 9, but worth watching the first few times live
