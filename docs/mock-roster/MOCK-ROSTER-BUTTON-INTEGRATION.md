# Mock Roster Button: Integration Guide

**Status:** Ready to integrate into `warriors-hub-production`
**Timestamp:** 2026-08-18
**Author:** Claude
**Supersedes:** The "populate-mock-roster" section of `PHASE1-INTEGRATION-GUIDE.md` — that
doc described a `player_slug`-keyed schema with autoincrement ids that does **not** match
what's actually live in D1. This guide matches the real, live schema.

---

## Why this doc exists

Verified live on 2026-08-18:

- `POST /api/admin/populate-mock-roster` returns **HTTP 404** on `warriors-hub-production` —
  it was never actually deployed there, despite being marked "COMPLETE & DEPLOYED" in
  `STATUS-REPORT-AND-NEXT-STEPS.md`.
- There is **no Teams / Mock Roster button** anywhere on the live hub `index.html`.
- The live D1 schema for `games` / `players` uses `TEXT` UUID primary keys and different
  column names than the original Phase 1 spec (`is_mock`, `home_team`/`away_team`,
  no `player_slug` foreign key — `players.name` is stored directly).

This guide + the accompanying `mock-roster-endpoint.js` bring the feature in line with
what's actually deployed, so the button has something real to call.

---

## What it does

Admin taps **"Mock Roster"** → picks a grade → hits the button → the worker:

1. Confirms the passcode.
2. Optionally guarantees a specific player (e.g. `gavin-caporn`) a spot on the squad.
3. Randomly fills the rest of the squad from `player_directory` (161 players).
4. Writes a new row to `games` (`is_mock = 1`) and the matching squad to `players`.
5. Returns the roster so the front end can render it immediately without a second request.

A companion `GET /api/teams/:grade` is included because the hub currently has **no way to
read a roster back out** once created — without it, the button would write data nobody
could ever see.

A companion `POST /api/admin/clear-mock-roster` is also included so a stale mock roster
can be cleared from the button itself, instead of requiring direct D1 access every time.
It only ever deletes rows where `is_mock = 1` — a real PlayHQ-synced game is never touched
by this endpoint, even if you pass its `gameId` by mistake.

---

## Step 1: Add the endpoint file

Copy `mock-roster-endpoint.js` into the Worker 1 source tree:

```
warriors-hub-production/
└── src/
    ├── worker.js                  # existing entrypoint
    └── mock-roster-endpoint.js    # new
```

## Step 2: Import into the main worker

In `src/worker.js`:

```javascript
import {
  handlePopulateMockRoster,
  handleGetTeams,
  handleClearMockRoster
} from './mock-roster-endpoint.js';
```

## Step 3: Wire up the routes

Add these near the top of the `fetch` handler, alongside the existing `/api/...` checks
(before the `env.ASSETS.fetch(request)` fallback at the bottom):

```javascript
if (url.pathname === '/api/admin/populate-mock-roster' && request.method === 'POST') {
  return handlePopulateMockRoster(request, env);
}

const teamsMatch = url.pathname.match(/^\/api\/teams\/([a-zA-Z0-9-]+)$/);
if (teamsMatch && request.method === 'GET') {
  return handleGetTeams(request, env, decodeURIComponent(teamsMatch[1]));
}

if (url.pathname === '/api/admin/clear-mock-roster' && request.method === 'POST') {
  return handleClearMockRoster(request, env);
}
```

No changes to `wrangler.toml` are needed — this reuses the existing `DB` binding
(`050e6010-0ba6-400f-a64d-30b3f1168b78`) and the existing `ADMIN_PASSCODE` secret already
set on this worker.

---

## Step 4: Add the front-end button

Add a card/button to `public/index.html` (or the admin overlay) — this example drops it
inside the existing `pinAdminOverlay` block so it's gated behind the same admin passcode
already stored in `localStorage`:

```html
<div id="mockRosterSection" style="margin-top:24px;padding-top:16px;border-top:1px solid rgba(255,255,255,.15);">
  <h4 style="color:#fff;font-family:'JetBrains Mono',monospace;font-size:13px;">Mock Roster</h4>
  <select id="mockRosterGrade" style="margin:8px 0;padding:6px;">
    <option value="League">League</option>
    <option value="Reserves">Reserves</option>
    <option value="Colts">Colts</option>
    <option value="Thirds">Thirds</option>
    <option value="U18">U18</option>
  </select>
  <button id="mockRosterBtn" type="button" style="padding:8px 16px;">Generate Mock Roster</button>
  <button id="clearMockRosterBtn" type="button" style="padding:8px 16px;background:#d62828;color:#fff;border:none;border-radius:6px;">Clear Mock Roster</button>
  <div id="mockRosterStatus" style="margin-top:8px;font-size:12px;color:rgba(255,255,255,.7);"></div>
</div>

<script>
  document.getElementById('mockRosterBtn').addEventListener('click', async () => {
    const grade = document.getElementById('mockRosterGrade').value;
    const status = document.getElementById('mockRosterStatus');
    const pass = localStorage.getItem('clfc_hub_admin_pass');

    status.textContent = 'Generating…';
    try {
      const res = await fetch('/api/admin/populate-mock-roster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          passcode: pass,
          grade,
          squadSize: 17,
          includeSlug: 'gavin-caporn'   // optional: remove to skip the guaranteed-spot behaviour
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate roster');
      status.textContent = `✅ ${data.message}`;
    } catch (err) {
      status.textContent = `❌ ${err.message}`;
    }
  });

  document.getElementById('clearMockRosterBtn').addEventListener('click', async () => {
    const grade = document.getElementById('mockRosterGrade').value;
    const status = document.getElementById('mockRosterStatus');
    const pass = localStorage.getItem('clfc_hub_admin_pass');

    if (!confirm(`Clear the mock roster for ${grade}? This can't be undone.`)) return;

    status.textContent = 'Clearing…';
    try {
      const res = await fetch('/api/admin/clear-mock-roster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: pass, grade })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to clear roster');
      status.textContent = `✅ ${data.message}`;
    } catch (err) {
      status.textContent = `❌ ${err.message}`;
    }
  });
</script>
```

Adjust the `<select>` options to match whatever grade strings are actually used in your
`player_directory.grades` values (currently seen live: `"Thirds"`, `"Reserves"` — confirm
the rest before wiring the dropdown).

---

## Step 5: Deploy

```bash
cd warriors-hub-production
npx wrangler deploy --env production
```

---

## Testing

### Test 1 — Generate a roster (happy path)

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

Expected:
```json
{
  "ok": true,
  "gameId": "...",
  "grade": "Thirds",
  "squadSize": 17,
  "players": [ { "id": "...", "name": "Gavin Caporn" }, ... ],
  "message": "Mock roster created for Thirds with 17 players"
}
```

### Test 2 — Duplicate guard

Run the same request again without `"force": true` — expect `HTTP 400`:
```json
{
  "error": "An open mock roster already exists for this grade",
  "grade": "Thirds",
  "gameId": "..."
}
```

### Test 3 — Read it back

```bash
curl https://warriors-hub-production.gcaporncontracting.workers.dev/api/teams/Thirds
```

Expected: `game` populated, `players` array with 17 entries, `playerCount: 17`.

### Test 4 — Auth failure

```bash
curl -X POST https://warriors-hub-production.gcaporncontracting.workers.dev/api/admin/populate-mock-roster \
  -H "Content-Type: application/json" \
  -d '{"passcode": "wrong", "grade": "Thirds"}'
```

Expected: `HTTP 401 {"error": "Invalid passcode"}`.

### Test 5 — Bad slug

```bash
curl -X POST https://warriors-hub-production.gcaporncontracting.workers.dev/api/admin/populate-mock-roster \
  -H "Content-Type: application/json" \
  -d '{"passcode": "Warriors-YE8899UE", "grade": "Thirds", "includeSlug": "not-a-real-player"}'
```

Expected: `HTTP 400`, no game row created (checked before insert).

### Test 6 — Clear the mock roster

```bash
curl -X POST https://warriors-hub-production.gcaporncontracting.workers.dev/api/admin/clear-mock-roster \
  -H "Content-Type: application/json" \
  -d '{"passcode": "Warriors-YE8899UE", "grade": "Thirds"}'
```

Expected:
```json
{
  "ok": true,
  "grade": "Thirds",
  "gamesCleared": 1,
  "playersCleared": 17,
  "message": "Cleared 1 mock game(s) and 17 player row(s) for Thirds"
}
```

Run it again immediately after — expect `gamesCleared: 0, playersCleared: 0` since there's
nothing left to clear. Then re-run Test 1: it should succeed without the duplicate-guard
error, confirming the clear actually freed up the grade.

### Test 7 — Clear never touches real data

Sync a real PlayHQ roster for a grade (`is_mock = 0`), then run Test 6 against that grade.
Expected: `gamesCleared: 0, playersCleared: 0` — the `is_mock = 1` filter must exclude it.
This is the one test worth never skipping; it's the guardrail against the clear button
ever wiping a genuine match-day roster.

---

## Deployment checklist

- [ ] `mock-roster-endpoint.js` added to `src/`
- [ ] Import + three routes wired into `worker.js` (populate, teams, clear)
- [ ] Front-end Generate + Clear buttons added, gated behind the existing admin passcode overlay
- [ ] Clear button has a confirm() prompt before it fires — this is a destructive action
- [ ] Deployed: `npx wrangler deploy --env production`
- [ ] Test 1–7 above all pass, especially Test 7 (clear never touches `is_mock = 0` rows)
- [ ] The manually-created test game (grade `Thirds`, id
      `45f120e8-b57f-4f85-8317-d6315a6ad561`) has already been cleared as of 2026-08-18 —
      no action needed there

---

## Known follow-ups (not in scope here)

- **Grade string consistency** — confirm the exact set of grade values used across
  `player_directory.grades`, `games.grade`, and the voting worker's `/vote/{grade}` routes
  (`league`, `reserves`, `colts`, `thirds` lowercase there vs `"Thirds"` in the directory) —
  these currently don't match casing, which will break any code that compares them directly.
- **PlayHQ sync** (`warriors-sync` / `/api/sync/playerhq`) is a separate, still-broken path
  (PlayHQ API returns 404 for the stored team IDs) — not fixed by this doc.
