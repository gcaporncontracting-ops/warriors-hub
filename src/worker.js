/**
 * Warriors Hub + CLFC First Goal Scorer Integration
 * Full Cloudflare Worker with D1 database and PlayHQ sync
 */

const PLAYHQ_LIVE_ENDPOINT = "https://playhq-game-players.clfchub.workers.dev";
const ADMIN_PASSCODE = "94172079";
const EXCLUDED_PLAYERS = ["heath thorpe", "ryan austin", "coach", "trainer"];

// ============================================================================
// CORS & JSON HELPERS
// ============================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    }
  });
}

// ============================================================================
// FGS PLAYHQ SYNC FUNCTIONS
// ============================================================================

async function syncPlayersFromLive(env, gameId, grade) {
  try {
    const url = `${PLAYHQ_LIVE_ENDPOINT}/?gameId=${gameId}&team=cockburn`;
    console.log(`Fetching: ${url}`);
    
    const res = await fetch(url);
    if (!res.ok) {
      return {
        ok: false,
        error: `PlayHQ endpoint error: ${res.status}`,
        syncedCount: 0
      };
    }

    const gameData = await res.json();
    const cockburnPlayers = gameData.teams?.["Cockburn Lakes (B)"] || [];

    if (!cockburnPlayers.length) {
      return {
        ok: false,
        error: "No Cockburn Lakes players found",
        syncedCount: 0
      };
    }

    console.log(`Found ${cockburnPlayers.length} Cockburn players`);

    // Get or create game record
    let game = await env.DB.prepare(
      `SELECT id FROM games WHERE id = ?`
    ).bind(gameId).first();

    if (!game) {
      await env.DB.prepare(`
        INSERT INTO games (id, grade, status, player_hq_game_id, sync_status)
        VALUES (?, ?, ?, ?, ?)
      `).bind(gameId, grade, "open", gameId, "synced").run();
    } else {
      await env.DB.prepare(`
        UPDATE games 
        SET sync_status = 'synced', synced_at = datetime('now')
        WHERE id = ?
      `).bind(gameId).run();
    }

    // Insert/update players
    let syncedCount = 0;
    for (const player of cockburnPlayers) {
      const playerName = `${player.firstName} ${player.lastName}`.trim();
      
      const isExcluded = EXCLUDED_PLAYERS.some(ex => 
        playerName.toLowerCase().includes(ex.toLowerCase())
      );
      if (isExcluded) {
        console.log(`Skipping excluded: ${playerName}`);
        continue;
      }

      const isCaptain = player.captainRole === "CAPTAIN" ? 1 : 0;
      const playerNumber = player.playerNumber ? parseInt(player.playerNumber) : null;

      try {
        await env.DB.prepare(`
          INSERT OR REPLACE INTO players (
            id, player_hq_id, name, grade, game_id, is_private, active,
            removed_from_wheel, player_number, player_position,
            is_captain, is_fill_in, is_emergency, synced_from_playhq
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          player.id, player.id, playerName, grade, gameId, 0, 1, 0,
          playerNumber, player.playerPosition || null,
          isCaptain, player.isFillIn ? 1 : 0,
          player.isEmergency ? 1 : 0, 1
        ).run();
        
        syncedCount++;
      } catch (err) {
        console.error(`Failed to insert ${playerName}:`, err);
      }
    }

    // Log sync
    await env.DB.prepare(`
      INSERT INTO playhq_sync_log (
        game_id, player_hq_game_id, sync_type, status, players_synced
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(gameId, gameId, "manual", "success", syncedCount).run();

    return {
      ok: true,
      message: `Synced ${syncedCount} players`,
      gameId, grade, syncedCount,
      players: cockburnPlayers.slice(0, 5).map(p => ({
        name: `${p.firstName} ${p.lastName}`,
        number: p.playerNumber,
        captain: p.captainRole === "CAPTAIN"
      }))
    };

  } catch (error) {
    console.error("Sync error:", error);
    await env.DB.prepare(`
      INSERT INTO playhq_sync_log (game_id, sync_type, status, error_message)
      VALUES (?, ?, ?, ?)
    `).bind(gameId, "manual", "failed", error.message).run();

    return { ok: false, error: error.message, syncedCount: 0 };
  }
}

async function getPlayersForGame(env, gameId) {
  try {
    const { results } = await env.DB.prepare(`
      SELECT id, name, player_number, player_position,
             is_captain, is_fill_in, is_emergency, player_hq_id
      FROM players
      WHERE game_id = ? AND removed_from_wheel = 0 AND active = 1
      ORDER BY name
    `).bind(gameId).all();
    return results || [];
  } catch (error) {
    console.error("Get players error:", error);
    return [];
  }
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // OPTIONS for CORS
  if (request.method === "OPTIONS") {
    return json({});
  }

  // ========== HEALTH CHECK ==========
  if (pathname === "/health") {
    try {
      const test = await env.DB.prepare("SELECT 1").first();
      return json({ status: "ok", database: "connected" });
    } catch (err) {
      return json({ status: "error", database: "disconnected" }, 503);
    }
  }

  // ========== FGS SYNC ENDPOINT ==========
  if (pathname === "/api/admin/sync-game" && request.method === "POST") {
    try {
      const body = await request.json();
      const { gameId, grade, adminPasscode } = body;

      if (!gameId || !grade || !adminPasscode) {
        return json({ error: "Missing gameId, grade, or adminPasscode" }, 400);
      }

      if (adminPasscode !== ADMIN_PASSCODE) {
        return json({ error: "Invalid passcode" }, 401);
      }

      const result = await syncPlayersFromLive(env, gameId, grade);
      return json(result, result.ok ? 200 : 400);

    } catch (error) {
      return json({ error: error.message }, 500);
    }
  }

  // ========== GET PLAYERS FOR GAME ==========
  if (pathname.startsWith("/api/games/") && request.method === "GET") {
    try {
      const gameId = pathname.split("/")[3];
      if (!gameId) {
        return json({ error: "Game ID required" }, 400);
      }

      const players = await getPlayersForGame(env, gameId);
      return json({ gameId, count: players.length, players });

    } catch (error) {
      return json({ error: error.message }, 500);
    }
  }

  // ========== SYNC STATUS ==========
  if (pathname === "/api/admin/sync-status" && request.method === "GET") {
    try {
      const gameId = url.searchParams.get("gameId");
      const adminPasscode = url.searchParams.get("adminPasscode");

      if (!gameId || adminPasscode !== ADMIN_PASSCODE) {
        return json({ error: "Invalid request" }, 401);
      }

      const game = await env.DB.prepare(
        `SELECT id, sync_status, synced_at FROM games WHERE id = ?`
      ).bind(gameId).first();

      const players = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM players WHERE game_id = ? AND active = 1`
      ).bind(gameId).first();

      const logs = await env.DB.prepare(
        `SELECT * FROM playhq_sync_log WHERE game_id = ? ORDER BY created_at DESC LIMIT 5`
      ).bind(gameId).all();

      return json({
        gameId,
        syncStatus: game?.sync_status || "pending",
        lastSyncedAt: game?.synced_at,
        playerCount: players?.count || 0,
        recentLogs: logs?.results || []
      });

    } catch (error) {
      return json({ error: error.message }, 500);
    }
  }

  // ========== 404 ==========
  return json({ error: "Not found" }, 404);
}

// ============================================================================
// EXPORT
// ============================================================================

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};
