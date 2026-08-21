var __defProp = Object.defineProperty;
var __name = (target, value) =>
  __defProp(target, "name", { value, configurable: true });

/* =========================================================
   COMMON JSON
========================================================= */

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
__name(json, "json");

/* =========================================================
   MOCK ROSTER
========================================================= */

function uid() {
  return crypto.randomUUID();
}
__name(uid, "uid");

async function handlePopulateMockRoster(request, env) {
  const ADMIN_PASSCODE2 = env.ADMIN_PASSCODE || "94172079";

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const {
    passcode,
    grade,
    squadSize = 22,
    includeSlug,
    force = false
  } = body;

  if (passcode !== ADMIN_PASSCODE2) {
    return json({ error: "Invalid passcode" }, 401);
  }

  if (!grade || typeof grade !== "string") {
    return json({ error: "grade is required" }, 400);
  }

  if (
    !Number.isInteger(squadSize) ||
    squadSize < 1 ||
    squadSize > 161
  ) {
    return json(
      { error: "squadSize must be an integer between 1 and 161" },
      400
    );
  }

  if (!force) {
    const existing = await env.DB.prepare(
      `SELECT id
       FROM games
       WHERE grade = ?
       AND is_mock = 1
       AND status = 'open'`
    )
      .bind(grade)
      .first();

    if (existing) {
      return json(
        {
          error: "An open mock roster already exists for this grade",
          grade,
          gameId: existing.id,
          hint:
            'Pass "force": true to create a new one alongside it, or clear the existing game first.'
        },
        400
      );
    }
  }

  if (includeSlug) {
    const player = await env.DB.prepare(
      `SELECT slug
       FROM player_directory
       WHERE slug = ?`
    )
      .bind(includeSlug)
      .first();

    if (!player) {
      return json(
        {
          error:
            `No player found in player_directory with slug "${includeSlug}"`
        },
        400
      );
    }
  }

  const gameId = uid();

  try {
    const kickoff = new Date(
      Date.now() + 6 * 60 * 60 * 1000
    ).toISOString();

    await env.DB.prepare(
      `INSERT INTO games
       (id, grade, home_team, away_team, game_date_time, status, is_mock)
       VALUES
       (?, ?, 'Warriors', 'Randomised Mock Opposition', ?, 'open', 1)`
    )
      .bind(gameId, grade, kickoff)
      .run();

    let addedCount = 0;

    if (includeSlug) {
      await env.DB.prepare(
        `INSERT INTO players
         (id, player_hq_id, name, grade, game_id,
          is_private, active, removed_from_wheel)
         SELECT
         ?, NULL, full_name, ?, ?, 0, 1, 0
         FROM player_directory
         WHERE slug = ?`
      )
        .bind(uid(), grade, gameId, includeSlug)
        .run();

      addedCount++;
    }

    const remaining = squadSize - addedCount;

    if (remaining > 0) {
      const excludeClause = includeSlug
        ? `WHERE slug != ?`
        : ``;

      const stmt = includeSlug
        ? env.DB.prepare(
            `INSERT INTO players
             (id, player_hq_id, name, grade, game_id,
              is_private, active, removed_from_wheel)
             SELECT
             lower(hex(randomblob(16))),
             NULL,
             full_name,
             ?,
             ?,
             0,
             1,
             0
             FROM player_directory
             ${excludeClause}
             ORDER BY RANDOM()
             LIMIT ?`
          ).bind(
            grade,
            gameId,
            includeSlug,
            remaining
          )
        : env.DB.prepare(
            `INSERT INTO players
             (id, player_hq_id, name, grade, game_id,
              is_private, active, removed_from_wheel)
             SELECT
             lower(hex(randomblob(16))),
             NULL,
             full_name,
             ?,
             ?,
             0,
             1,
             0
             FROM player_directory
             ORDER BY RANDOM()
             LIMIT ?`
          ).bind(
            grade,
            gameId,
            remaining
          );

      const result = await stmt.run();

      addedCount += result.meta.changes;
    }

    const { results: roster } =
      await env.DB.prepare(
        `SELECT id, name
         FROM players
         WHERE game_id = ?
         ORDER BY name ASC`
      )
        .bind(gameId)
        .all();

    return json({
      ok: true,
      gameId,
      grade,
      squadSize: roster.length,
      players: roster,
      message:
        `Mock roster created for ${grade} with ${roster.length} players`
    });
  } catch (err) {
    await env.DB.prepare(
      `DELETE FROM players WHERE game_id = ?`
    )
      .bind(gameId)
      .run()
      .catch(() => {});

    await env.DB.prepare(
      `DELETE FROM games WHERE id = ?`
    )
      .bind(gameId)
      .run()
      .catch(() => {});

    return json(
      {
        error: "Server error",
        details: err.message
      },
      500
    );
  }
}
__name(handlePopulateMockRoster, "handlePopulateMockRoster");

async function handleClearMockRoster(request, env) {
  const ADMIN_PASSCODE2 =
    env.ADMIN_PASSCODE || "94172079";

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { passcode, grade, gameId } = body;

  if (passcode !== ADMIN_PASSCODE2) {
    return json({ error: "Invalid passcode" }, 401);
  }

  if (!grade || typeof grade !== "string") {
    return json({ error: "grade is required" }, 400);
  }

  try {
    const gamesQuery = gameId
      ? env.DB.prepare(
          `SELECT id
           FROM games
           WHERE id = ?
           AND grade = ?
           AND is_mock = 1`
        ).bind(gameId, grade)
      : env.DB.prepare(
          `SELECT id
           FROM games
           WHERE grade = ?
           AND is_mock = 1`
        ).bind(grade);

    const { results: targetGames } =
      await gamesQuery.all();

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
    const placeholders =
      ids.map(() => "?").join(",");

    const playersResult = await env.DB.prepare(
      `DELETE FROM players
       WHERE game_id IN (${placeholders})`
    )
      .bind(...ids)
      .run();

    const gamesResult = await env.DB.prepare(
      `DELETE FROM games
       WHERE id IN (${placeholders})
       AND is_mock = 1`
    )
      .bind(...ids)
      .run();

    return json({
      ok: true,
      grade,
      gamesCleared: gamesResult.meta.changes,
      playersCleared: playersResult.meta.changes,
      message:
        `Cleared ${gamesResult.meta.changes} mock game(s) and ${playersResult.meta.changes} player row(s) for ${grade}`
    });
  } catch (err) {
    return json(
      {
        error: "Server error",
        details: err.message
      },
      500
    );
  }
}
__name(handleClearMockRoster, "handleClearMockRoster");

async function handleGetTeams(request, env, grade) {
  const game = await env.DB.prepare(
    `SELECT
       id,
       grade,
       home_team,
       away_team,
       game_date_time,
       status,
       is_mock,
       created_at
     FROM games
     WHERE grade = ?
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(grade)
    .first();

  if (!game) {
    return json({
      ok: true,
      grade,
      game: null,
      players: [],
      message: "No roster found for this grade"
    });
  }

  const { results: players } =
    await env.DB.prepare(
      `SELECT id, name
       FROM players
       WHERE game_id = ?
       ORDER BY name ASC`
    )
      .bind(game.id)
      .all();

  return json({
    ok: true,
    grade,
    game,
    players,
    playerCount: players.length,
    lastUpdated: game.created_at
  });
}
__name(handleGetTeams, "handleGetTeams");

async function handleAddMember(request, env) {
  const ADMIN_PASSCODE2 =
    env.ADMIN_PASSCODE || "94172079";

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const {
    passcode,
    name,
    grades = []
  } = body;

  if (passcode !== ADMIN_PASSCODE2) {
    return json({ error: "Invalid passcode" }, 401);
  }

  if (
    !name ||
    typeof name !== "string" ||
    !name.trim()
  ) {
    return json({ error: "name is required" }, 400);
  }

  if (!Array.isArray(grades)) {
    return json(
      {
        error:
          "grades must be an array (can be empty for non-playing members)"
      },
      400
    );
  }

  const trimmedName = name.trim();

  const slug = trimmedName
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/'/g, "")
    .replace(/\u2019/g, "");

  const existing = await env.DB.prepare(
    `SELECT slug
     FROM player_directory
     WHERE slug = ?`
  )
    .bind(slug)
    .first();

  if (existing) {
    return json(
      {
        error:
          "A member with this name already exists in the directory"
      },
      409
    );
  }

  let pin = null;

  for (let i = 0; i < 20; i++) {
    const candidate =
      String(
        Math.floor(Math.random() * 10000)
      ).padStart(4, "0");

    if (candidate === "0000") continue;

    const clash = await env.DB.prepare(
      `SELECT slug
       FROM player_directory
       WHERE pin = ?`
    )
      .bind(candidate)
      .first();

    if (!clash) {
      pin = candidate;
      break;
    }
  }

  if (!pin) {
    return json(
      {
        error:
          "Could not allocate a unique PIN — try again"
      },
      500
    );
  }

  try {
    await env.DB.prepare(
      `INSERT INTO player_directory
       (slug, full_name, pin, grades, match_status)
       VALUES (?, ?, ?, ?, 'manual')`
    )
      .bind(
        slug,
        trimmedName,
        pin,
        JSON.stringify(grades)
      )
      .run();
  } catch (err) {
    return json(
      {
        error: "Server error",
        details: err.message
      },
      500
    );
  }

  return json({
    ok: true,
    name: trimmedName,
    slug,
    pin,
    grades,
    message:
      `Added ${trimmedName} to the directory — PIN ${pin}`
  });
}
__name(handleAddMember, "handleAddMember");

/* =========================================================
   PLAYHQ
========================================================= */

const PLAYHQ_BASE =
  "https://api.playhq.com";

const PLAYHQ_ORG_ID =
  "89b6bccc-ad76-4766-8b96-9f1fc00738ec";

const PLAYHQ_TENANT = "afl";

const PLAYHQ_2026_SEASON_ID =
  "5a64561f-1f30-4734-9590-184123cc9403";

async function playHQFetch(path, env) {
  const apiKey =
    env.PLAYHQ_API_KEY ||
    env.PLAYHQ_KEY;

  if (!apiKey) {
    throw new Error(
      "PLAYHQ_API_KEY secret is not configured"
    );
  }

  const response = await fetch(
    PLAYHQ_BASE + path,
    {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "x-phq-tenant": PLAYHQ_TENANT,
        "Accept": "application/json"
      }
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `PlayHQ API ${response.status} for ${path}: ${text.slice(0, 500)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `PlayHQ returned invalid JSON for ${path}`
    );
  }
}
__name(playHQFetch, "playHQFetch");

/* ---------------------------------------------------------
   GET 2026 TEAMS AND FIND COCKBURN LAKES COLTS
--------------------------------------------------------- */

async function handlePlayHQColts(request, env) {
  try {
    const teamsResponse =
      await playHQFetch(
        `/v1/seasons/${PLAYHQ_2026_SEASON_ID}/teams`,
        env
      );

    const allTeams =
      teamsResponse.data || [];

    const matchingTeams =
      allTeams.filter((team) => {
        const clubName =
          team.club?.name || "";

        const gradeName =
          team.grade?.name || "";

        const teamName =
          team.name || "";

        const combined =
          `${clubName} ${gradeName} ${teamName}`
            .toLowerCase();

        return (
          combined.includes("cockburn lakes") &&
          combined.includes("colts")
        );
      });

    return json({
      ok: true,
      organisationId: PLAYHQ_ORG_ID,
      season: {
        id: PLAYHQ_2026_SEASON_ID,
        name: "2026"
      },
      searchedFor: {
        club: "Cockburn Lakes",
        grade: "Colts"
      },
      matchingTeams,
      matchingTeamCount:
        matchingTeams.length,
      totalTeamsReturned:
        allTeams.length
    });
  } catch (err) {
    return json(
      {
        ok: false,
        error: err.message
      },
      500
    );
  }
}
__name(handlePlayHQColts, "handlePlayHQColts");

/* ---------------------------------------------------------
   GET COCKBURN LAKES COLTS FIXTURES
--------------------------------------------------------- */

async function handlePlayHQColtsFixtures(
  request,
  env
) {
  try {
    const teamsResponse =
      await playHQFetch(
        `/v1/seasons/${PLAYHQ_2026_SEASON_ID}/teams`,
        env
      );

    const teams =
      teamsResponse.data || [];

    const team = teams.find((team) => {
      const clubName =
        team.club?.name || "";

      const gradeName =
        team.grade?.name || "";

      const teamName =
        team.name || "";

      const combined =
        `${clubName} ${gradeName} ${teamName}`
          .toLowerCase();

      return (
        combined.includes("cockburn lakes") &&
        combined.includes("colts")
      );
    });

    if (!team) {
      return json(
        {
          ok: false,
          error:
            "Cockburn Lakes Colts team was not found in the 2026 season",
          totalTeamsReturned: teams.length
        },
        404
      );
    }

    const fixtureResponse =
      await playHQFetch(
        `/v1/teams/${team.id}/fixture`,
        env
      );

    return json({
      ok: true,
      team,
      fixtures:
        fixtureResponse.data || [],
      fixtureCount:
        (fixtureResponse.data || []).length
    });
  } catch (err) {
    return json(
      {
        ok: false,
        error: err.message
      },
      500
    );
  }
}
__name(
  handlePlayHQColtsFixtures,
  "handlePlayHQColtsFixtures"
);

/* ---------------------------------------------------------
   GET ONE TEAM'S FIXTURE
--------------------------------------------------------- */

async function handlePlayHQTeamFixtures(
  request,
  env,
  teamId
) {
  try {
    const fixtureResponse =
      await playHQFetch(
        `/v1/teams/${teamId}/fixture`,
        env
      );

    return json({
      ok: true,
      teamId,
      fixtures:
        fixtureResponse.data || [],
      fixtureCount:
        (fixtureResponse.data || []).length
    });
  } catch (err) {
    return json(
      {
        ok: false,
        error: err.message
      },
      500
    );
  }
}
__name(
  handlePlayHQTeamFixtures,
  "handlePlayHQTeamFixtures"
);

/* =========================================================
   MAIN WORKER
========================================================= */

function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/'/g, "")
    .replace(/\u2019/g, "");
}
__name(slugify, "slugify");

function uid2() {
  return crypto.randomUUID();
}
__name(uid2, "uid");

var ADMIN_PASSCODE = "94172079";

var WEB3FORMS_ACCESS_KEY =
  "a59f79b9-cb63-4cc8-ab40-7465fd609f14";

async function notifyAdminOfPinRequest(name) {
  try {
    await fetch(
      "https://api.web3forms.com/submit",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          access_key:
            WEB3FORMS_ACCESS_KEY,
          subject:
            `PIN request — ${name}`,
          from_name:
            "Warriors Hub PIN Requests",
          message:
            `${name} has requested their PIN.

Open the hub, tap ADMIN in the bottom-right corner, and approve or deny once you've confirmed it's really them. Approving shows you their PIN to pass on yourself — nothing is emailed automatically.`
        })
      }
    );
  } catch (e) {
    console.error(
      "Failed to notify admin of PIN request:",
      e
    );
  }
}
__name(
  notifyAdminOfPinRequest,
  "notifyAdminOfPinRequest"
);

async function getPinRequestIndex(env) {
  const raw =
    await env.VOTES_KV.get(
      "pinrequest_index"
    );

  return raw
    ? JSON.parse(raw)
    : [];
}
__name(
  getPinRequestIndex,
  "getPinRequestIndex"
);

async function addToPinRequestIndex(
  env,
  requestId
) {
  const index =
    await getPinRequestIndex(env);

  index.unshift(requestId);

  await env.VOTES_KV.put(
    "pinrequest_index",
    JSON.stringify(
      index.slice(0, 200)
    )
  );
}
__name(
  addToPinRequestIndex,
  "addToPinRequestIndex"
);

var worker_default = {
  async fetch(request, env) {
    const url =
      new URL(request.url);

    /* OPTIONS */

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization",
          "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS"
        }
      });
    }

    /* =====================================================
       PLAYHQ ROUTES
    ===================================================== */

    if (
      url.pathname ===
        "/api/playhq/colts" &&
      request.method === "GET"
    ) {
      return handlePlayHQColts(
        request,
        env
      );
    }

    if (
      url.pathname ===
        "/api/playhq/colts/fixtures" &&
      request.method === "GET"
    ) {
      return handlePlayHQColtsFixtures(
        request,
        env
      );
    }

    const playHQTeamMatch =
      url.pathname.match(
        /^\/api\/playhq\/teams\/([^/]+)\/fixtures$/
      );

    if (
      playHQTeamMatch &&
      request.method === "GET"
    ) {
      return handlePlayHQTeamFixtures(
        request,
        env,
        decodeURIComponent(
          playHQTeamMatch[1]
        )
      );
    }

    /* =====================================================
       NOTICE STORE
    ===================================================== */

    if (
      url.pathname ===
      "/api/store"
    ) {
      const key =
        url.searchParams.get("key");

      if (!key) {
        return json(
          { error: "Missing key" },
          400
        );
      }

      if (
        request.method === "GET"
      ) {
        const value =
          await env.NOTICE_KV.get(key);

        return new Response(
          value ?? "null",
          {
            headers: {
              "content-type":
                "application/json",
              "cache-control":
                "no-store",
              "Access-Control-Allow-Origin":
                "*"
            }
          }
        );
      }

      if (
        request.method === "POST"
      ) {
        const body =
          await request.text();

        try {
          JSON.parse(body);
        } catch {
          return json(
            {
              error:
                "Body must be valid JSON"
            },
            400
          );
        }

        await env.NOTICE_KV.put(
          key,
          body
        );

        return json({
          ok: true
        });
      }

      return new Response(
        "Method not allowed",
        { status: 405 }
      );
    }

    /* =====================================================
       DELETE NOTICE
    ===================================================== */

    if (
      url.pathname ===
        "/api/admin/delete-notice" &&
      request.method === "POST"
    ) {
      const body =
        await request
          .json()
          .catch(() => ({}));

      if (
        body.passcode !==
        ADMIN_PASSCODE
      ) {
        return json(
          {
            error:
              "Invalid passcode"
          },
          401
        );
      }

      const {
        key,
        ts
      } = body;

      if (!key || !ts) {
        return json(
          {
            error:
              "Missing key or ts"
          },
          400
        );
      }

      const raw =
        await env.NOTICE_KV.get(key);

      const list =
        raw
          ? JSON.parse(raw)
          : [];

      const filtered =
        list.filter(
          (n) => n.ts !== ts
        );

      await env.NOTICE_KV.put(
        key,
        JSON.stringify(filtered)
      );

      return json({
        ok: true
      });
    }

    /* =====================================================
       POST NOTICE
    ===================================================== */

    if (
      url.pathname ===
        "/api/notice/post" &&
      request.method === "POST"
    ) {
      const body =
        await request
          .json()
          .catch(() => null);

      if (!body) {
        return json(
          {
            error:
              "Invalid request"
          },
          400
        );
      }

      const {
        pin,
        noticeKey
      } = body;

      if (
        !pin ||
        !/^\d{4}$/.test(pin)
      ) {
        return json(
          {
            error:
              "Enter your 4-digit PIN"
          },
          400
        );
      }

      if (
        !noticeKey ||
        typeof noticeKey !==
          "string"
      ) {
        return json(
          {
            error:
              "Missing noticeKey"
          },
          400
        );
      }

      const slug =
        await env.VOTES_KV.get(
          `pinused:${pin}`
        );

      if (!slug) {
        return json(
          {
            error:
              "PIN not recognised"
          },
          401
        );
      }

      const name =
        await env.VOTES_KV.get(
          `name:${slug}`
        ) || slug;

      const raw =
        await env.NOTICE_KV.get(
          noticeKey
        );

      const list =
        raw
          ? JSON.parse(raw)
          : [];

      list.push({
        name,
        ts: Date.now()
      });

      await env.NOTICE_KV.put(
        noticeKey,
        JSON.stringify(list)
      );

      return json({
        ok: true,
        name
      });
    }

    /* =====================================================
       CHANGE PIN
    ===================================================== */

    if (
      url.pathname ===
        "/api/change-pin" &&
      request.method === "POST"
    ) {
      const body =
        await request
          .json()
          .catch(() => null);

      if (!body) {
        return json(
          {
            error:
              "Invalid request"
          },
          400
        );
      }

      const {
        oldPin,
        newPin
      } = body;

      if (!oldPin || !newPin) {
        return json(
          {
            error:
              "Both PINs are required"
          },
          400
        );
      }

      if (
        !/^\d{4}$/.test(newPin)
      ) {
        return json(
          {
            error:
              "New PIN must be 4 digits"
          },
          400
        );
      }

      if (
        newPin === oldPin
      ) {
        return json(
          {
            error:
              "New PIN must be different from your current PIN"
          },
          400
        );
      }

      if (
        newPin === "0000"
      ) {
        return json(
          {
            error:
              "0000 is reserved for testing and can't be used as a personal PIN"
          },
          400
        );
      }

      const voterSlug =
        await env.VOTES_KV.get(
          `pinused:${oldPin}`
        );

      if (!voterSlug) {
        return json(
          {
            error:
              "Current PIN not recognised. Note: the shared 0000 testing PIN can't be changed here."
          },
          401
        );
      }

      const clash =
        await env.VOTES_KV.get(
          `pinused:${newPin}`
        );

      if (
        clash &&
        clash !== voterSlug
      ) {
        return json(
          {
            error:
              "That PIN is already in use by someone else — try a different one"
          },
          409
        );
      }

      await env.VOTES_KV.delete(
        `pinused:${oldPin}`
      );

      await env.VOTES_KV.put(
        `pin:${voterSlug}`,
        newPin
      );

      await env.VOTES_KV.put(
        `pinused:${newPin}`,
        voterSlug
      );

      return json({
        success: true
      });
    }

    /* =====================================================
       PIN REQUEST
    ===================================================== */

    if (
      url.pathname ===
        "/api/pin-request" &&
      request.method === "POST"
    ) {
      const body =
        await request
          .json()
          .catch(() => null);

      if (!body) {
        return json(
          {
            error:
              "Invalid request"
          },
          400
        );
      }

      const name =
        (body.name || "")
          .trim();

      if (!name) {
        return json(
          {
            error:
              "Name is required"
          },
          400
        );
      }

      const slug =
        slugify(name);

      const storedName =
        await env.VOTES_KV.get(
          `name:${slug}`
        );

      if (
        !storedName ||
        storedName
          .trim()
          .toLowerCase() !==
          name.toLowerCase()
      ) {
        return json(
          {
            error:
              "We couldn't match that name exactly. Check the spelling (as registered with the club) and try again, or contact the club admin directly."
          },
          404
        );
      }

      const existing =
        await getPinRequestIndex(
          env
        );

      for (const id of existing) {
        const raw =
          await env.VOTES_KV.get(
            `pinrequest:${id}`
          );

        if (!raw) continue;

        const existingReq =
          JSON.parse(raw);

        if (
          existingReq.slug ===
            slug &&
          existingReq.status ===
            "pending"
        ) {
          return json({
            ok: true,
            message:
              "You already have a pending request — the club admin will review it soon."
          });
        }
      }

      const requestId =
        uid2();

      const reqObj = {
        id: requestId,
        slug,
        name: storedName,
        status: "pending",
        createdAt:
          new Date().toISOString()
      };

      await env.VOTES_KV.put(
        `pinrequest:${requestId}`,
        JSON.stringify(reqObj)
      );

      await addToPinRequestIndex(
        env,
        requestId
      );

      await notifyAdminOfPinRequest(
        storedName
      );

      return json({
        ok: true,
        message:
          "Request sent! The club admin will verify it's really you before sending your PIN."
      });
    }

    /* =====================================================
       MOCK ROSTER
    ===================================================== */

    if (
      url.pathname ===
        "/api/admin/populate-mock-roster" &&
      request.method === "POST"
    ) {
      return handlePopulateMockRoster(
        request,
        env
      );
    }

    const teamsMatch =
      url.pathname.match(
        /^\/api\/teams\/([a-zA-Z0-9-]+)$/
      );

    if (
      teamsMatch &&
      request.method === "GET"
    ) {
      return handleGetTeams(
        request,
        env,
        decodeURIComponent(
          teamsMatch[1]
        )
      );
    }

    if (
      url.pathname ===
        "/api/admin/clear-mock-roster" &&
      request.method === "POST"
    ) {
      return handleClearMockRoster(
        request,
        env
      );
    }

    if (
      url.pathname ===
        "/api/admin/add-member" &&
      request.method === "POST"
    ) {
      return handleAddMember(
        request,
        env
      );
    }

    /* =====================================================
       PIN ADMIN
    ===================================================== */

    if (
      url.pathname ===
        "/api/admin/pin-requests" &&
      request.method === "POST"
    ) {
      const body =
        await request
          .json()
          .catch(() => ({}));

      if (
        body.passcode !==
        ADMIN_PASSCODE
      ) {
        return json(
          {
            error:
              "Invalid passcode"
          },
          401
        );
      }

      const index =
        await getPinRequestIndex(
          env
        );

      const requests = [];

      for (const id of index) {
        const raw =
          await env.VOTES_KV.get(
            `pinrequest:${id}`
          );

        if (raw) {
          requests.push(
            JSON.parse(raw)
          );
        }
      }

      requests.sort(
        (a, b) =>
          new Date(b.createdAt) -
          new Date(a.createdAt)
      );

      return json({
        requests
      });
    }

    if (
      url.pathname ===
        "/api/admin/approve-pin-request" &&
      request.method === "POST"
    ) {
      const body =
        await request
          .json()
          .catch(() => ({}));

      if (
        body.passcode !==
        ADMIN_PASSCODE
      ) {
        return json(
          {
            error:
              "Invalid passcode"
          },
          401
        );
      }

      const {
        requestId
      } = body;

      if (!requestId) {
        return json(
          {
            error:
              "Missing requestId"
          },
          400
        );
      }

      const raw =
        await env.VOTES_KV.get(
          `pinrequest:${requestId}`
        );

      if (!raw) {
        return json(
          {
            error:
              "Request not found"
          },
          404
        );
      }

      const reqObj =
        JSON.parse(raw);

      if (
        reqObj.status !==
        "pending"
      ) {
        return json(
          {
            error:
              "Request already resolved"
          },
          400
        );
      }

      const pin =
        await env.VOTES_KV.get(
          `pin:${reqObj.slug}`
        );

      if (!pin) {
        return json(
          {
            error:
              "No PIN on file for this player — they may need one generated first"
          },
          404
        );
      }

      reqObj.status =
        "approved";

      reqObj.resolvedAt =
        new Date().toISOString();

      await env.VOTES_KV.put(
        `pinrequest:${requestId}`,
        JSON.stringify(reqObj)
      );

      return json({
        ok: true,
        pin
      });
    }

    if (
      url.pathname ===
        "/api/admin/deny-pin-request" &&
      request.method === "POST"
    ) {
      const body =
        await request
          .json()
          .catch(() => ({}));

      if (
        body.passcode !==
        ADMIN_PASSCODE
      ) {
        return json(
          {
            error:
              "Invalid passcode"
          },
          401
        );
      }

      const {
        requestId
      } = body;

      if (!requestId) {
        return json(
          {
            error:
              "Missing requestId"
          },
          400
        );
      }

      const raw =
        await env.VOTES_KV.get(
          `pinrequest:${requestId}`
        );

      if (!raw) {
        return json(
          {
            error:
              "Request not found"
          },
          404
        );
      }

      const reqObj =
        JSON.parse(raw);

      reqObj.status =
        "denied";

      reqObj.resolvedAt =
        new Date().toISOString();

      await env.VOTES_KV.put(
        `pinrequest:${requestId}`,
        JSON.stringify(reqObj)
      );

      return json({
        ok: true
      });
    }

    /* =====================================================
       FRONTEND
    ===================================================== */

    return env.ASSETS.fetch(
      request
    );
  }
};

export {
  worker_default as default
};
