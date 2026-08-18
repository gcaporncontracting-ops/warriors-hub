# Patch: `clfc-first-goal-scorer-production` — mock roster source reconciliation

**Target file:** `src/worker.js` on `clfc-first-goal-scorer-production`
**Function:** `mockGetPlayersForGrade`
**Why:** This worker's `/api/admin/create-mock-game` currently pulls names from
`VOTES_KV` key `gradelist:{grade}` — a list that only exists once PlayHQ sync has run at
least once for that grade. This duplicates identity data outside `player_directory`,
which the project has already established as the single canonical source (see repo
`CHANGELOG.md` / root project notes). It also means FGS's mock roster and the Hub's mock
roster (`mock-roster-endpoint.js`) can silently disagree — different player pools, no
shared source of truth.

**What does NOT change:** `EXPECTED_PLAYERS = 22` stays exactly as-is — FGS relies on this
constant both to cap the squad and to reject a sync that returned too few players
(`Only found N players for {grade} — need 22.`). Only the *source* of names changes, not
the count or any other FGS game logic (spins, entries, jackpots, payments are untouched).

---

## Before

```javascript
async function mockGetPlayersForGrade(env, grade) {
  const raw = await env.VOTES_KV.get(`gradelist:${grade}`);
  const roster = raw ? JSON.parse(raw) : [];
  const shuffled = [...roster];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = secureRandomIndex(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(EXPECTED_PLAYERS, shuffled.length));
}
```

## After

```javascript
async function mockGetPlayersForGrade(env, grade) {
  // Reconciled 2026-08-18: was reading VOTES_KV `gradelist:{grade}`, which only
  // exists after a PlayHQ sync has run and duplicates identity data outside
  // player_directory. Now reads directly from the canonical D1 table, matching
  // the Hub's mock-roster-endpoint.js so both features draw from the same pool.
  const { results } = await env.DB.prepare(
    `SELECT full_name FROM player_directory`
  ).all();

  const inGrade = results.filter((row) => {
    try {
      return JSON.parse(row.grades || '[]').includes(grade);
    } catch {
      return false;
    }
  });

  // NOTE: the query above needs `grades` selected too — see corrected version below.
  const names = inGrade.map((row) => row.full_name);

  const shuffled = [...names];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = secureRandomIndex(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(EXPECTED_PLAYERS, shuffled.length));
}
```

**Corrected — select `grades` in the query** (the draft above filters on a column it
never selected; this is the version to actually paste in):

```javascript
async function mockGetPlayersForGrade(env, grade) {
  // Reconciled 2026-08-18: was reading VOTES_KV `gradelist:{grade}`, which only
  // exists after a PlayHQ sync has run and duplicates identity data outside
  // player_directory. Now reads directly from the canonical D1 table, matching
  // the Hub's mock-roster-endpoint.js so both features draw from the same pool.
  const { results } = await env.DB.prepare(
    `SELECT full_name, grades FROM player_directory`
  ).all();

  const names = results
    .filter((row) => {
      try {
        return JSON.parse(row.grades || '[]').includes(grade);
      } catch {
        return false;
      }
    })
    .map((row) => row.full_name);

  const shuffled = [...names];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = secureRandomIndex(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(EXPECTED_PLAYERS, shuffled.length));
}
```

No other line in `create-mock-game` needs to change — it already just calls
`mockGetPlayersForGrade(env, grade)` and checks the returned array's length against
`EXPECTED_PLAYERS`.

---

## Verified compatible before writing this patch

- `player_directory.grades` is Title Case JSON (`["Thirds", "Reserves"]`), matching FGS's
  own `ACTIVE_GRADES = ["League", "Reserves", "Colts", "Thirds"]` exactly — no casing
  conversion needed.
- Directory currently holds 161 players, comfortably above `EXPECTED_PLAYERS = 22` for
  every grade with rows in the `player_directory` GROUP BY count checked 2026-08-18
  (League 21+, Reserves 28+, Colts 29+, Thirds 43+, counting multi-grade players too).
- `env.DB` is already bound on this worker (used throughout for `games`/`players`/
  `entries`/`audit_log`) — no new binding required.

---

## What this does NOT reconcile (deliberately out of scope)

- **Voting's `gradelist:{grade}` in VOTES_KV is untouched.** That list is populated by
  `syncGradeToVoting()` during a *real* PlayHQ sync and is what Player's Player voting
  actually reads from — it's a legitimate, separate concern from mock-roster generation
  and this patch does not touch it.
- **The two mock-roster endpoints still exist separately** — `POST
  /api/admin/create-mock-game` on FGS and `POST /api/admin/populate-mock-roster` on the
  Hub. They now draw from the same source and won't disagree on *who's available*, but
  they still write independently and don't share a game record. Fully merging them into
  one endpoint both workers call would mean cross-worker service calls (fetch from one
  Worker to another) — a bigger architectural change than "fix the mismatch" calls for
  today. Flagging it as the natural next step if you want one button instead of two.

---

## Deployment note (read before pushing)

`clfc-first-goal-scorer-production` handles **real money** — $5 League entries, jackpots,
payment tracking. This patch only touches the mock-game code path (`is_mock = 1`,
non-money) and doesn't go near entries, results, or payments. Still, it's a live
financial worker, so:

```bash
cd clfc-first-goal-scorer-production
npx wrangler deploy --env staging   # if you have one — verify create-mock-game first
npx wrangler deploy --env production
```

Test immediately after deploy:

```bash
curl -X POST https://clfc-first-goal-scorer-production.gcaporncontracting.workers.dev/api/admin/create-mock-game \
  -H "Content-Type: application/json" \
  -d '{"passcode": "Warriors-Kick-9247", "grade": "Thirds"}'
```

Expect `ok: true` with a `gameId` — then confirm the 22 names are ones you recognise as
real club players (not stale KV data), and confirm nothing on the money side (League
entries, jackpots) was touched by diffing `games`/`entries` row counts before and after.
