// mock-roster-endpoint.js
//
// Backs the "Mock Roster" admin button on the Warriors Hub.
// Pulls a randomised match-day squad from `player_directory`, optionally
// guaranteeing a specific player (e.g. yourself) a spot, and writes it into
// the shared D1 `games` / `players` tables.
//
// Schema this targets (confirmed live in D1 `warriors-hub`, 2026-08-18):
//
//   games (
//     id TEXT PRIMARY KEY,
//     player_hq_game_id TEXT,
//     grade TEXT NOT NULL,
//     home_team TEXT,
//     away_team TEXT,
//     game_date_time TEXT,
//     status TEXT NOT NULL DEFAULT 'open',       -- open | locked | closed
//     is_mock INTEGER NOT NULL DEFAULT 1,
//     created_at TEXT NOT NULL DEFAULT (datetime('now')),
//     ... prize/result columns omitted, not touched here
//   )
//
//   players (
//     id TEXT PRIMARY KEY,
//     player_hq_id TEXT,
//     name TEXT NOT NULL,
//     grade TEXT NOT NULL,
//     game_id TEXT NOT NULL REFERENCES games(id),
//     is_private INTEGER NOT NULL DEFAULT 0,
//     active INTEGER NOT NULL DEFAULT 1,
//     removed_from_wheel INTEGER NOT NULL DEFAULT 0
//   )
//
//   player_directory (
//     slug TEXT PRIMARY KEY,
//     full_name TEXT NOT NULL,
//     grades TEXT NOT NULL DEFAULT '[]',
//     ...
//   )
//
// NOTE: This is a clean-room rewrite of the "populate-mock-roster" concept
// from the original Phase 1 docs. Those docs described a different schema
// (player_slug foreign keys, autoincrement ids) that does NOT match what is
// actually live. This file matches the real, live schema.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

function uid() {
  return crypto.randomUUID();
}

/**
 * POST /api/admin/populate-mock-roster
 *
 * Body:
 * {
 *   "passcode": "Warriors-YE8899UE",   // required
 *   "grade": "Thirds",                 // required — must match a grade string used in player_directory.grades / games.grade
 *   "squadSize": 17,                   // optional, default 17
 *   "includeSlug": "gavin-caporn",     // optional — guarantees this player a spot
 *   "force": false                     // optional — allow creating a new mock game even if an open one exists for this grade
 * }
 */
export async function handlePopulateMockRoster(request, env) {
  const ADMIN_PASSCODE = env.ADMIN_PASSCODE || "Warriors-YE8899UE";

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { passcode, grade, squadSize = 17, includeSlug, force = false } = body;

  if (passcode !== ADMIN_PASSCODE) {
    return json({ error: "Invalid passcode" }, 401);
  }
  if (!grade || typeof grade !== "string") {
    return json({ error: "grade is required" }, 400);
  }
  if (!Number.isInteger(squadSize) || squadSize < 1 || squadSize > 161) {
    return json({ error: "squadSize must be an integer between 1 and 161" }, 400);
  }

  // Guard: don't silently stack multiple open mock games for the same grade.
  if (!force) {
    const existing = await env.DB.prepare(
      `SELECT id FROM games WHERE grade = ? AND is_mock = 1 AND status = 'open'`
    ).bind(grade).first();
    if (existing) {
      return json(
        {
          error: "An open mock roster already exists for this grade",
          grade,
          gameId: existing.id,
          hint: "Pass \"force\": true to create a new one alongside it, or clear the existing game first."
        },
        400
      );
    }
  }

  // If a specific player was requested, confirm they exist before we commit anything.
  if (includeSlug) {
    const player = await env.DB.prepare(
      `SELECT slug FROM player_directory WHERE slug = ?`
    ).bind(includeSlug).first();
    if (!player) {
      return json({ error: `No player found in player_directory with slug "${includeSlug}"` }, 400);
    }
  }

  const gameId = uid();

  try {
    // 1. Create the mock game fixture.
    await env.DB.prepare(
      `INSERT INTO games (id, grade, home_team, away_team, game_date_time, status, is_mock)
       VALUES (?, ?, 'Warriors', 'Randomised Mock Opposition', datetime('now'), 'open', 1)`
    ).bind(gameId, grade).run();

    let addedCount = 0;

    // 2. Guarantee the requested player a spot, if provided.
    if (includeSlug) {
      await env.DB.prepare(
        `INSERT INTO players (id, player_hq_id, name, grade, game_id, is_private, active, removed_from_wheel)
         SELECT ?, NULL, full_name, ?, ?, 0, 1, 0
         FROM player_directory WHERE slug = ?`
      ).bind(uid(), grade, gameId, includeSlug).run();
      addedCount += 1;
    }

    // 3. Fill the remaining spots randomly from the directory (excluding the guaranteed player).
    const remaining = squadSize - addedCount;
    if (remaining > 0) {
      const excludeClause = includeSlug ? `WHERE slug != ?` : ``;
      const stmt = includeSlug
        ? env.DB.prepare(
            `INSERT INTO players (id, player_hq_id, name, grade, game_id, is_private, active, removed_from_wheel)
             SELECT lower(hex(randomblob(16))), NULL, full_name, ?, ?, 0, 1, 0
             FROM player_directory ${excludeClause}
             ORDER BY RANDOM() LIMIT ?`
          ).bind(grade, gameId, includeSlug, remaining)
        : env.DB.prepare(
            `INSERT INTO players (id, player_hq_id, name, grade, game_id, is_private, active, removed_from_wheel)
             SELECT lower(hex(randomblob(16))), NULL, full_name, ?, ?, 0, 1, 0
             FROM player_directory
             ORDER BY RANDOM() LIMIT ?`
          ).bind(grade, gameId, remaining);

      const result = await stmt.run();
      addedCount += result.meta.changes;
    }

    const { results: roster } = await env.DB.prepare(
      `SELECT id, name FROM players WHERE game_id = ? ORDER BY name ASC`
    ).bind(gameId).all();

    return json({
      ok: true,
      gameId,
      grade,
      squadSize: roster.length,
      players: roster,
      message: `Mock roster created for ${grade} with ${roster.length} players`
    });
  } catch (err) {
    // Best-effort cleanup so a failed run doesn't leave an orphaned game row.
    await env.DB.prepare(`DELETE FROM players WHERE game_id = ?`).bind(gameId).run().catch(() => {});
    await env.DB.prepare(`DELETE FROM games WHERE id = ?`).bind(gameId).run().catch(() => {});
    return json({ error: "Server error", details: err.message }, 500);
  }
}

/**
 * POST /api/admin/clear-mock-roster
 *
 * Deletes mock game(s) + their squads for a grade, so a fresh mock roster
 * can be generated without tripping the duplicate guard in
 * handlePopulateMockRoster. Only ever touches rows where is_mock = 1 —
 * this will never delete a real PlayHQ-synced game.
 *
 * Body:
 * {
 *   "passcode": "Warriors-YE8899UE",   // required
 *   "grade": "Thirds",                 // required
 *   "gameId": "45f120e8-..."           // optional — clear one specific mock game;
 *                                       // omit to clear ALL open mock games for the grade
 * }
 */
export async function handleClearMockRoster(request, env) {
  const ADMIN_PASSCODE = env.ADMIN_PASSCODE || "Warriors-YE8899UE";

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { passcode, grade, gameId } = body;

  if (passcode !== ADMIN_PASSCODE) {
    return json({ error: "Invalid passcode" }, 401);
  }
  if (!grade || typeof grade !== "string") {
    return json({ error: "grade is required" }, 400);
  }

  try {
    // Figure out which mock game(s) we're about to delete, for the response.
    const gamesQuery = gameId
      ? env.DB.prepare(`SELECT id FROM games WHERE id = ? AND grade = ? AND is_mock = 1`).bind(gameId, grade)
      : env.DB.prepare(`SELECT id FROM games WHERE grade = ? AND is_mock = 1`).bind(grade);

    const { results: targetGames } = await gamesQuery.all();

    if (targetGames.length === 0) {
      return json({
        ok: true,
        grade,
        gamesCleared: 0,
        playersCleared: 0,
        message: "No mock roster found to clear"
      });
    }

    const ids = targetGames.map((g) => g.id);
    const placeholders = ids.map(() => "?").join(",");

    const playersResult = await env.DB.prepare(
      `DELETE FROM players WHERE game_id IN (${placeholders})`
    ).bind(...ids).run();

    const gamesResult = await env.DB.prepare(
      `DELETE FROM games WHERE id IN (${placeholders}) AND is_mock = 1`
    ).bind(...ids).run();

    return json({
      ok: true,
      grade,
      gamesCleared: gamesResult.meta.changes,
      playersCleared: playersResult.meta.changes,
      message: `Cleared ${gamesResult.meta.changes} mock game(s) and ${playersResult.meta.changes} player row(s) for ${grade}`
    });
  } catch (err) {
    return json({ error: "Server error", details: err.message }, 500);
  }
}

/**
 * GET /api/teams/:grade
 *
 * Returns the most recent open mock (or PlayHQ-synced) roster for a grade.
 * Needed so the Teams page / hub can actually display what the button created —
 * this read path does not currently exist live and must ship alongside the button.
 */
export async function handleGetTeams(request, env, grade) {
  const game = await env.DB.prepare(
    `SELECT id, grade, home_team, away_team, game_date_time, status, is_mock, created_at
     FROM games WHERE grade = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(grade).first();

  if (!game) {
    return json({ ok: true, grade, game: null, players: [], message: "No roster found for this grade" });
  }

  const { results: players } = await env.DB.prepare(
    `SELECT id, name FROM players WHERE game_id = ? ORDER BY name ASC`
  ).bind(game.id).all();

  return json({
    ok: true,
    grade,
    game,
    players,
    playerCount: players.length,
    lastUpdated: game.created_at
  });
}
