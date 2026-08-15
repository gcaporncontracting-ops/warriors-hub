function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
function slugify(name) {
  return name.trim().toLowerCase().replace(/\s+/g, "-").replace(/'/g, "").replace(/\u2019/g, "");
}
function uid() {
  return crypto.randomUUID();
}
var ADMIN_PASSCODE = "Warriors-Kick-9247";
var WEB3FORMS_ACCESS_KEY = "a59f79b9-cb63-4cc8-ab40-7465fd609f14";
async function notifyAdminOfPinRequest(name) {
  try {
    await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        access_key: WEB3FORMS_ACCESS_KEY,
        subject: `PIN request \u2014 ${name}`,
        from_name: "Warriors Hub PIN Requests",
        message: `${name} has requested their PIN.

Open the hub, tap ADMIN in the bottom-right corner, and approve or deny once you've confirmed it's really them. Approving shows you their PIN to pass on yourself \u2014 nothing is emailed automatically.`
      })
    });
  } catch (e) {
    console.error("Failed to notify admin of PIN request:", e);
  }
}
async function getPinRequestIndex(env) {
  const raw = await env.VOTES_KV.get("pinrequest_index");
  return raw ? JSON.parse(raw) : [];
}
async function addToPinRequestIndex(env, requestId) {
  const index = await getPinRequestIndex(env);
  index.unshift(requestId);
  await env.VOTES_KV.put("pinrequest_index", JSON.stringify(index.slice(0, 200)));
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/store") {
      const key = url.searchParams.get("key");
      if (!key) {
        return new Response(JSON.stringify({ error: "Missing key" }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }
      if (request.method === "GET") {
        const value = await env.NOTICE_KV.get(key);
        return new Response(value ?? "null", {
          headers: { "content-type": "application/json", "cache-control": "no-store" }
        });
      }
      if (request.method === "POST") {
        const body = await request.text();
        try {
          JSON.parse(body);
        } catch {
          return new Response(JSON.stringify({ error: "Body must be valid JSON" }), {
            status: 400,
            headers: { "content-type": "application/json" }
          });
        }
        await env.NOTICE_KV.put(key, body);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/api/admin/delete-notice" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (body.passcode !== ADMIN_PASSCODE) return json({ error: "Invalid passcode" }, 401);
      const { key, ts } = body;
      if (!key || !ts) return json({ error: "Missing key or ts" }, 400);
      const raw = await env.NOTICE_KV.get(key);
      const list = raw ? JSON.parse(raw) : [];
      const filtered = list.filter((n) => n.ts !== ts);
      await env.NOTICE_KV.put(key, JSON.stringify(filtered));
      return json({ ok: true });
    }
    if (url.pathname === "/api/notice/post" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: "Invalid request" }, 400);
      const { pin, noticeKey } = body;
      if (!pin || !/^\d{4}$/.test(pin)) return json({ error: "Enter your 4-digit PIN" }, 400);
      if (!noticeKey || typeof noticeKey !== "string") return json({ error: "Missing noticeKey" }, 400);
      const slug = await env.VOTES_KV.get(`pinused:${pin}`);
      if (!slug) return json({ error: "PIN not recognised" }, 401);
      const name = await env.VOTES_KV.get(`name:${slug}`) || slug;
      const raw = await env.NOTICE_KV.get(noticeKey);
      const list = raw ? JSON.parse(raw) : [];
      list.push({ name, ts: Date.now() });
      await env.NOTICE_KV.put(noticeKey, JSON.stringify(list));
      return json({ ok: true, name });
    }
    if (url.pathname === "/api/change-pin" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: "Invalid request" }, 400);
      const { oldPin, newPin } = body;
      if (!oldPin || !newPin) return json({ error: "Both PINs are required" }, 400);
      if (!/^\d{4}$/.test(newPin)) return json({ error: "New PIN must be 4 digits" }, 400);
      if (newPin === oldPin) return json({ error: "New PIN must be different from your current PIN" }, 400);
      if (newPin === "0000") return json({ error: "0000 is reserved for testing and can't be used as a personal PIN" }, 400);
      const voterSlug = await env.VOTES_KV.get(`pinused:${oldPin}`);
      if (!voterSlug) return json({ error: "Current PIN not recognised. Note: the shared 0000 testing PIN can't be changed here." }, 401);
      const clash = await env.VOTES_KV.get(`pinused:${newPin}`);
      if (clash && clash !== voterSlug) {
        return json({ error: "That PIN is already in use by someone else \u2014 try a different one" }, 409);
      }
      await env.VOTES_KV.delete(`pinused:${oldPin}`);
      await env.VOTES_KV.put(`pin:${voterSlug}`, newPin);
      await env.VOTES_KV.put(`pinused:${newPin}`, voterSlug);
      return json({ success: true });
    }
    if (url.pathname === "/api/pin-request" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: "Invalid request" }, 400);
      const name = (body.name || "").trim();
      if (!name) return json({ error: "Name is required" }, 400);
      const slug = slugify(name);
      const storedName = await env.VOTES_KV.get(`name:${slug}`);
      if (!storedName || storedName.trim().toLowerCase() !== name.toLowerCase()) {
        return json({ error: "We couldn't match that name exactly. Check the spelling (as registered with the club) and try again, or contact the club admin directly." }, 404);
      }
      const existing = await getPinRequestIndex(env);
      for (const id of existing) {
        const raw = await env.VOTES_KV.get(`pinrequest:${id}`);
        if (!raw) continue;
        const existingReq = JSON.parse(raw);
        if (existingReq.slug === slug && existingReq.status === "pending") {
          return json({ ok: true, message: "You already have a pending request \u2014 the club admin will review it soon." });
        }
      }
      const requestId = uid();
      const reqObj = { id: requestId, slug, name: storedName, status: "pending", createdAt: (/* @__PURE__ */ new Date()).toISOString() };
      await env.VOTES_KV.put(`pinrequest:${requestId}`, JSON.stringify(reqObj));
      await addToPinRequestIndex(env, requestId);
      await notifyAdminOfPinRequest(storedName);
      return json({ ok: true, message: "Request sent! The club admin will verify it's really you before sending your PIN." });
    }
    if (url.pathname === "/api/admin/pin-requests" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (body.passcode !== ADMIN_PASSCODE) return json({ error: "Invalid passcode" }, 401);
      const index = await getPinRequestIndex(env);
      const requests = [];
      for (const id of index) {
        const raw = await env.VOTES_KV.get(`pinrequest:${id}`);
        if (raw) requests.push(JSON.parse(raw));
      }
      requests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return json({ requests });
    }
    if (url.pathname === "/api/admin/approve-pin-request" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (body.passcode !== ADMIN_PASSCODE) return json({ error: "Invalid passcode" }, 401);
      const { requestId } = body;
      if (!requestId) return json({ error: "Missing requestId" }, 400);
      const raw = await env.VOTES_KV.get(`pinrequest:${requestId}`);
      if (!raw) return json({ error: "Request not found" }, 404);
      const reqObj = JSON.parse(raw);
      if (reqObj.status !== "pending") return json({ error: "Request already resolved" }, 400);
      const pin = await env.VOTES_KV.get(`pin:${reqObj.slug}`);
      if (!pin) return json({ error: "No PIN on file for this player \u2014 they may need one generated first" }, 404);
      reqObj.status = "approved";
      reqObj.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
      await env.VOTES_KV.put(`pinrequest:${requestId}`, JSON.stringify(reqObj));
      return json({ ok: true, pin });
    }
    if (url.pathname === "/api/admin/deny-pin-request" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (body.passcode !== ADMIN_PASSCODE) return json({ error: "Invalid passcode" }, 401);
      const { requestId } = body;
      if (!requestId) return json({ error: "Missing requestId" }, 400);
      const raw = await env.VOTES_KV.get(`pinrequest:${requestId}`);
      if (!raw) return json({ error: "Request not found" }, 404);
      const reqObj = JSON.parse(raw);
      reqObj.status = "denied";
      reqObj.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
      await env.VOTES_KV.put(`pinrequest:${requestId}`, JSON.stringify(reqObj));
      return json({ ok: true });
    }
    return env.ASSETS.fetch(request);
  }
};
