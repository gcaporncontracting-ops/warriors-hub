// worker.js
// Minimal API for the hub's Notice Board (currently just "can't make
// training" name submissions). Same pattern as the fines wall's
// /api/store — a generic get/set against KV, keyed by a fixed key.
// Static files (html/css/js/images) are served automatically via the
// ASSETS binding for everything else.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/store') {
      const key = url.searchParams.get('key');

      if (!key) {
        return new Response(JSON.stringify({ error: 'Missing key' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (request.method === 'GET') {
        const value = await env.NOTICE_KV.get(key);
        return new Response(value ?? 'null', {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
      }

      if (request.method === 'POST') {
        const body = await request.text();
        try {
          JSON.parse(body);
        } catch {
          return new Response(JSON.stringify({ error: 'Body must be valid JSON' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        await env.NOTICE_KV.put(key, body);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('Method not allowed', { status: 405 });
    }

    // Everything else falls through to the static site (index.html etc.)
    return env.ASSETS.fetch(request);
  },
};
