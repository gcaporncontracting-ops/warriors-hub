const PLAYHQ_LIVE_ENDPOINT = "https://playhq-game-players.clfchub.workers.dev";
const ADMIN_PASSCODE = "94172079";
const EXCLUDED_PLAYERS = ["heath thorpe", "ryan austin", "coach", "trainer"];

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

async function syncPlayersFromLive(env, gameId, grade) {
  try {
    const url = `${PLAYHQ_LIVE_ENDPOINT}/?gameId=${gameId}&team=cockburn`;
    const res = await fetch(url);
    if (!res.ok) {
      return { ok: false, error: `PlayHQ error: ${res.status}`, syncedCount: 0 };
    }

    const gameData = await res.json();
    const cockburnPlayers = gameData.teams?.["Cockburn Lakes (B)"] || [];

    if (!cockburnPlayers.length) {
      return { ok: false, error: "No players found", syncedCount: 0 };
    }

    let game = await env.DB.prepare(`SELECT id FROM games WHERE id = ?`).bind(gameId).first();

    if (!game) {
      await env.DB.prepare(`INSERT INTO games (id, grade, status, player_hq_game_id, sync_status) VALUES (?, ?, ?, ?, ?)`).bind(gameId, grade, "open", gameId, "synced").run();
    }

    let syncedCount = 0;
    for (const player of cockburnPlayers) {
      const playerName = `${player.firstName} ${player.lastName}`.trim();
      const isExcluded = EXCLUDED_PLAYERS.some(ex => playerName.toLowerCase().includes(ex.toLowerCase()));
      if (isExcluded) continue;

      const isCaptain = player.captainRole === "CAPTAIN" ? 1 : 0;
      const playerNumber = player.playerNumber ? parseInt(player.playerNumber) : null;

      await env.DB.prepare(`INSERT OR REPLACE INTO players (id, player_hq_id, name, grade, game_id, is_private, active, removed_from_wheel, player_number, player_position, is_captain, is_fill_in, is_emergency, synced_from_playhq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        player.id, player.id, playerName, grade, gameId, 0, 1, 0, playerNumber, player.playerPosition || null, isCaptain, player.isFillIn ? 1 : 0, player.isEmergency ? 1 : 0, 1
      ).run();
      syncedCount++;
    }

    return { ok: true, syncedCount, gameId, grade };
  } catch (error) {
    return { ok: false, error: error.message, syncedCount: 0 };
  }
}

async function getPlayersForGame(env, gameId) {
  try {
    const { results } = await env.DB.prepare(`SELECT id, name, player_number, player_position, is_captain, is_fill_in, is_emergency FROM players WHERE game_id = ? AND active = 1 ORDER BY name`).bind(gameId).all();
    return results || [];
  } catch (error) {
    return [];
  }
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === "OPTIONS") {
    return json({});
  }

  if (pathname === "/health") {
    try {
      await env.DB.prepare("SELECT 1").first();
      return json({ status: "ok", database: "connected" });
    } catch (err) {
      return json({ status: "error", database: "disconnected" }, 503);
    }
  }

  if (pathname === "/api/admin/sync-game" && request.method === "POST") {
    try {
      const body = await request.json();
      const { gameId, grade, adminPasscode } = body;

      if (!gameId || !grade || !adminPasscode) {
        return json({ error: "Missing required fields" }, 400);
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

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};
